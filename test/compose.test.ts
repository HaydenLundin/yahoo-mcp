import { describe, expect, it } from "vitest";
import {
  buildMessage,
  encodeHeaderText,
  foldHeader,
  formatDate,
  parseAddress,
  qpEncode,
  withoutBcc,
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
    // Header folding may break the line after the semicolon; unfolded it is one header.
    expect(msg.replace(/\r\n /g, " ")).toMatch(
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

describe("header encoding keeps whole characters", () => {
  it("never splits a multi-byte character across RFC 2047 encoded words", () => {
    const text = "é".repeat(40) + "日本語テキスト" + "😀".repeat(5);
    const words = encodeHeaderText(text).split(" ");
    expect(words.length).toBeGreaterThan(1);
    const decoded = words.map((w) => {
      const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w);
      expect(m, w).not.toBeNull();
      return Buffer.from(m![1], "base64").toString("utf8");
    });
    for (const piece of decoded) expect(piece).not.toContain("\uFFFD");
    expect(decoded.join("")).toBe(text);
  });

  it("unescapes a quoted display name once and re-escapes it once", () => {
    expect(parseAddress('"Doe, John \\"JD\\"" <j@e.example>')).toEqual({
      name: 'Doe, John "JD"',
      address: "j@e.example",
    });
    const raw = buildMessage({
      from: "me@yahoo.com",
      to: ['"Doe, John \\"JD\\"" <j@e.example>'],
      subject: "x",
      text: "hi",
    });
    const to = raw.split("\r\n").find((l) => l.startsWith("To:"));
    expect(to).toBe('To: "Doe, John \\"JD\\"" <j@e.example>');
  });
});

describe("withoutBcc", () => {
  it("drops the Bcc header, folded continuations included, and nothing else", () => {
    const raw =
      "From: me@yahoo.com\r\nTo: a@x.example\r\nBcc: b@x.example,\r\n c@x.example\r\nSubject: Bcc: not a header\r\n\r\nBody mentions\r\nBcc: in text\r\n";
    expect(withoutBcc(raw)).toBe(
      "From: me@yahoo.com\r\nTo: a@x.example\r\nSubject: Bcc: not a header\r\n\r\nBody mentions\r\nBcc: in text\r\n",
    );
  });

  it("leaves a message without Bcc untouched", () => {
    const raw = buildMessage({ from: "me@yahoo.com", to: ["a@x.example"], subject: "s", text: "t" });
    expect(withoutBcc(raw)).toBe(raw);
  });

  it("strips exactly what buildMessage adds for bcc", () => {
    const withBcc = buildMessage({ from: "me@yahoo.com", to: ["a@x.example"], bcc: ["Hidden <h@x.example>"], subject: "s", text: "t" });
    expect(withBcc).toContain("Bcc: Hidden <h@x.example>\r\n");
    expect(withoutBcc(withBcc)).not.toMatch(/^bcc:/im);
    expect(withoutBcc(withBcc)).toContain("To: a@x.example\r\n");
  });
});

const base = {
  from: "me@yahoo.com",
  to: ["a@b.example"],
  subject: "Re: x",
  text: "y",
  messageId: "<m@yahoo.com>",
  date: new Date(0),
};

describe("threading header hygiene", () => {
  it("drops ids carrying whitespace or control characters instead of putting them on the wire", () => {
    const raw = buildMessage({
      ...base,
      inReplyTo: "<ok@x>\r\nBcc: victim@evil.example",
      references: ["<good@x>", "<bad\nX-Injected: 1@x>", "no-brackets@x", "<also good@x>", "<fine@x>"],
    });
    expect(raw).not.toContain("In-Reply-To:");
    expect(raw).not.toContain("victim@evil.example");
    expect(raw).not.toContain("X-Injected");
    expect(raw).toContain("References: <good@x> <fine@x>\r\n");
  });

  it("caps References at twenty ids, keeping the root and the most recent", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `<r${i}@x>`);
    const raw = buildMessage({ ...base, references: ids });
    const line = /References:((?:.|\r\n )+?)\r\n(?! )/.exec(raw)![1].replace(/\r\n /g, " ").trim();
    const kept = line.split(" ");
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe("<r0@x>");
    expect(kept.at(-1)).toBe("<r29@x>");
    expect(kept[1]).toBe("<r11@x>");
  });
});

describe("foldHeader", () => {
  it("folds at spaces so no line exceeds 78 characters and unfolding restores the value", () => {
    const value = Array.from({ length: 12 }, (_, i) => `<id-number-${i}@example.com>`).join(" ");
    const folded = foldHeader("References", value);
    for (const line of folded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(folded.split("\r\n").length).toBeGreaterThan(1);
    expect(folded.replace(/\r\n /g, " ")).toBe(`References: ${value}`);
  });

  it("leaves a single over-long token whole and short values untouched", () => {
    const token = "x".repeat(120);
    expect(foldHeader("Subject", token)).toBe(`Subject: ${token}`);
    expect(foldHeader("To", "a@b.example")).toBe("To: a@b.example");
  });

  it("is applied by buildMessage to long address lists", () => {
    const to = Array.from({ length: 8 }, (_, i) => `Person Number ${i} <person${i}@example.com>`);
    const raw = buildMessage({ ...base, to });
    const head = raw.split("\r\n\r\n")[0];
    for (const line of head.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
  });
});
