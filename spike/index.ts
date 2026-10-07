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
  src?: string;
  cmd?: string;
  size?: number;
  t?: number;
}
interface StructureNode {
  type: string;
  part?: string;
  childNodes?: StructureNode[];
}

function makeClient(env: Env, log: LogEntry[], trace = false, noCompress = false): ImapFlow {
  const capture = (level: string) => (entry: unknown) => {
    const e = (entry ?? {}) as {
      msg?: string;
      src?: string;
      cmd?: string;
      command?: string;
      err?: { message?: string; code?: string; responseText?: string };
      data?: unknown;
    };
    const size = typeof e.data === "string" ? e.data.length : undefined;
    if (e.msg === "Socket timeout" || e.err?.message === "Socket timeout") return; // bursty shim noise
    if (log.length < 80) {
      log.push({ level, msg: e.msg, err: e.err?.message, code: e.err?.code, response: e.err?.responseText, src: e.src, cmd: e.cmd ?? e.command, size, t: Date.now() });
    }
  };
  const quiet = trace ? capture("trace") : () => {};
  const quietDebug = trace ? capture("debug") : () => {};
  const quietInfo = trace ? capture("info") : () => {};
  return new ImapFlow({
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    auth: {
      user: env.YAHOO_USER ?? "spike-no-creds@yahoo.com",
      pass: env.YAHOO_APP_PASSWORD ?? "not-a-real-password",
    },
    logger: {
      trace: quiet,
      debug: quietDebug,
      info: quietInfo,
      warn: capture("warn"),
      error: capture("error"),
      fatal: capture("fatal"),
    } as never,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    disableCompression: noCompress,
  });
}

/** One login, INBOX selected, always closed. A stall kills the connection, so each phase gets its own. */
async function session<T>(
  env: Env,
  log: LogEntry[],
  fn: (c: ImapFlow, step: (name: string) => void) => Promise<T>,
  trace = false,
  noCompress = false,
): Promise<T | { failed: string; at: string; after_ms: number }> {
  const c = makeClient(env, log, trace, noCompress);
  c.on("error", (e: unknown) => {
    if ((e as Error).message !== "Socket timeout") log.push({ level: "event", err: (e as Error).message });
  });
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


interface SocketLike {
  pause: () => unknown;
  resume: () => unknown;
  readableHighWaterMark?: number;
  readableFlowing?: boolean | null;
  constructor?: { name?: string };
}

async function rawProbe(env: Env, mode: "flow" | "pause"): Promise<Response> {
  const { connect } = await import("node:tls");
  const t0 = Date.now();
  const events: string[] = [];
  let bytes = 0;
  let chunks = 0;
  let buf = "";
  let tagNo = 0;
  const pending: Array<{ tag: string; resolve: (line: string) => void }> = [];
  const quote = (v: string) => JSON.stringify(v); // IMAP quoted-string escaping matches JSON's

  return new Promise<Response>((resolve) => {
    let finished = false;
    const sock = connect({ host: "imap.mail.yahoo.com", port: 993, servername: "imap.mail.yahoo.com" });
    const finish = (why: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(Response.json({ mode, why, bytes, chunks, ms: Date.now() - t0, events: events.slice(0, 40) }));
    };
    const timer = setTimeout(() => finish("timeout"), 25_000);
    const exec = (cmd: string, label: string) =>
      new Promise<string>((res) => {
        const tag = `A${++tagNo}`;
        pending.push({ tag, resolve: res });
        events.push(`> ${tag} ${label}`);
        sock.write(`${tag} ${cmd}\r\n`);
      });

    sock.on("data", (chunk: Uint8Array) => {
      bytes += chunk.byteLength;
      chunks++;
      if (chunks <= 5 || chunks % 10 === 0) events.push(`chunk#${chunks} ${chunk.byteLength}B total=${bytes}`);
      if (mode === "pause" && chunks === 1) {
        sock.pause();
        events.push("paused");
        setTimeout(() => {
          sock.resume();
          events.push("resumed");
        }, 100);
      }
      buf += new TextDecoder("latin1").decode(chunk);
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (line.startsWith("* SEARCH")) events.push(`search line ${line.length} chars`);
        for (let i = pending.length - 1; i >= 0; i--) {
          if (line.startsWith(`${pending[i].tag} `)) {
            events.push(`< ${line.slice(0, 60)}`);
            pending[i].resolve(line);
            pending.splice(i, 1);
          }
        }
      }
    });
    sock.on("error", (e: Error) => {
      events.push(`error ${e.message}`);
      finish("error");
    });
    sock.on("close", () => {
      events.push("close");
      finish("closed");
    });
    sock.once("secureConnect", async () => {
      events.push("connected");
      await exec(`LOGIN ${quote(env.YAHOO_USER ?? "")} ${quote(env.YAHOO_APP_PASSWORD ?? "")}`, "LOGIN");
      await exec("SELECT INBOX", "SELECT INBOX");
      await exec("UID SEARCH ALL", "UID SEARCH ALL");
      await exec("LOGOUT", "LOGOUT");
      finish("ok");
    });
  });
}


