import { describe, expect, it } from "vitest";
import {
  buildMessage,
  encodeHeaderText,
  formatDate,
  parseAddress,
  qpEncode,
} from "../src/lib/compose";

describe("parseAddress", () => {
  it("accepts bare addresses and display-name forms", () => {
    expect(parseAddress("a@b.example")).toEqual({ address: "a@b.example" });
    expect(parseAddress("Sam Lee <sam@b.example>")).toEqual({
      name: "Sam Lee",
      address: "sam@b.example",
    });
    expect(parseAddress('"Lee, Sam" <sam@b.example>')).toEqual({
      name: "Lee, Sam",
      address: "sam@b.example",
    });
  });

  it("rejects things that are not addresses with a stable code", () => {
    for (const bad of [
      "sam",
      "sam@",
      "@b.example",
      "Sam <nope>",
      "a b@c.example",
    ]) {
      expect(() => parseAddress(bad)).toThrowError(
        /INVALID_ARGUMENT|Not a valid email address/,
      );
    }
  });
});

describe("qpEncode", () => {
  it("keeps printable ASCII, encodes 8-bit and '=', and soft-wraps at 76", () => {
    expect(qpEncode("plain text = fine")).toBe("plain text =3D fine");
    expect(qpEncode("café")).toBe("caf=C3=A9");
    const long = qpEncode("x".repeat(200));
    for (const line of long.split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(76);
    expect(long.replace(/=\r\n/g, "")).toBe("x".repeat(200));
  });

  it("normalises line endings to CRLF and protects trailing whitespace", () => {
    expect(qpEncode("a\nb\r\nc ")).toBe("a\r\nb\r\nc=20");
  });
});

describe("encodeHeaderText and formatDate", () => {
  it("leaves ASCII alone and RFC 2047 encodes everything else", () => {
    expect(encodeHeaderText("Lease renewal")).toBe("Lease renewal");
    expect(encodeHeaderText("Résumé")).toBe(
      `=?UTF-8?B?${Buffer.from("Résumé").toString("base64")}?=`,
    );
  });

  it("formats RFC 5322 dates in UTC", () => {
    expect(formatDate(new Date("2026-10-07T13:05:09Z"))).toBe(
      "Wed, 07 Oct 2026 13:05:09 +0000",
    );
  });
});

describe("buildMessage", () => {
  const base = {
    from: "me@yahoo.com",
    to: ["Sam <sam@example.com>"],
    subject: "Hello",
    text: "Hi Sam,\n\nSee you Thursday.\n",
    date: new Date("2026-10-07T13:05:09Z"),
    messageId: "<fixed@yahoo.com>",
  };

  it("renders a plain-text message with CRLF endings and the expected headers", () => {
    const msg = buildMessage(base);
    expect(msg).not.toMatch(/[^\r]\n/);
    const sep = msg.indexOf("\r\n\r\n");
    const head = msg.slice(0, sep);
    const body = msg.slice(sep + 4);
    expect(head.split("\r\n")).toEqual([
      "From: me@yahoo.com",
      "To: Sam <sam@example.com>",
      "Subject: Hello",
      "Date: Wed, 07 Oct 2026 13:05:09 +0000",
      "Message-ID: <fixed@yahoo.com>",
      "MIME-Version: 1.0",
      "X-Mailer: yahoo-mcp",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
    ]);
    expect(body).toBe("Hi Sam,\r\n\r\nSee you Thursday.\r\n\r\n");
  });

  it("adds Cc, Bcc, threading headers, and a multipart/alternative body when html is given", () => {
    const msg = buildMessage({
      ...base,
      cc: ["cc@example.com"],
      bcc: ["hidden@example.com"],
      html: "<p>Hi <b>Sam</b></p>",
      inReplyTo: "<orig@example.com>",
      references: ["<root@example.com>", "<orig@example.com>"],
    });
    expect(msg).toContain("Cc: cc@example.com\r\n");
    expect(msg).toContain("Bcc: hidden@example.com\r\n");
    expect(msg).toContain("In-Reply-To: <orig@example.com>\r\n");
    expect(msg).toContain(
      "References: <root@example.com> <orig@example.com>\r\n",
    );
    expect(msg).toMatch(
      /Content-Type: multipart\/alternative; boundary="[^"]+"\r\n/,
    );
    expect(msg).toContain("Content-Type: text/plain; charset=utf-8\r\n");
    expect(msg).toContain("Content-Type: text/html; charset=utf-8\r\n");
    expect(msg).toContain("<p>Hi <b>Sam</b></p>");
    expect(msg.trimEnd().endsWith("--")).toBe(true);
  });

  it("encodes non-ASCII subjects and names, and refuses an empty recipient list", () => {
    const msg = buildMessage({
      ...base,
      to: ["Zoë <zoe@example.com>"],
      subject: "Café ☕",
    });
    expect(msg).toContain("To: =?UTF-8?B?");
    expect(msg).toContain("Subject: =?UTF-8?B?");
    expect(() => buildMessage({ ...base, to: [] })).toThrowError(
      /At least one recipient/,
    );
  });

  it("generates a Message-ID on the sender's domain and a current Date when not supplied", () => {
    const msg = buildMessage({
      from: "me@yahoo.com",
      to: ["a@b.example"],
      subject: "s",
      text: "t",
    });
    expect(msg).toMatch(/Message-ID: <[0-9a-f-]{36}@yahoo\.com>\r\n/);
    expect(msg).toMatch(
      /Date: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000\r\n/,
    );
  });
});
