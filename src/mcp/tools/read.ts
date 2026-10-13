import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlow,
  ListResponse,
  SearchObject,
} from "imapflow";
import { z } from "zod";
import { normalizeError, ToolError } from "../../lib/errors";
import {
  downloadText,
  FETCH_MAX,
  locked,
  pagedSearch,
  withImap,
  withMailbox,
  withSpecialUse,
  type DownloadedText,
} from "../../lib/imap";
import {
  BODY_LIMIT,
  type BodyPart,
  formatAddresses,
  htmlToText,
  listAttachments,
  parseHeaderBlock,
  selectBodyParts,
  splitMessageIds,
  stripElements,
  toIsoDate,
  truncateText,
} from "../../lib/mime";
import { READ_ONLY, runTool, type ToolDeps } from "../tool";

/** Hard ceiling on messages returned by one call; Yahoo also caps fetch ranges at 1000. */
const PAGE_MAX = 50;
/** Paging deeper than this would mean scanning most of the folder on every call. */
const OFFSET_MAX = 2000;
/** search_messages takes at most this many folders per call; each is one SELECT on the same connection. */
const FOLDERS_MAX = 10;
/** top_senders aggregates at most this many of the newest matching messages: two Yahoo fetch batches. */
const TOP_SENDERS_SCAN = 2000;
const TOP_SENDERS_MAX = 100;
/** Yahoo's spam classifier marks. They say nothing about the user's intent, so they never reach a client. */
const YAHOO_CLASSIFIER_FLAGS = new Set(["$Junk", "$NotJunk"]);
/** Reported as the `unread` and `flagged` booleans rather than repeated in `flags`. */
const BOOLEAN_FLAGS = new Set(["\\Seen", "\\Flagged"]);
/** get_thread with include_bodies downloads at most this many bodies, each capped at THREAD_BODY_LIMIT. */
const THREAD_BODY_MAX = 20;
const THREAD_BODY_LIMIT = 20_000;

const SUMMARY_QUERY = {
  uid: true,
  envelope: true,
  flags: true,
  size: true,
  bodyStructure: true,
} as const;
/** What top_senders needs per message: no BODYSTRUCTURE, so 2000 rows stay small. */
const ENVELOPE_QUERY = { uid: true, envelope: true, flags: true } as const;
const THREAD_HEADERS = ["message-id", "in-reply-to", "references"];

export interface MessageSummary {
  uid: number;
  folder: string;
  from: string[];
  to: string[];
  /** Omitted when empty. */
  cc?: string[];
  subject: string | null;
  date: string | null;
  /** IMAP flags beyond read and starred state (`\Answered`, `\Draft`, ...); omitted when empty. */
  flags?: string[];
  unread: boolean;
  flagged: boolean;
  has_attachments: boolean;
  size: number | null;
}

/** The filters search_messages and top_senders share, as a zod raw shape. */
const SEARCH_FILTERS = {
  query: z
    .string()
    .min(1)
    .optional()
    .describe("Free text matched against headers and body"),
  from: z
    .string()
    .min(1)
    .optional()
    .describe("Substring of the From address or name"),
  to: z
    .string()
    .min(1)
    .optional()
    .describe("Substring of the To address or name"),
  subject: z.string().min(1).optional().describe("Substring of the Subject"),
  since: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only messages received on or after this date (YYYY-MM-DD or ISO 8601)",
    ),
  before: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only messages received before this date (YYYY-MM-DD or ISO 8601)",
    ),
  unread_only: z.boolean().optional(),
  flagged_only: z.boolean().optional(),
};

