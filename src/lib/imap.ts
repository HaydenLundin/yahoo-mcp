import { ImapFlow, type SearchObject } from "imapflow";
import type { Env } from "../types";
import { ToolError } from "./errors";
import { decodeBody, type BodyPart } from "./mime";

const YAHOO_IMAP = { host: "imap.mail.yahoo.com", port: 993 } as const;

/**
 * The "16 KB stall", found 2026-10-06. Symptom: a single IMAP response line or literal over
 * ~16 KB never finished arriving on Workers (local and edge); the command stalled to socketTimeout
 * and the connection died. Cause (established 2026-10-07 after a wrong first attribution to
 * workerd's node:zlib): imapflow 2.0.0's ImapStream clears its input-loop guard a few microtasks
 * after finding its queue empty, and on workerd the next chunk is delivered inside that gap and is
 * never processed (postalsys/imapflow#408, fixed in 2.1.0). COMPRESS=DEFLATE makes the race
 * near-certain because the inflater hands over several 16 KiB chunks per socket read; plain TLS
 * delivers one chunk per read, so disabling compression below sidesteps it. A standalone inflate
 * test (spike/zlib-lab) shows workerd's zlib itself is fine. Once imapflow is upgraded past 2.1.0
 * the option can go.
 *
 * pagedSearch and the ranged body fetches predate the fix and stay as defence in depth: they bound
 * response sizes and round trips, and the ranged fetch also sidesteps imapflow's download(), which
 * fetches the whole header block for single-part messages.
 */
export const IMAP_CHUNK_BYTES = 60_000;
export const SEARCH_WINDOW = 1000;

export interface ImapContext {
  env: Env;
  /**
   * Workers `ExecutionContext.waitUntil`. When provided, LOGOUT completes after the
   * response is sent instead of adding ~300 ms to every tool call.
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * One IMAP session per tool call: connect, run fn, logout. No pooling; Workers isolates
 * are ephemeral and Yahoo tolerates short sessions (spike: ~1.7 s connect+auth on the edge).
 */
export async function withImap<T>(
  ctx: ImapContext,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: YAHOO_IMAP.host,
    port: YAHOO_IMAP.port,
    secure: true,
    auth: { user: ctx.env.YAHOO_USER, pass: ctx.env.YAHOO_APP_PASSWORD },
    // imapflow swallows command failures (search() returns false) and only reports them to
    // its logger. IMAP_DEBUG=true forwards warn/error entries, summarised, to the Worker log.
    logger: ctx.env.IMAP_DEBUG === "true" ? debugLogger : false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    // Workaround for the 16 KB stall (see the note above): imapflow 2.0.x drops a chunk that
    // arrives while its input loop is winding down, and the inflater behind COMPRESS=DEFLATE
    // produces exactly that timing. Plain TLS delivers one chunk per read and does not. Revisit
    // after upgrading imapflow past 2.1.0.
    disableCompression: true,
  });
  // A failed command can leave the socket to time out later; without a listener that
  // surfaces as an uncaught exception in the Worker log long after the response was sent.
  client.on("error", (err: unknown) => {
    console.warn(
      "imap connection error after response",
      err instanceof Error ? err.message : String(err),
    );
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    const bye = closeQuietly(client);
    if (ctx.waitUntil) ctx.waitUntil(bye);
    else await bye;
  }
}

interface ImapLogEntry {
  msg?: string;
  cid?: string;
  err?: {
    message?: string;
    responseText?: string;
    serverResponseCode?: string;
    code?: string;
  };
  responseText?: string;
  responseStatus?: string;
}

/** Only the fields that explain a failure. Never raw protocol frames, which could carry mail content. */
function summarizeLog(entry: unknown): string {
  const e = (entry ?? {}) as ImapLogEntry;
  return JSON.stringify({
    msg: e.msg,
    cid: e.cid,
    error: e.err?.message,
    code: e.err?.code ?? e.err?.serverResponseCode ?? e.responseStatus,
    response: e.err?.responseText ?? e.responseText,
  });
}

const noop = (): void => {};
const debugLogger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: (entry: unknown) => console.warn("imap", summarizeLog(entry)),
  error: (entry: unknown) => console.error("imap", summarizeLog(entry)),
  fatal: (entry: unknown) => console.error("imap", summarizeLog(entry)),
};

/** LOGOUT politely, but never wait on a wedged connection: force-close after a short grace period. */
async function closeQuietly(client: ImapFlow): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 5_000);
  });
  try {
    const outcome = await Promise.race([
      client.logout().then(() => "ok" as const),
      deadline,
    ]);
    if (outcome === "timeout") client.close();
  } catch {
    client.close();
  } finally {
    clearTimeout(timer);
  }
}

