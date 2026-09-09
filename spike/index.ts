// Spike: does imapflow run on workerd (Cloudflare Workers, nodejs_compat)?
//
// Stages reported:
//   created                          -> module loaded, ImapFlow constructed
//   tls_and_protocol_ok_auth_failed  -> socket + TLS + IMAP greeting + LOGIN round-trip
//                                       all worked; server rejected credentials.
//                                       (Expected when .dev.vars is absent.)
//   authenticated                    -> LOGIN accepted
//   fetched                          -> mailbox opened, latest envelope fetched
// Any other outcome with an error means the runtime, not Yahoo, broke.
import { ImapFlow } from "imapflow";
import { EventEmitter } from "node:events";

interface Env {
  YAHOO_USER?: string;
  YAHOO_APP_PASSWORD?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Diagnostic: proves module evaluation succeeded without touching IMAP.
    if (url.pathname === "/ping") {
      return Response.json({ ok: true, runtime: navigator.userAgent ?? null, ts: Date.now() });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    // Diagnostic: ?maxl=N raises EventEmitter.defaultMaxListeners before the IMAP session,
    // to test whether the "11 timeout listeners" warning -> process.emitWarning crash is fatal on the edge.
    const maxl = Number(url.searchParams.get("maxl") ?? "0");
    if (maxl > 0) EventEmitter.defaultMaxListeners = maxl;

    const t0 = Date.now();
    const hasCreds = Boolean(env.YAHOO_USER && env.YAHOO_APP_PASSWORD);
    const result: Record<string, unknown> = { hasCreds, stage: "created", maxListeners: EventEmitter.defaultMaxListeners };
    const timings: Record<string, number> = {};
    const mark = (label: string) => (timings[label] = Date.now() - t0);

    const client = new ImapFlow({
      host: "imap.mail.yahoo.com",
      port: 993,
      secure: true,
      auth: {
        user: env.YAHOO_USER ?? "spike-no-creds@yahoo.com",
        pass: env.YAHOO_APP_PASSWORD ?? "not-a-real-password",
      },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    });

    try {
      await client.connect();
      mark("connect_and_auth_ms");
      result.stage = "authenticated";
      result.serverInfo = client.serverInfo ?? null;
      result.capabilities = [...client.capabilities.keys()];

      const lock = await client.getMailboxLock("INBOX");
      mark("select_inbox_ms");
      try {
        const mb = client.mailbox;
        result.mailbox =
          mb && typeof mb === "object"
            ? { exists: mb.exists, uidValidity: String(mb.uidValidity) }
            : null;
        const msg = await client.fetchOne("*", { envelope: true, uid: true });
        mark("fetch_ms");
        result.stage = "fetched";
        // Prove parsing works without echoing mailbox content into logs.
        result.latest = msg
          ? {
              uid: msg.uid,
              date: msg.envelope?.date ?? null,
              subjectLength: msg.envelope?.subject?.length ?? 0,
              hasFrom: Boolean(msg.envelope?.from?.length),
            }
          : null;
      } finally {
        lock.release();
      }
      await client.logout();
      mark("logout_ms");
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      result.error = {
        message: e?.message,
        code: e?.code,
        authenticationFailed: e?.authenticationFailed,
        responseText: e?.responseText,
        serverResponseCode: e?.serverResponseCode,
        stack: String(e?.stack ?? "").split("\n").slice(0, 10),
      };
      if (e?.authenticationFailed) result.stage = "tls_and_protocol_ok_auth_failed";
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }

    result.ms = Date.now() - t0;
    result.timings = timings;
    return Response.json(result);
  },
};
