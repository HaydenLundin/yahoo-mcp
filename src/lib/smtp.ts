import { Buffer } from "node:buffer";
import { connect as tlsConnect } from "node:tls";
import { ToolError } from "./errors";
import type { Env } from "../types";

/**
 * A deliberately small SMTP client: EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT over
 * implicit TLS on port 465. nodemailer could not open a connection from Workers (local or edge)
 * while raw node:tls to the same port works, and the IMAP side already proved node:tls on
 * workerd; this keeps the sending path on that proven primitive and out of a 1 MB dependency.
 * The message itself is rendered by compose.ts, so all this has to do is speak the protocol.
 */
const YAHOO_SMTP = { host: "smtp.mail.yahoo.com", port: 465 } as const;
const EHLO_NAME = "yahoo-mcp.workers.dev";
const STEP_TIMEOUT_MS = 30_000;

export interface Envelope {
  from: string;
  to: string[];
}

export interface SendResult {
  messageId: string | null;
  accepted: string[];
  rejected: string[];
  response: string;
}

/** The slice of a socket the session needs; node:tls sockets satisfy it and tests pass a scripted fake. */
export interface SmtpSocket {
  on(event: "data", cb: (chunk: Uint8Array | string) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  write(data: string): unknown;
  destroy(): unknown;
}

export type Connector = (host: string, port: number) => SmtpSocket;

const defaultConnector: Connector = (host, port) =>
  tlsConnect({ host, port, servername: host }) as unknown as SmtpSocket;

export interface Reply {
  code: number;
  text: string;
}

export async function sendRaw(
  env: Env,
  envelope: Envelope,
  raw: string,
  connector: Connector = defaultConnector,
): Promise<SendResult> {
  const session = SmtpSession.open(connector, YAHOO_SMTP.host, YAHOO_SMTP.port);
  try {
    await login(session, env);
    await session.command(
      `MAIL FROM:<${envelope.from}>`,
      [250],
      (r) =>
        new ToolError(
          "SMTP_MESSAGE_REJECTED",
          `Yahoo rejected the sender. Server said: ${r.text}`,
        ),
    );
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const rcpt of envelope.to) {
      const r = await session.command(`RCPT TO:<${rcpt}>`, null);
      if (r.code === 250 || r.code === 251) accepted.push(rcpt);
      else rejected.push(`${rcpt}: ${r.text}`);
    }
    if (accepted.length === 0) {
      throw new ToolError(
        "SMTP_RECIPIENT_REJECTED",
        `Yahoo rejected every recipient. ${rejected.join("; ")}`,
      );
    }
    await session.command(
      "DATA",
      [354],
      (r) =>
        new ToolError(
          "SMTP_MESSAGE_REJECTED",
          `Yahoo refused the message data. Server said: ${r.text}`,
        ),
    );
    const final = await session.command(
      `${dotStuff(raw)}.`,
      [250],
      (r) =>
        new ToolError(
          "SMTP_MESSAGE_REJECTED",
          `Yahoo rejected the message. Server said: ${r.text}`,
        ),
    );
    await session.command("QUIT", null).catch(() => undefined);
    return {
      messageId: extractMessageId(raw),
      accepted,
      rejected,
      response: final.text,
    };
  } finally {
    session.close();
  }
}

/** Connect, EHLO, AUTH, QUIT. Proves credentials and reachability without sending anything. */
export async function verifySmtp(
  env: Env,
  connector: Connector = defaultConnector,
): Promise<{ ok: true; ehlo: string }> {
  const session = SmtpSession.open(connector, YAHOO_SMTP.host, YAHOO_SMTP.port);
  try {
    const ehlo = await login(session, env);
    await session.command("QUIT", null).catch(() => undefined);
    return { ok: true, ehlo };
  } finally {
    session.close();
  }
}