/** Same as withImap but with `path` selected and locked for the duration of fn. */
export async function withMailbox<T>(
  ctx: ImapContext,
  path: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  return withImap(ctx, (client) => locked(client, path, fn));
}

/**
 * Like withMailbox, but the folder is found by IMAP special-use flag (`\Drafts`, `\Sent`,
 * `\Trash`, `\Archive`, `\Junk`) instead of by name. Yahoo's names are unusual (`Draft`,
 * `Bulk`), so names are never hardcoded. fn also receives the resolved path.
 */
export async function withSpecialUse<T>(
  ctx: ImapContext,
  specialUse: SpecialUse,
  fn: (client: ImapFlow, path: string) => Promise<T>,
): Promise<T> {
  return withImap(ctx, async (client) => {
    const path = await resolveSpecialUse(client, specialUse);
    return locked(client, path, (c) => fn(c, path));
  });
}

export type SpecialUse =
  "\\Drafts" | "\\Sent" | "\\Trash" | "\\Archive" | "\\Junk";

export async function resolveSpecialUse(
  client: ImapFlow,
  specialUse: SpecialUse,
): Promise<string> {
  const folders = await client.list();
  const match = folders.find((f) => f.specialUse === specialUse);
  if (!match) {
    throw new ToolError(
      "FOLDER_NOT_FOUND",
      `Yahoo did not report a folder with special-use ${specialUse}. Use list_folders to see what exists.`,
    );
  }
  return match.path;
}

async function locked<T>(
  client: ImapFlow,
  path: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(path);
  try {
    return await fn(client);
  } finally {
    lock.release();
  }
}

/**
 * Download one body part as text. Fetches `BODY.PEEK[part]<start.IMAP_CHUNK_BYTES>` ranges until
 * the part ends or `maxBytes` raw bytes have arrived, then transfer-decodes and charset-decodes
 * using what BODYSTRUCTURE said about the part.
 */
export async function downloadText(
  client: ImapFlow,
  uid: number,
  part: BodyPart,
  maxBytes: number,
): Promise<string> {
  const key = part.id.toLowerCase();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < maxBytes) {
    const msg = await client.fetchOne(
      String(uid),
      {
        uid: true,
        bodyParts: [{ key, start: received, maxLength: IMAP_CHUNK_BYTES }],
      },
      { uid: true },
    );
    const chunk = msg ? msg.bodyParts?.get(key) : undefined;
    if (!chunk || chunk.length === 0) break;
    chunks.push(chunk);
    received += chunk.length;
    if (chunk.length < IMAP_CHUNK_BYTES) break;
  }
  if (received === 0) return "";
  const raw = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    raw.set(c, offset);
    offset += c.length;
  }
  return decodeBody(raw, part);
}

export interface PagedSearch {
  /** The requested page of uids, newest first. */
  uids: number[];
  /** Exact match count when known (unfiltered, or the whole folder was scanned); otherwise null. */
  total: number | null;
  hasMore: boolean;
  /** Number of windows (round trips) it took; useful for tests and logs. */
  windows: number;
}

/**
 * Search newest-first in SEARCH_WINDOW-message windows until the requested page is filled or the
 * folder is exhausted. Yahoo exposes at most 10,000 messages per folder and has no ESEARCH, so
 * this is at most ten round trips, and usually one. `criteria` must not contain `seq` or `uid`.
 */
export async function pagedSearch(
  client: ImapFlow,
  criteria: SearchObject,
  page: { offset: number; limit: number },
): Promise<PagedSearch> {
  const mailbox =
    client.mailbox && typeof client.mailbox === "object"
      ? client.mailbox
      : null;
  const exists = mailbox?.exists ?? 0;
  if (exists === 0) return { uids: [], total: 0, hasMore: false, windows: 0 };

  const { all: _all, ...filters } = criteria;
  const unfiltered = Object.values(filters).every((v) => v === undefined);
  const needed = page.offset + page.limit;
  const matches: number[] = [];
  let hi = exists;
  let windows = 0;

  while (hi >= 1 && matches.length < needed) {
    const lo = Math.max(1, hi - SEARCH_WINDOW + 1);
    const result = await client.search(
      { ...filters, seq: `${lo}:${hi}` },
      { uid: true },
    );
    if (result === false)
      throw new ToolError(
        "IMAP_SEARCH_FAILED",
        "Yahoo rejected the search criteria",
      );
    matches.push(...(result ?? []).slice().sort((a, b) => b - a));
    hi = lo - 1;
    windows++;
  }

  const complete = hi < 1;
  return {
    uids: matches.slice(page.offset, needed),
    total: unfiltered ? exists : complete ? matches.length : null,
    hasMore: complete ? matches.length > needed : true,
    windows,
  };
}
