import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  FetchMessageObject,
  ImapFlow,
  ListResponse,
  SearchObject,
} from "imapflow";
import { z } from "zod";
import { normalizeError, ToolError } from "../../lib/errors";
import {
  downloadText,
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
  toIsoDate,
  truncateText,
} from "../../lib/mime";
import { READ_ONLY, runTool, type ToolDeps } from "../tool";

/** Hard ceiling on messages returned by one call; Yahoo also caps fetch ranges at 1000. */
const PAGE_MAX = 50;
/** Paging deeper than this would mean scanning most of the folder on every call. */
const OFFSET_MAX = 2000;
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
const THREAD_HEADERS = ["message-id", "in-reply-to", "references"];

export interface MessageSummary {
  uid: number;
  folder: string;
  from: string[];
  to: string[];
  cc: string[];
  subject: string | null;
  date: string | null;
  flags: string[];
  unread: boolean;
  flagged: boolean;
  has_attachments: boolean;
  size: number | null;
}

/** `mail.read` tools (ARCHITECTURE.md section 5.1). */
export function registerReadTools(server: McpServer, deps: ToolDeps): void {
  const ctx = { env: deps.env, waitUntil: deps.waitUntil };

  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description:
        "List every folder in the Yahoo mailbox with its path, hierarchy delimiter, and special-use role " +
        "(inbox, sent, drafts, trash, archive, junk) when Yahoo reports one. Use these paths as the `folder` argument of other tools.",
      annotations: READ_ONLY,
    },
    () =>
      runTool(deps, { name: "list_folders", kind: "read" }, async () => {
        const folders = await withImap(ctx, (client) => client.list());
        return {
          folders: folders
            .filter((f) => f.listed)
            .map((f) => ({
              path: f.path,
              delimiter: f.delimiter,
              special_use: specialUseName(f),
            })),
        };
      }),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Search one folder and return message headers only (never bodies): uid, from, to, subject, date, flags, " +
        "attachment presence, size. Results are newest first. `total` is exact when known and null when the " +
        "search stopped early because the page was full; `has_more` says whether to ask for the next offset. " +
        "Combine filters freely; with no filters it lists the newest messages. Pass a uid to get_message for the body.",
      inputSchema: {
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
        subject: z
          .string()
          .min(1)
          .optional()
          .describe("Substring of the Subject"),
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
        folder: z.string().min(1).default("INBOX"),
        limit: z.number().int().min(1).max(PAGE_MAX).default(20),
        offset: z.number().int().min(0).max(OFFSET_MAX).default(0),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(deps, { name: "search_messages", kind: "read" }, async () => {
        const criteria = buildSearch(args);
        return withMailbox(ctx, args.folder, async (client) => {
          const page = await pagedSearch(client, criteria, {
            offset: args.offset,
            limit: args.limit,
          });
          const messages = await fetchSummaries(client, page.uids, args.folder);
          return {
            folder: args.folder,
            total: page.total,
            has_more: page.hasMore,
            offset: args.offset,
            limit: args.limit,
            messages,
          };
        });
      }),
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

/** One FETCH for everything a summary (and readBody) needs, keyed by uid; uids gone meanwhile are absent. */
export async function fetchMessages(
  client: ImapFlow,
  uids: number[],
): Promise<Map<number, FetchMessageObject>> {
  if (uids.length === 0) return new Map();
  const fetched = await client.fetchAll(uids, SUMMARY_QUERY, { uid: true });
  return new Map(fetched.map((m) => [m.uid, m]));
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
  return {
    uid: m.uid,
    folder,
    from: formatAddresses(m.envelope?.from),
    to: formatAddresses(m.envelope?.to),
    cc: formatAddresses(m.envelope?.cc),
    subject: m.envelope?.subject ?? null,
    date: toIsoDate(m.envelope?.date),
    flags,
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
  return html
    .replace(/<(script|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
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
  const uids = Array.isArray(result) ? result : [];
  return {
    uids: withTarget(uids, target.uid),
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
