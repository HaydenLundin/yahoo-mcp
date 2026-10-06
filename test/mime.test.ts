import { describe, expect, it } from "vitest";
import {
  decodeBody,
  decodeCharset,
  decodeEntities,
  decodeTransfer,
  formatAddress,
  htmlToText,
  listAttachments,
  parseHeaderBlock,
  selectBodyParts,
  splitMessageIds,
  truncateText,
} from "../src/lib/mime";
import {
  MSG_HUGE,
  MSG_LATIN1,
  MSG_MIXED,
  MSG_PLAIN,
  MSG_REPLY,
} from "./helpers/fixtures";

describe("selectBodyParts", () => {
  it("addresses a single-part message as part 1 and carries its encoding and charset", () => {
    expect(selectBodyParts(MSG_PLAIN.structure)).toEqual({
      text: { id: "1", mime: "text/plain", encoding: "7bit", charset: "utf-8" },
    });
    expect(selectBodyParts(MSG_LATIN1.structure).text).toMatchObject({
      id: "1",
      encoding: "8bit",
      charset: "iso-8859-1",
    });
  });

  it("finds text and html inside multipart/alternative and ignores attachments", () => {
    const parts = selectBodyParts(MSG_MIXED.structure);
    expect(parts.text).toMatchObject({ id: "1.1", mime: "text/plain" });
    expect(parts.html).toMatchObject({
      id: "1.2",
      mime: "text/html",
      encoding: "quoted-printable",
    });
  });

  it("returns html only when that is all there is", () => {
    const parts = selectBodyParts(MSG_REPLY.structure);
    expect(parts.text).toBeUndefined();
    expect(parts.html).toMatchObject({ id: "1" });
  });

  it("tolerates a missing structure", () => {
    expect(selectBodyParts(undefined)).toEqual({});
  });
});

describe("listAttachments", () => {
  it("reports attachment and inline non-text parts with names, types, sizes", () => {
    expect(listAttachments(MSG_MIXED.structure)).toEqual([
      { filename: "invoice-0042.pdf", mime: "application/pdf", size: 48_211 },
      { filename: "logo.png", mime: "image/png", size: 2_048 },
    ]);
  });

  it("reports nothing for text-only messages", () => {
    expect(listAttachments(MSG_PLAIN.structure)).toEqual([]);
    expect(listAttachments(MSG_REPLY.structure)).toEqual([]);
  });
});

describe("transfer and charset decoding", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("decodes quoted-printable escapes and soft line breaks", () => {
    const decoded = decodeTransfer(
      bytes("caf=C3=A9 =3D ok, split wo=\r\nrd"),
      "quoted-printable",
    );
    expect(new TextDecoder().decode(decoded)).toBe("café = ok, split word");
  });

  it("decodes base64 across line breaks and ignores stray whitespace", () => {
    const b64 = Buffer.from("hello, world")
      .toString("base64")
      .replace(/(.{4})/g, "$1\r\n");
    expect(new TextDecoder().decode(decodeTransfer(bytes(b64), "base64"))).toBe(
      "hello, world",
    );
  });

  it("passes 7bit and 8bit through untouched", () => {
    const raw = bytes("plain");
    expect(decodeTransfer(raw, "7bit")).toBe(raw);
    expect(decodeTransfer(raw, undefined)).toBe(raw);
  });

  it("decodes legacy charsets through iconv and falls back to utf-8 for unknown labels", () => {
    expect(
      decodeCharset(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), "iso-8859-1"),
    ).toBe("café");
    expect(
      decodeCharset(Uint8Array.from([0x93, 0x68, 0x69, 0x94]), "windows-1252"),
    ).toBe("“hi”");
    expect(decodeCharset(bytes("ok"), "x-unknown-charset-42")).toBe("ok");
  });

  it("decodes a whole fixture body the way the tools will", () => {
    const part = selectBodyParts(MSG_LATIN1.structure).text!;
    expect(decodeBody(MSG_LATIN1.parts!["1"] as Uint8Array, part)).toBe("café");
    const huge = selectBodyParts(MSG_HUGE.structure).text!;
    expect(decodeBody(bytes(MSG_HUGE.parts!["1"] as string), huge)).toBe(
      "x".repeat(60_000),
    );
  });
});

describe("htmlToText", () => {
  it("drops scripts and styles, keeps line structure, decodes entities", () => {
    const text = htmlToText(
      '<div class="r">Got it &amp; paid.<br>Thanks!</div><script>alert(1)</script><style>p{}</style>',
    );
    expect(text).toBe("Got it & paid.\nThanks!");
  });

  it("turns lists and paragraphs into lines and keeps link targets", () => {
    const text = htmlToText(
      '<p>Hello</p><ul><li>One</li><li>Two</li></ul><p>See <a href="https://x.example/a">the page</a>.</p>',
    );
    expect(text).toBe(
      "Hello\n\n- One\n- Two\n\nSee the page (https://x.example/a).",
    );
  });

  it("treats source whitespace as spaces, not layout", () => {
    expect(htmlToText("<div>a   b</div>\n\n\n\n<div>c</div>")).toBe("a b\nc");
  });
});

describe("decodeEntities", () => {
  it("handles named, decimal, and hex entities and leaves unknown ones alone", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&#39;&#x41;&nbsp;&bogus;")).toBe(
      "&<>\"'A &bogus;",
    );
  });
});

describe("truncateText", () => {
  it("passes short text through and marks long text", () => {
    expect(truncateText("abc", 10)).toEqual({ text: "abc", truncated: false });
    const r = truncateText("x".repeat(20), 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("xxxxxxxxxx\n[... truncated")).toBe(true);
  });
});

describe("headers", () => {
  it("unfolds continuation lines and lowercases names", () => {
    const h = parseHeaderBlock(MSG_REPLY.headers);
    expect(h["message-id"]).toBe("<c1@yahoo.com>");
    expect(h.references).toBe("<b1@vendor.example> <x0@vendor.example>");
    expect(splitMessageIds(h.references)).toEqual([
      "<b1@vendor.example>",
      "<x0@vendor.example>",
    ]);
  });

  it("accepts bytes as well as strings", () => {
    expect(
      parseHeaderBlock(new TextEncoder().encode("X-A: 1\r\nX-B: two\r\n")),
    ).toEqual({ "x-a": "1", "x-b": "two" });
    expect(parseHeaderBlock(undefined)).toEqual({});
  });
});

describe("formatAddress", () => {
  it("renders name and address, or just the address", () => {
    expect(formatAddress({ name: "Pat", address: "pat@x.example" })).toBe(
      "Pat <pat@x.example>",
    );
    expect(formatAddress({ address: "pat@x.example" })).toBe("pat@x.example");
    expect(
      formatAddress({ name: "pat@x.example", address: "pat@x.example" }),
    ).toBe("pat@x.example");
  });
});