interface RawPipeOptions {
  patch: boolean;
  deferMs: number;
  /** sock.setTimeout(ms) once after connect, as imapflow's configureSocket does. */
  timeoutMs: number;
  /** Re-arm sock.setTimeout on every data chunk. */
  rearm: boolean;
  /** sock.setKeepAlive(true, 5000) as imapflow does. */
  keepAlive: boolean;
}

async function rawPipeProbe(env: Env, opts: RawPipeOptions): Promise<Response> {
  const { patch, deferMs, timeoutMs, rearm, keepAlive } = opts;
  const { connect } = await import("node:tls");
  const { Transform } = await import("node:stream");
  const t0 = Date.now();
  const events: string[] = [];
  let socketBytes = 0;
  let socketChunks = 0;
  let parsedBytes = 0;
  let lines = 0;
  let pauses = 0;
  let writeFalse = 0;
  let tagNo = 0;
  let buf = "";
  const pending: Array<{ tag: string; resolve: (line: string) => void }> = [];

  return new Promise<Response>((resolve) => {
    let finished = false;
    const sock = connect({ host: "imap.mail.yahoo.com", port: 993, servername: "imap.mail.yahoo.com" });
    const finish = (why: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(
        Response.json({
          patch,
          deferMs,
          timeoutMs,
          rearm,
          keepAlive,
          timeoutListeners,
          why,
          socketBytes,
          socketChunks,
          parsedBytes,
          lines,
          pauses,
          writeFalse,
          ms: Date.now() - t0,
          events: events.slice(0, 40),
        }),
      );
    };
    const timer = setTimeout(() => finish("timeout"), 25_000);
    let timeoutListeners = 0;
    sock.on("timeout", () => events.push("socket timeout event"));
    if (keepAlive && typeof (sock as { setKeepAlive?: unknown }).setKeepAlive === "function") {
      (sock as unknown as { setKeepAlive: (on: boolean, ms: number) => void }).setKeepAlive(true, 5000);
      events.push("keepalive set");
    }
    if (timeoutMs > 0) {
      sock.setTimeout(timeoutMs);
      events.push(`setTimeout(${timeoutMs})`);
    }
    if (patch) {
      const origPause = sock.pause.bind(sock);
      sock.pause = () => {
        pauses++;
        return sock;
      };
      void origPause;
    } else {
      const origPause = sock.pause.bind(sock);
      sock.pause = () => {
        pauses++;
        return origPause();
      };
    }

    // Parser stand-in: splits lines, defers the write callback like ImapStream does.
    const parser = new Transform({
      readableObjectMode: true,
      transform(chunk: Uint8Array, _enc, next) {
        parsedBytes += chunk.byteLength;
        buf += new TextDecoder("latin1").decode(chunk);
        let idx: number;
        while ((idx = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          lines++;
          this.push({ line });
        }
        if (deferMs > 0) setTimeout(next, deferMs);
        else Promise.resolve().then(() => next());
      },
    });
    parser.on("data", (item: { line: string }) => {
      const line = item.line;
      if (line.startsWith("* SEARCH")) events.push(`search line ${line.length} chars`);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (line.startsWith(`${pending[i].tag} `)) {
          events.push(`< ${line.slice(0, 50)}`);
          pending[i].resolve(line);
          pending.splice(i, 1);
        }
      }
    });
    sock.on("data", (chunk: Uint8Array) => {
      socketBytes += chunk.byteLength;
      socketChunks++;
      if (socketChunks <= 3 || socketChunks % 10 === 0) events.push(`chunk#${socketChunks} total=${socketBytes}`);
      if (rearm && timeoutMs > 0) sock.setTimeout(timeoutMs);
      timeoutListeners = sock.listenerCount("timeout");
    });
    const origWrite = parser.write.bind(parser);
    parser.write = ((chunk: unknown, ...rest: unknown[]) => {
      const ok = (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      if (!ok) writeFalse++;
      return ok;
    }) as typeof parser.write;
    sock.pipe(parser);

    const exec = (cmd: string, label: string) =>
      new Promise<string>((res) => {
        const tag = `A${++tagNo}`;
        pending.push({ tag, resolve: res });
        events.push(`> ${tag} ${label}`);
        sock.write(`${tag} ${cmd}\r\n`);
      });
    sock.on("error", (e: Error) => {
      events.push(`error ${e.message}`);
      finish("error");
    });
    sock.once("secureConnect", async () => {
      events.push("connected");
      await exec(`LOGIN ${JSON.stringify(env.YAHOO_USER ?? "")} ${JSON.stringify(env.YAHOO_APP_PASSWORD ?? "")}`, "LOGIN");
      await exec("SELECT INBOX", "SELECT INBOX");
      await exec("UID SEARCH ALL", "UID SEARCH ALL");
      await exec("LOGOUT", "LOGOUT");
      finish("ok");
    });
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ping") return Response.json({ ok: true, runtime: navigator.userAgent ?? null });
    // Experiment 1: same stalled search, but with the pipe's pause() disabled on imapflow's socket
    // (?patch=1). If it completes, Node-style backpressure is what stops the Workers socket shim.
    // Experiment 3: does setImmediate ever fire under workerd? imapflow awaits it every 10 chunks.
    // Milestone 5 probe: connect + EHLO + AUTH + QUIT over implicit TLS with our own SMTP client. Sends nothing.
    if (url.pathname === "/smtp") {
      const { verifySmtp } = await import("../src/lib/smtp");
      const t = Date.now();
      try {
        const r = await verifySmtp({ YAHOO_USER: env.YAHOO_USER ?? "", YAHOO_APP_PASSWORD: env.YAHOO_APP_PASSWORD ?? "" } as never);
        return Response.json({ ok: r.ok, ehlo: r.ehlo.split(String.fromCharCode(10)).slice(0, 8), ms: Date.now() - t });
      } catch (e) {
        const err = e as { message?: string; code?: string };
        return Response.json({ ok: false, error: err.message, code: err.code, ms: Date.now() - t });
      }
    }

    // Experiment 3: does setImmediate ever fire under workerd? imapflow awaits it every 10 chunks.

    if (url.pathname === "/immediate") {
      const t = Date.now();
      const kind = typeof (globalThis as { setImmediate?: unknown }).setImmediate;
      const result = await Promise.race([
        new Promise<string>((res) => (globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate(() => res("fired"))),
        new Promise<string>((res) => setTimeout(() => res("timeout"), 3000)),
      ]);
      return Response.json({ setImmediate: kind, result, ms: Date.now() - t });
    }

    if (url.pathname === "/pausefix") {
      const log: LogEntry[] = [];
      const out: Record<string, unknown> = { patch: url.searchParams.get("patch") === "1", poly: url.searchParams.get("poly") === "1" };
      if (out.poly) {
        (globalThis as unknown as { setImmediate: unknown }).setImmediate = (fn: (...a: unknown[]) => void, ...a: unknown[]) =>
          setTimeout(fn, 0, ...a);
      }
      out.result = await session(env, log, async (c, step) => {
        const sock = (c as unknown as { socket?: SocketLike }).socket;
        out.socket = sock
          ? { hwm: sock.readableHighWaterMark, flowing: sock.readableFlowing, ctor: sock.constructor?.name }
          : null;
        if (out.patch && sock) {
          sock.pause = () => sock;
          out.patched = true;
        }
        const mb = c.mailbox && typeof c.mailbox === "object" ? c.mailbox : null;
        const next = mb?.uidNext ?? 0;
        const width = Number(url.searchParams.get("width") ?? 20_000);
        step(`search_window_${width}`);
        const { r, ms } = await timed(() => c.search({ uid: `${Math.max(1, next - width)}:*` }, { uid: true }));
        return { count: Array.isArray(r) ? r.length : r, ms };
      }, url.searchParams.get("trace") === "1", url.searchParams.get("nocompress") === "1");
      out.nocompress = url.searchParams.get("nocompress") === "1";
      out.log = log.slice(0, 60);
      return Response.json(out);
    }

    // Experiment 2: no library at all. Raw node:tls socket, LOGIN, SELECT, UID SEARCH ALL (~70 KB line).
    // ?mode=flow reads in flowing mode; ?mode=pause pauses after the first chunk and resumes 100 ms later.
    // Experiment 4: raw socket piped into a Transform that defers its callback like imapflow's
    // parser does (?patch=1 disables pause on the socket). Separates stream machinery from imapflow.
    if (url.pathname === "/rawpipe") {
      return rawPipeProbe(env, {
        patch: url.searchParams.get("patch") === "1",
        deferMs: Number(url.searchParams.get("defer") ?? 0),
        timeoutMs: Number(url.searchParams.get("timeout") ?? 0),
        rearm: url.searchParams.get("rearm") === "1",
        keepAlive: url.searchParams.get("keepalive") === "1",
      });
    }

    if (url.pathname === "/raw") {
      return rawProbe(env, url.searchParams.get("mode") === "pause" ? "pause" : "flow");
    }

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
