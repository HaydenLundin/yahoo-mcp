import { ImapFlow } from "imapflow";
import type { Env } from "../types";

const YAHOO_IMAP = { host: "imap.mail.yahoo.com", port: 993 } as const;

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
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    const bye = client.logout().catch(() => client.close());
    if (ctx.waitUntil) ctx.waitUntil(bye);
    else await bye;
  }
}

/** Same as withImap but with `path` selected and locked for the duration of fn. */
export async function withMailbox<T>(
  ctx: ImapContext,
  path: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  return withImap(ctx, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}
