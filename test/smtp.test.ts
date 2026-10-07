import { describe, expect, it } from "vitest";
import { dotStuff, sendRaw, verifySmtp } from "../src/lib/smtp";
import { scriptedConnector, type ScriptStep } from "./helpers/fake-smtp";
import { makeEnv, FakeD1 } from "./helpers/harness";

const env = makeEnv(new FakeD1(), {
  YAHOO_USER: "me@yahoo.com",
  YAHOO_APP_PASSWORD: "secret16charsxxx",
});
const PLAIN = Buffer.from("\u0000me@yahoo.com\u0000secret16charsxxx").toString(
  "base64",
);

const RAW =
  "From: me@yahoo.com\r\nTo: a@b.example\r\nSubject: Hi\r\nMessage-ID: <abc@yahoo.com>\r\n\r\nHello\r\n.leading dot\r\n";

function happyScript(extra: ScriptStep[] = []): ScriptStep[] {
  return [
    {
      expect: "EHLO yahoo-mcp.workers.dev",
      reply:
        "250-smtp.mail.yahoo.com\r\n250-PIPELINING\r\n250-SIZE 41697280\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n",
    },
    {
      expect: `AUTH PLAIN ${PLAIN}`,
      reply: "235 2.7.0 Authentication successful\r\n",
    },
    { expect: "MAIL FROM:<me@yahoo.com>", reply: "250 OK\r\n" },
    { expect: "RCPT TO:<a@b.example>", reply: "250 OK\r\n" },
    { expect: "DATA", reply: "354 Start mail input\r\n" },
    { expect: /^From: me@yahoo\.com\r\n/, reply: "250 OK , completed\r\n" },
    { expect: "QUIT", reply: "221 Bye\r\n" },
    ...extra,
  ];
}

describe("dotStuff", () => {
  it("doubles leading dots, normalises to CRLF, and guarantees a final CRLF", () => {
    expect(dotStuff("a\n.b\r\n..c")).toBe("a\r\n..b\r\n...c\r\n");
    expect(dotStuff("x\r\n")).toBe("x\r\n");
  });
});

describe("sendRaw", () => {
  it("speaks the whole conversation and reports accepted recipients and our Message-ID", async () => {
    const { connector, sockets } = scriptedConnector(
      "220 smtp.mail.yahoo.com ESMTP ready",
      happyScript(),
    );
    const result = await sendRaw(
      env,
      { from: "me@yahoo.com", to: ["a@b.example"] },
      RAW,
      connector,
    );
    expect(result).toEqual({
      messageId: "<abc@yahoo.com>",
      accepted: ["a@b.example"],
      rejected: [],
      response: "OK , completed",
    });
    const written = sockets[0].written;
    expect(written[0]).toBe("EHLO yahoo-mcp.workers.dev\r\n");
    expect(written[1]).toBe(`AUTH PLAIN ${PLAIN}\r\n`);
    expect(written[2]).toBe("MAIL FROM:<me@yahoo.com>\r\n");
    expect(written[3]).toBe("RCPT TO:<a@b.example>\r\n");
    expect(written[4]).toBe("DATA\r\n");
    expect(written[5]).toBe(`${RAW.replace(".leading", "..leading")}.\r\n`);
    expect(written[6]).toBe("QUIT\r\n");
    expect(sockets[0].destroyed).toBe(true);
  });

  it("handles multi-line replies split across data chunks", async () => {
    const script = happyScript();
    script[0] = {
      expect: "EHLO",
      reply: "250-smtp.mail.yahoo.com\r\n250-PIPE|LINING\r\n250 AUTH PLAIN\r\n",
    };
    const { connector } = scriptedConnector("220 ready", script);
    await expect(
      sendRaw(
        env,
        { from: "me@yahoo.com", to: ["a@b.example"] },
        RAW,
        connector,
      ),
    ).resolves.toMatchObject({ accepted: ["a@b.example"] });
  });

  it("maps an authentication failure", async () => {
    const script = happyScript();
    script[1] = {
      expect: "AUTH PLAIN",
      reply: "535 5.7.0 (#AUTH005) Too many bad auth attempts.\r\n",
    };
    const { connector } = scriptedConnector("220 ready", script);
    await expect(
      sendRaw(
        env,
        { from: "me@yahoo.com", to: ["a@b.example"] },
        RAW,
        connector,
      ),
    ).rejects.toMatchObject({
      code: "SMTP_AUTH_FAILED",
      message: expect.stringContaining("Too many bad auth attempts"),
    });
  });

  it("continues when one recipient is refused and fails when all are", async () => {
    const script = happyScript([
      {
        expect: "RCPT TO:<bad@b.example>",
        reply: "550 5.1.1 No such user\r\n",
      },
    ]);
    const { connector } = scriptedConnector("220 ready", script);
    const partial = await sendRaw(
      env,
      { from: "me@yahoo.com", to: ["bad@b.example", "a@b.example"] },
      RAW,
      connector,
    );
    expect(partial.accepted).toEqual(["a@b.example"]);
    expect(partial.rejected).toEqual(["bad@b.example: 5.1.1 No such user"]);

    const all = scriptedConnector("220 ready", [
      ...happyScript().slice(0, 3),
      {
        expect: "RCPT TO:<bad@b.example>",
        reply: "553 5.7.1 Relaying denied\r\n",
      },
    ]);
    await expect(
      sendRaw(
        env,
        { from: "me@yahoo.com", to: ["bad@b.example"] },
        RAW,
        all.connector,
      ),
    ).rejects.toMatchObject({
      code: "SMTP_RECIPIENT_REJECTED",
    });
    expect(all.sockets[0].written.some((w) => w.startsWith("DATA"))).toBe(
      false,
    );
  });

  it("maps a rejected message body and a socket error", async () => {
    const script = happyScript();
    script[5] = {
      expect: /^From:/,
      reply: "554 5.7.9 Message not accepted for policy reasons\r\n",
    };
    const { connector } = scriptedConnector("220 ready", script);
    await expect(
      sendRaw(
        env,
        { from: "me@yahoo.com", to: ["a@b.example"] },
        RAW,
        connector,
      ),
    ).rejects.toMatchObject({
      code: "SMTP_MESSAGE_REJECTED",
      message: expect.stringContaining("policy reasons"),
    });

    const closing = scriptedConnector("220 ready", [{ expect: "EHLO", reply: "" }]);
    const p = sendRaw(
      env,
      { from: "me@yahoo.com", to: ["a@b.example"] },
      RAW,
      closing.connector,
    );
    await new Promise((r) => setTimeout(r, 0));
    closing.sockets[0].emit("error", new Error("ECONNRESET"));
    await expect(p).rejects.toMatchObject({ code: "SMTP_CONNECT_FAILED" });
  });
});

describe("verifySmtp", () => {
  it("logs in and quits without sending anything", async () => {
    const { connector, sockets } = scriptedConnector(
      "220 smtp.mail.yahoo.com ESMTP ready",
      happyScript(),
    );
    const r = await verifySmtp(env, connector);
    expect(r.ok).toBe(true);
    expect(r.ehlo).toContain("AUTH PLAIN LOGIN");
    expect(sockets[0].written.map((w) => w.split(" ")[0].trim())).toEqual([
      "EHLO",
      "AUTH",
      "QUIT",
    ]);
  });
});