async function login(session: SmtpSession, env: Env): Promise<string> {
  await session.reply(
    [220],
    (r) =>
      new ToolError(
        "SMTP_CONNECT_FAILED",
        `Yahoo SMTP did not greet us. Server said: ${r.text}`,
      ),
  );
  const ehlo = await session.command(`EHLO ${EHLO_NAME}`, [250]);
  const plain = Buffer.from(
    `\u0000${env.YAHOO_USER}\u0000${env.YAHOO_APP_PASSWORD}`,
    "utf8",
  ).toString("base64");
  await session.command(
    `AUTH PLAIN ${plain}`,
    [235],
    (r) =>
      new ToolError(
        "SMTP_AUTH_FAILED",
        `Yahoo SMTP rejected the app password. Server said: ${r.text}`,
      ),
  );
  return ehlo.text;
}

/**
 * One SMTP conversation. Replies are parsed per RFC 5321: continuation lines "250-text",
 * final line "250 text". Every wait is bounded by STEP_TIMEOUT_MS.
 */
export class SmtpSession {
  private buffer = "";
  private lines: string[] = [];
  private waiter: {
    resolve: (r: Reply) => void;
    reject: (e: Error) => void;
  } | null = null;
  private failure: Error | null = null;
  private closed = false;

  static open(connector: Connector, host: string, port: number): SmtpSession {
    return new SmtpSession(connector(host, port));
  }

  private constructor(private readonly socket: SmtpSocket) {
    socket.on("data", (chunk) =>
      this.onData(
        typeof chunk === "string"
          ? chunk
          : new TextDecoder("latin1").decode(chunk),
      ),
    );
    socket.on("error", (err) =>
      this.fail(
        new ToolError(
          "SMTP_CONNECT_FAILED",
          `Yahoo SMTP connection error: ${err.message}`,
        ),
      ),
    );
    socket.on("close", () => {
      if (!this.closed)
        this.fail(
          new ToolError(
            "SMTP_CONNECT_FAILED",
            "Yahoo SMTP closed the connection",
          ),
        );
    });
  }

  /** Send one command (or the DATA payload) and wait for the complete reply. */
  async command(
    line: string,
    okCodes: number[] | null,
    onFail?: (r: Reply) => Error,
  ): Promise<Reply> {
    if (this.failure) throw this.failure;
    this.socket.write(`${line}\r\n`);
    return this.reply(okCodes, onFail);
  }

  /** Wait for the next complete reply; throw unless its code is in okCodes (null accepts anything). */
  async reply(
    okCodes: number[] | null,
    onFail?: (r: Reply) => Error,
  ): Promise<Reply> {
    const r = await this.next();
    if (okCodes && !okCodes.includes(r.code)) {
      throw (
        onFail?.(r) ??
        new ToolError(
          "SMTP_FAILED",
          `Unexpected SMTP reply ${r.code}: ${r.text}`,
        )
      );
    }
    return r;
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  private next(): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    const ready = this.takeReply();
    if (ready) return Promise.resolve(ready);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(
          new ToolError(
            "SMTP_CONNECT_FAILED",
            "Timed out waiting for Yahoo SMTP",
          ),
        );
      }, STEP_TIMEOUT_MS);
      this.waiter = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  private onData(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\r\n")) >= 0) {
      this.lines.push(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx + 2);
    }
    if (this.waiter) {
      const r = this.takeReply();
      if (r) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(r);
      }
    }
  }

  /** Pull one complete reply off the line queue, or null if the final line has not arrived. */
  private takeReply(): Reply | null {
    const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end < 0) return null;
    const replyLines = this.lines.splice(0, end + 1);
    const code = Number(replyLines[end].slice(0, 3));
    const text = replyLines
      .map((l) => l.slice(4).trim())
      .filter(Boolean)
      .join("\n");
    return { code, text };
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }
}

/** RFC 5321 section 4.5.2: a line starting with "." gets a second "."; CRLF endings; final CRLF. */
export function dotStuff(raw: string): string {
  const normalized = raw.replace(/\r?\n/g, "\r\n");
  const stuffed = normalized
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");
  return stuffed.endsWith("\r\n") ? stuffed : `${stuffed}\r\n`;
}

function extractMessageId(raw: string): string | null {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? "";
  const m = /^Message-ID:\s*(<[^>]+>)/im.exec(head);
  return m ? m[1] : null;
}