/** `mail.read` tools (ARCHITECTURE.md section 5.1). */
export function registerReadTools(server: McpServer, deps: ToolDeps): void {
  const ctx = { env: deps.env, waitUntil: deps.waitUntil };

  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description:
        "List every folder in the Yahoo mailbox with its path, hierarchy delimiter, special-use role " +
        "(inbox, sent, drafts, trash, archive, junk) when Yahoo reports one, and its message and unread counts " +
        "(null when Yahoo reports none), all in one round trip. Use these paths as the `folder` argument of other tools.",
      annotations: READ_ONLY,
    },
    () =>
      runTool(deps, { name: "list_folders", kind: "read" }, async () => {
        // Yahoo advertises LIST-STATUS, so the counts ride along with the listing; imapflow
        // falls back to one STATUS per folder on servers that lack it.
        const folders = await withImap(ctx, (client) =>
          client.list({ statusQuery: { messages: true, unseen: true } }),
        );
        return {
          folders: folders
            .filter((f) => f.listed)
            .map((f) => ({
              path: f.path,
              delimiter: f.delimiter,
              special_use: specialUseName(f),
              messages: f.status?.messages ?? null,
              unread: f.status?.unseen ?? null,
            })),
        };
      }),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Search one or more folders and return message headers only (never bodies): uid, folder, from, to, cc, " +
        "subject, date, flags, unread, flagged, attachment presence, size. Results are newest first. " +
        `\`folder\` is one path or a list of up to ${FOLDERS_MAX}, searched in turn on one connection; \`limit\` and \`offset\` apply per folder. ` +
        "With one folder the result has `folder`, `total` and `has_more`; with several it has `folders: [{folder, total, has_more}]` " +
        "and the messages of all of them merged newest first. `total` is exact when known and null when the " +
        "search stopped early because the page was full; `has_more` says whether to ask for the next offset. " +
        "Combine filters freely; with no filters it lists the newest messages. `cc` and `flags` are omitted when empty; " +
        "`flags` holds IMAP flags beyond the `unread` and `flagged` booleans (for example \\Answered), never Yahoo's own $Junk/$NotJunk marks. " +
        "Pass a uid and its folder to get_message for the body.",
      inputSchema: {
        ...SEARCH_FILTERS,
        folder: z
          .union([
            z.string().min(1),
            z.array(z.string().min(1)).min(1).max(FOLDERS_MAX),
          ])
          .default("INBOX")
          .describe(
            "A folder path, or a list of paths to search on one connection",
          ),
        limit: z.number().int().min(1).max(PAGE_MAX).default(20),
        offset: z.number().int().min(0).max(OFFSET_MAX).default(0),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(deps, { name: "search_messages", kind: "read" }, async () => {
        const criteria = buildSearch(args);
        const folders = uniqueFolders(args.folder);
        const page = { offset: args.offset, limit: args.limit };
        return withImap(ctx, async (client) => {
          const pages: FolderPage[] = [];
          for (const folder of folders) {
            pages.push(
              await locked(client, folder, async (c) => {
                const found = await pagedSearch(c, criteria, page);
                const messages = await fetchSummaries(c, found.uids, folder);
                return {
                  folder,
                  total: found.total,
                  has_more: found.hasMore,
                  messages,
                };
              }),
            );
          }
          if (pages.length === 1) {
            const [only] = pages;
            return {
              folder: only.folder,
              total: only.total,
              has_more: only.has_more,
              ...page,
              messages: only.messages,
            };
          }
          return {
            folders: pages.map(({ folder, total, has_more }) => ({
              folder,
              total,
              has_more,
            })),
            ...page,
            messages: pages.flatMap((p) => p.messages).sort(newestFirst),
          };
        });
      }),
  );

  server.registerTool(
    "top_senders",
    {
      title: "Top senders",
      description:
        "Aggregate one folder by sender in a single call: how many messages each sender has, how many of them are unread, " +
        "and the newest subject from each. Takes the same filters as search_messages. It scans the newest matching messages, " +
        `at most ${TOP_SENDERS_SCAN}; \`scanned\` says how many and \`complete\` whether that was every match, so add \`since\` ` +
        "for an exact picture of a period. group_by 'domain' groups by the sender's domain, the unit Yahoo mail filters route on. " +
        "Headers only; nothing is changed. Use search_messages with `from` to list one sender's messages.",
      inputSchema: {
        ...SEARCH_FILTERS,
        folder: z.string().min(1).default("INBOX"),
        group_by: z
          .enum(["address", "domain"])
          .default("address")
          .describe(
            "Group by the full sender address (default) or by its domain",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(TOP_SENDERS_MAX)
          .default(20)
          .describe("How many senders to return, most messages first"),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(deps, { name: "top_senders", kind: "read" }, async () =>
        withMailbox(ctx, args.folder, async (client) => {
          const found = await pagedSearch(client, buildSearch(args), {
            offset: 0,
            limit: TOP_SENDERS_SCAN,
          });
          const fetched = await fetchMessages(
            client,
            found.uids,
            ENVELOPE_QUERY,
          );
          const ranked = aggregateSenders(found.uids, fetched, args.group_by);
          return {
            folder: args.folder,
            group_by: args.group_by,
            scanned: fetched.size,
            total: found.total,
            complete: !found.hasMore,
            senders_total: ranked.length,
            senders: ranked.slice(0, args.limit).map((b) => ({
              sender: b.sender,
              ...(args.group_by === "address"
                ? { name: b.name }
                : { addresses: b.addresses.size }),
              count: b.count,
              unread: b.unread,
              latest: b.latest,
            })),
          };
        }),
      ),
  );

  server.registerTool(
    "get_message",
    {
      title: "Get message",
      description:
        "Read one message: headers, body (plain text by default, converted from HTML when that is all there is), " +
        `and attachment names, types, and sizes. Attachment contents are never available. Bodies are capped at ${BODY_LIMIT} characters.`,
      inputSchema: {
        uid: z
          .number()
          .int()
          .positive()
          .describe("Message uid from search_messages or get_thread"),
        folder: z.string().min(1).default("INBOX"),
        format: z
          .enum(["text", "html"])
          .default("text")
          .describe("Return plain text (default) or the HTML part"),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(
        deps,
        { name: "get_message", kind: "read", uids: [args.uid] },
        async () =>
          withMailbox(ctx, args.folder, async (client) => {
            const msg = await client.fetchOne(
              String(args.uid),
              { ...SUMMARY_QUERY, internalDate: true, headers: THREAD_HEADERS },
              { uid: true },
            );
            if (!msg)
              throw new ToolError(
                "NOT_FOUND",
                `No message with uid ${args.uid} in ${args.folder}`,
              );

            const headers = parseHeaderBlock(msg.headers);
            const body = await readBody(client, msg, args.format, BODY_LIMIT);
            return {
              ...toSummary(msg, args.folder),
              message_id:
                msg.envelope?.messageId ?? headers["message-id"] ?? null,
              in_reply_to:
                msg.envelope?.inReplyTo ?? headers["in-reply-to"] ?? null,
              references: splitMessageIds(headers.references),
              received: toIsoDate(msg.internalDate),
              body_format: body.format,
              body: body.text,
              truncated: body.truncated,
              attachments: listAttachments(msg.bodyStructure),
            };
          }),
      ),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get thread",
      description:
        "Return every message in the same conversation as the given uid, oldest first, as header summaries. " +
        `Set include_bodies to also return each message's plain-text body (first ${THREAD_BODY_MAX} messages, ` +
        `${THREAD_BODY_LIMIT} characters each) so a thread can be summarised in one call.`,
      inputSchema: {
        uid: z.number().int().positive(),
        folder: z.string().min(1).default("INBOX"),
        include_bodies: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(
        deps,
        { name: "get_thread", kind: "read", uids: [args.uid] },
        async () =>
          withMailbox(ctx, args.folder, async (client) => {
            const target = await client.fetchOne(
              String(args.uid),
              {
                uid: true,
                envelope: true,
                threadId: true,
                headers: THREAD_HEADERS,
              },
              { uid: true },
            );
            if (!target)
              throw new ToolError(
                "NOT_FOUND",
                `No message with uid ${args.uid} in ${args.folder}`,
              );

            const { uids, threadId, method } = await threadUids(client, target);
            const capped = uids.length > PAGE_MAX;
            const windowUids = capped
              ? windowAround(uids, target.uid, PAGE_MAX)
              : uids;
            const fetched = await fetchMessages(client, windowUids);
            const summaries = windowUids.flatMap((uid) => {
              const m = fetched.get(uid);
              return m ? [toSummary(m, args.folder)] : [];
            });
            summaries.sort(
              (a, b) =>
                (a.date ?? "").localeCompare(b.date ?? "") || a.uid - b.uid,
            );

            const messages: Array<
              MessageSummary & { body_text?: string; body_truncated?: boolean }
            > = summaries;
            if (args.include_bodies) {
              for (const m of messages.slice(0, THREAD_BODY_MAX)) {
                // fetchMessages already brought the BODYSTRUCTURE readBody needs.
                const full = fetched.get(m.uid);
                if (!full) continue;
                const body = await readBody(
                  client,
                  full,
                  "text",
                  THREAD_BODY_LIMIT,
                );
                m.body_text = body.text;
                m.body_truncated = body.truncated;
              }
            }
            return {
              folder: args.folder,
              thread_id: threadId,
              matched_by: method,
              thread_size: uids.length,
              truncated: capped,
              messages,
            };
          }),
      ),
  );

  server.registerTool(
    "list_drafts",
    {
      title: "List drafts",
      description:
        "List the newest drafts in the Yahoo Drafts folder as header summaries. The folder is located by its " +
        "IMAP special-use flag, so it works whatever Yahoo names it. Use get_message with the returned folder to read one.",
      inputSchema: { limit: z.number().int().min(1).max(PAGE_MAX).default(20) },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(deps, { name: "list_drafts", kind: "read" }, async () =>
        withSpecialUse(ctx, "\\Drafts", async (client, path) => {
          const page = await pagedSearch(
            client,
            {},
            { offset: 0, limit: args.limit },
          );
          const messages = await fetchSummaries(client, page.uids, path);
          return {
            folder: path,
            total: page.total,
            has_more: page.hasMore,
            messages,
          };
        }),
      ),
  );
}

/** `\Sent` becomes "sent"; INBOX is special-use by definition even though IMAP has no flag for it. */
function specialUseName(f: ListResponse): string | null {
  if (f.path.toUpperCase() === "INBOX") return "inbox";
  return f.specialUse ? f.specialUse.replace(/^\\/, "").toLowerCase() : null;
}

interface SearchArgs {
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
  unread_only?: boolean;
  flagged_only?: boolean;
}

export function buildSearch(args: SearchArgs): SearchObject {
  const q: SearchObject = {};
  if (args.query) q.text = args.query;
  if (args.from) q.from = args.from;
  if (args.to) q.to = args.to;
  if (args.subject) q.subject = args.subject;
  if (args.since) q.since = parseDate(args.since, "since");
  if (args.before) q.before = parseDate(args.before, "before");
  if (args.unread_only) q.seen = false;
  if (args.flagged_only) q.flagged = true;
  return q;
}

function parseDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ToolError(
      "INVALID_ARGUMENT",
      `${field} must be a date like 2026-09-01 or an ISO 8601 timestamp`,
    );
  }
  return d;
}

/**
 * Fetch `query` for every uid, keyed by uid; uids gone meanwhile are absent. One FETCH per
 * FETCH_MAX uids, because Yahoo caps a single fetch at that many messages.
 */
export async function fetchMessages(
  client: ImapFlow,
  uids: number[],
  query: FetchQueryObject = SUMMARY_QUERY,
): Promise<Map<number, FetchMessageObject>> {
  const byUid = new Map<number, FetchMessageObject>();
  for (let i = 0; i < uids.length; i += FETCH_MAX) {
    const batch = uids.slice(i, i + FETCH_MAX);
    const fetched = await client.fetchAll(batch, query, { uid: true });
    for (const m of fetched) byUid.set(m.uid, m);
  }
  return byUid;
}

interface FolderPage {
  folder: string;
  total: number | null;
  has_more: boolean;
  messages: MessageSummary[];
}

/** Order-preserving dedupe, so `["INBOX", "INBOX"]` is one folder, not the same page twice. */
function uniqueFolders(folder: string | string[]): string[] {
  return [...new Set(Array.isArray(folder) ? folder : [folder])];
}

function newestFirst(a: MessageSummary, b: MessageSummary): number {
  return (b.date ?? "").localeCompare(a.date ?? "") || b.uid - a.uid;
}

interface SenderBucket {
  /** The group key: a lowercased address, or a domain when grouping by domain. */
  sender: string;
  /** Most recent non-empty display name seen for the address. */
  name: string | null;
  addresses: Set<string>;
  count: number;
  unread: number;
  latest: { uid: number; subject: string | null; date: string | null };
}

/**
 * Bucket messages by sender. `uids` must be newest first (as pagedSearch returns them), so the
 * first message seen for a bucket is its latest. Most messages first, then most recent, then name.
 */
export function aggregateSenders(
  uids: number[],
  byUid: Map<number, FetchMessageObject>,
  groupBy: "address" | "domain",
): SenderBucket[] {
  const buckets = new Map<string, SenderBucket>();
  for (const uid of uids) {
    const m = byUid.get(uid);
    if (!m) continue;
    const first = m.envelope?.from?.[0];
    const address = first?.address?.trim().toLowerCase() || null;
    const name = first?.name?.trim() || null;
    const key =
      groupBy === "domain"
        ? domainOf(address)
        : (address ?? name ?? "(unknown)");
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        sender: key,
        name: null,
        addresses: new Set(),
        count: 0,
        unread: 0,
        latest: {
          uid: m.uid,
          subject: m.envelope?.subject ?? null,
          date: toIsoDate(m.envelope?.date),
        },
      };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (!m.flags?.has("\\Seen")) bucket.unread++;
    if (address) bucket.addresses.add(address);
    if (!bucket.name && name) bucket.name = name;
  }
  return [...buckets.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (b.latest.date ?? "").localeCompare(a.latest.date ?? "") ||
      a.sender.localeCompare(b.sender),
  );
}

function domainOf(address: string | null): string {
  const at = address ? address.lastIndexOf("@") : -1;
  return address && at >= 0 ? address.slice(at + 1) : "(unknown)";
}

export async function fetchSummaries(
  client: ImapFlow,
  uids: number[],
  folder: string,
): Promise<MessageSummary[]> {
  const byUid = await fetchMessages(client, uids);
  return uids.flatMap((uid) => {
    const m = byUid.get(uid);
    return m ? [toSummary(m, folder)] : [];
  });
}

export function toSummary(
  m: FetchMessageObject,
  folder: string,
): MessageSummary {
  const flags = [...(m.flags ?? [])];
  const cc = formatAddresses(m.envelope?.cc);
  // Read and starred state are booleans below; Yahoo's classifier marks are noise to a client.
  const extra = flags.filter(
    (f) => !BOOLEAN_FLAGS.has(f) && !YAHOO_CLASSIFIER_FLAGS.has(f),
  );
  return {
    uid: m.uid,
    folder,
    from: formatAddresses(m.envelope?.from),
    to: formatAddresses(m.envelope?.to),
    ...(cc.length ? { cc } : {}),
    subject: m.envelope?.subject ?? null,
    date: toIsoDate(m.envelope?.date),
    ...(extra.length ? { flags: extra } : {}),
    unread: !flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    has_attachments: listAttachments(m.bodyStructure).length > 0,
    size: typeof m.size === "number" ? m.size : null,
  };
}

export async function readBody(
  client: ImapFlow,
  msg: FetchMessageObject,
  format: "text" | "html",
  limit: number,
): Promise<{ text: string; format: "text" | "html"; truncated: boolean }> {
  const parts = selectBodyParts(msg.bodyStructure);
  // Pull a little more than the cap so truncation happens on our side, not mid-decode.
  const maxBytes = limit * 4 + 4096;
  const fetch = (part: BodyPart) => downloadText(client, msg.uid, part, maxBytes);

  if (format === "html") {
    if (parts.html)
      return { ...capped(await fetch(parts.html), limit, stripActiveContent), format: "html" };
    if (parts.text) return { ...capped(await fetch(parts.text), limit), format: "text" };
    return { text: "", format: "html", truncated: false };
  }
  if (parts.text) return { ...capped(await fetch(parts.text), limit), format: "text" };
  if (parts.html)
    return { ...capped(await fetch(parts.html), limit, htmlToText), format: "text" };
  return { text: "", format: "text", truncated: false };
}

/**
 * Apply the character cap, and never report a prefix as the whole: a part the byte cap cut short
 * is truncated even when its decoded text fits, which markup-heavy HTML often does.
 */
function capped(
  downloaded: DownloadedText,
  limit: number,
  transform: (s: string) => string = (s) => s,
): { text: string; truncated: boolean } {
  const cut = truncateText(transform(downloaded.text), limit);
  if (downloaded.complete || cut.truncated) return cut;
  return {
    text: `${cut.text}\n[... truncated: the message is longer than the fetch limit]`,
    truncated: true,
  };
}

/** When HTML is requested, still never hand a client executable content. */
function stripActiveContent(html: string): string {
  return stripElements(html, ["script", "iframe", "object", "embed"]).replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

interface ThreadResolution {
  uids: number[];
  threadId: string | null;
  method: "thread_id" | "references";
}

/**
 * Yahoo advertises OBJECTID, so a server-side THREADID search is tried first. If the server
 * has no thread id for the message, fall back to matching the References chain by header.
 * Both searches match few messages, so their response lines stay small.
 */
async function threadUids(
  client: ImapFlow,
  target: FetchMessageObject,
): Promise<ThreadResolution> {
  if (target.threadId) {
    try {
      const result = await client.search(
        { threadId: target.threadId },
        { uid: true },
      );
      if (Array.isArray(result) && result.length > 0) {
        return {
          uids: withTarget(result, target.uid),
          threadId: target.threadId,
          method: "thread_id",
        };
      }
    } catch (err) {
      // Only a rejected THREADID key falls back to the header chain. A dead or throttled
      // connection would fail the fallback too, and more confusingly, so it surfaces as is.
      const e = normalizeError(err);
      if (["IMAP_RATE_LIMITED", "IMAP_CONNECT_FAILED", "IMAP_AUTH_FAILED"].includes(e.code)) {
        throw e;
      }
    }
  }

  const headers = parseHeaderBlock(target.headers);
  const refs = splitMessageIds(headers.references);
  const own = target.envelope?.messageId ?? headers["message-id"];
  const root = refs[0] ?? target.envelope?.inReplyTo ?? own;
  if (!root)
    return { uids: [target.uid], threadId: null, method: "references" };

  const result = await client.search(
    {
      or: [
        { header: { "message-id": root } },
        { header: { references: root } },
        { header: { "in-reply-to": root } },
      ],
    },
    { uid: true },
  );
  // ImapFlow answers false (or nothing) when the server rejects the SEARCH; silently showing a
  // one-message thread would be wrong, so it is an error the client can retry.
  if (!Array.isArray(result))
    throw new ToolError("IMAP_SEARCH_FAILED", "Yahoo rejected the thread search");
  return {
    uids: withTarget(result, target.uid),
    threadId: null,
    method: "references",
  };
}

/** `size` uids that always include `target`: the newest ones when the target is recent, else a window around it. */
function windowAround(uids: number[], target: number, size: number): number[] {
  const idx = Math.max(0, uids.indexOf(target));
  const start = Math.min(
    Math.max(0, idx - Math.floor(size / 2)),
    uids.length - size,
  );
  return uids.slice(start, start + size);
}

function withTarget(uids: number[], target: number): number[] {
  const set = new Set(uids);
  set.add(target);
  return [...set].sort((a, b) => a - b);
}
