import { EventEmitter } from "node:events";
import type {
  Connector,
  Envelope,
  SendResult,
  SmtpSocket,
} from "../../src/lib/smtp";
import type { Env } from "../../src/types";

/** Stand-in for the whole sendRaw(): records calls, can fail on demand. Used by the tool tests. */
export class FakeSmtp {
  static sent: Array<{ envelope: Envelope; raw: string }> = [];
  static failNext: Error | null = null;

  static reset(): void {
    FakeSmtp.sent = [];
    FakeSmtp.failNext = null;
  }

  static async sendRaw(
    _env: Env,
    envelope: Envelope,
    raw: string,
  ): Promise<SendResult> {
    if (FakeSmtp.failNext) {
      const err = FakeSmtp.failNext;
      FakeSmtp.failNext = null;
      throw err;
    }
    FakeSmtp.sent.push({ envelope, raw });
    const m = /^Message-ID:\s*(<[^>]+>)/im.exec(raw);
    return {
      messageId: m ? m[1] : null,
      accepted: envelope.to,
      rejected: [],
      response: "OK queued",
    };
  }
}

export interface ScriptStep {
  /** Matched against the start of the client's command line (without CRLF). */
  expect: string | RegExp;
  reply: string;
}

/**
 * Scripted SMTP server behind a socket-shaped object, for testing the real client.
 * Replies are delivered asynchronously, like network data would be.
 */
export class FakeSmtpSocket extends EventEmitter implements SmtpSocket {
  written: string[] = [];
  destroyed = false;

  constructor(
    private greeting: string,
    private script: ScriptStep[],
  ) {
    super();
    queueMicrotask(() => this.emit("data", `${greeting}\r\n`));
  }

  write(data: string): boolean {
    this.written.push(data);
    const line = data.endsWith("\r\n") ? data.slice(0, -2) : data;
    const step = this.script.find((s) =>
      typeof s.expect === "string"
        ? line.startsWith(s.expect)
        : s.expect.test(line),
    );
    if (!step) {
      queueMicrotask(() =>
        this.emit("data", "500 5.5.1 Unrecognized command\r\n"),
      );
      return true;
    }
    this.script.splice(this.script.indexOf(step), 1);
    const chunks = step.reply.split("|");
    queueMicrotask(() => {
      for (const c of chunks) this.emit("data", c);
    });
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

export function scriptedConnector(
  greeting: string,
  script: ScriptStep[],
): { connector: Connector; sockets: FakeSmtpSocket[] } {
  const sockets: FakeSmtpSocket[] = [];
  return {
    connector: () => {
      const s = new FakeSmtpSocket(
        greeting,
        script.map((x) => ({ ...x })),
      );
      sockets.push(s);
      return s;
    },
    sockets,
  };
}
