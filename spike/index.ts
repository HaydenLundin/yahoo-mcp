// Spike v3: how does Yahoo IMAP behave under workerd?
//   GET /ping -> module loaded
//   GET /run  -> diagnostics (three Yahoo logins): search response size threshold, large
//                multi-line FETCH, large body download with default and small chunk sizes.
// Prints counts, byte sizes, and timings only. Never mail content.
import { ImapFlow } from "imapflow";

interface Env {
  YAHOO_USER?: string;
  YAHOO_APP_PASSWORD?: string;
}
interface LogEntry {
  level: string;
  msg?: string;
  err?: string;
  code?: string;
  response?: string;
}
interface StructureNode {
  type: string;
  part?: string;
  childNodes?: StructureNode[];
}

function makeClient(env: Env, log: LogEntry[]): ImapFlow {
  const capture = (level: string) => (entry: unknown) => {
    const e = (entry ?? {}) as { msg?: string; err?: { message?: string; code?: string; responseText?: string } };
    log.push({ level, msg: e.msg, err: e.err?.message, code: e.err?.code, response: e.err?.responseText });
  };
  return new ImapFlow({
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    auth: {
      user: env.YAHOO_USER ?? "spike-no-creds@yahoo.com",
      pass: env.YAHOO_APP_PASSWORD ?? "not-a-real-password",
    },
    logger: {
      trace() {},
      debug() {},
      info() {},
      warn: capture("warn"),
      error: capture("error"),
      fatal: capture("fatal"),
    } as never,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

/** One login, INBOX selected, always closed. A stall kills the connection, so each phase gets its own. */
async function session<T>(
  env: Env,
  log: LogEntry[],
  fn: (c: ImapFlow, step: (name: string) => void) => Promise<T>,
): Promise<T | { failed: string; at: string; after_ms: number }> {
  const c = makeClient(env, log);
  c.on("error", (e: unknown) => log.push({ level: "event", err: (e as Error).message }));
  let current = "connect";
  const started = Date.now();
  const step = (name: string) => {
    current = name;
  };
  try {
    await c.connect();
    step("select");
    const lock = await c.getMailboxLock("INBOX");
    try {
      return await fn(c, step);
    } finally {
      lock.release();
    }
  } catch (e) {
    return { failed: (e as Error).message, at: current, after_ms: Date.now() - started };
  } finally {
    try {
      await Promise.race([c.logout(), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      /* ignore */
    }
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ r: T; ms: number }> {
  const t = Date.now();
  const r = await fn();
  return { r, ms: Date.now() - t };
}

function firstTextPart(node: StructureNode, want = "text/"): string {
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const p = firstTextPart(child, want);
      if (p) return p;
    }
    return "";
  }
  return node.type.toLowerCase().startsWith(want) ? (node.part ?? "1") : "";
}

async function readAll(d: { content?: AsyncIterable<Uint8Array> }): Promise<{ bytes: number } | { empty: true }> {
  if (!d.content) return { empty: true };
  let n = 0;
  for await (const chunk of d.content) n += chunk.byteLength;
  return { bytes: n };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ping") return Response.json({ ok: true, runtime: navigator.userAgent ?? null });
    if (url.pathname !== "/run") return new Response("spike: GET /run (three Yahoo logins)", { status: 200 });

    const log: LogEntry[] = [];
    const out: Record<string, unknown> = {};
    const t0 = Date.now();
    
    // Phase B: find the largest message under 200 KB (a big HTML newsletter, not an attachment carrier)
    // and download its text part with imapflow's default chunking. A >16 KB literal is the test.
    let target: { uid: number; size: number; part: string } | null = null;
    out.download = await session(env, log, async (c, step) => {
      const mb = c.mailbox && typeof c.mailbox === "object" ? c.mailbox : null;
      const next = mb?.uidNext ?? 0;
      step("search_window");
      const uids = await c.search({ uid: `${Math.max(1, next - 10_000)}:*` }, { uid: true });
      if (!Array.isArray(uids) || !uids.length) return { failed: "no uids" };
      step("fetch_sizes");
      const { r: msgs, ms } = await timed(() => c.fetchAll(uids.slice(-1000), { uid: true, size: true }, { uid: true }));
      const candidates = msgs.filter((m) => (m.size ?? 0) < 200_000).sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      const res: Record<string, unknown> = { fetched: msgs.length, fetch_ms: ms };
      step("fetch_bodystructure");
      for (const cand of candidates.slice(0, 5)) {
        const full = await c.fetchOne(String(cand.uid), { uid: true, bodyStructure: true }, { uid: true });
        const part = full && full.bodyStructure ? firstTextPart(full.bodyStructure as StructureNode, "text/html") || firstTextPart(full.bodyStructure as StructureNode) : "";
        if (part) {
          target = { uid: cand.uid, size: cand.size ?? 0, part };
          break;
        }
      }
      if (!target) return { ...res, failed: "no text candidate" };
      res.target = target;
      const tgt = target;
      step("download_default");
      res.default_chunks = await timed(async () => readAll(await c.download(String(tgt.uid), tgt.part, { uid: true })));
      return res;
    });

    // Phase C: same part, 12 KB chunks, so each FETCH literal stays under 16 KB.
    out.downloadSmallChunks = await session(env, log, async (c, step) => {
      if (!target) return { skipped: "no target" };
      const tgt = target;
      step("download_small_chunks");
      return timed(async () => readAll(await c.download(String(tgt.uid), tgt.part, { uid: true, chunkSize: 12_000 })));
    });

    out.ms = Date.now() - t0;
    out.log = log.slice(0, 20);
    return Response.json(out);
  },
};
