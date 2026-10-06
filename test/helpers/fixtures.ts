import type { MessageStructureObject } from "imapflow";
import type { FakeFolder, FakeMessage } from "./fake-imap";

const plain = (
  part?: string,
  extra: Partial<MessageStructureObject> = {},
): MessageStructureObject => ({
  part,
  type: "text/plain",
  encoding: "7bit",
  size: 100,
  parameters: { charset: "utf-8" },
  ...extra,
});
const html = (
  part: string,
  encoding = "quoted-printable",
): MessageStructureObject => ({
  part,
  type: "text/html",
  encoding,
  size: 300,
  parameters: { charset: "utf-8" },
});

export const MSG_PLAIN: FakeMessage = {
  uid: 101,
  flags: ["\\Seen"],
  size: 1200,
  threadId: "T-solo",
  envelope: {
    date: new Date("2026-09-01T10:00:00Z"),
    subject: "Lease renewal",
    messageId: "<a1@landlord.example>",
    from: [{ name: "Property Manager", address: "pm@landlord.example" }],
    to: [{ address: "me@yahoo.com" }],
  },
  structure: plain(),
  headers: "Message-ID: <a1@landlord.example>\r\nSubject: Lease renewal\r\n",
  parts: { "1": "Hi,\n\nYour lease is up for renewal on October 1.\n\nThanks" },
  internalDate: new Date("2026-09-01T10:00:05Z"),
};

export const MSG_MIXED: FakeMessage = {
  uid: 102,
  flags: [],
  size: 54_000,
  threadId: "T-1",
  envelope: {
    date: new Date("2026-09-02T09:00:00Z"),
    subject: "Invoice attached",
    messageId: "<b1@vendor.example>",
    from: [{ name: "Vendor Billing", address: "billing@vendor.example" }],
    to: [{ name: "Me", address: "me@yahoo.com" }],
    cc: [{ address: "cc@vendor.example" }],
  },
  structure: {
    type: "multipart/mixed",
    childNodes: [
      {
        type: "multipart/alternative",
        childNodes: [plain("1.1"), html("1.2")],
      },
      {
        part: "2",
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "invoice-0042.pdf" },
        size: 48_211,
      },
      {
        part: "3",
        type: "image/png",
        disposition: "inline",
        parameters: { name: "logo.png" },
        size: 2_048,
      },
    ],
  },
  headers: "Message-ID: <b1@vendor.example>\r\n",
  parts: {
    "1.1": "Please find invoice 0042 attached.",
    // quoted-printable with nothing to decode: identity
    "1.2":
      "<html><body><p>Please find <b>invoice 0042</b> attached.</p></body></html>",
  },
  internalDate: new Date("2026-09-02T09:00:01Z"),
};

export const MSG_REPLY: FakeMessage = {
  uid: 103,
  flags: ["\\Seen", "\\Flagged"],
  size: 2_000,
  threadId: "T-1",
  envelope: {
    date: new Date("2026-09-03T12:00:00Z"),
    subject: "Re: Invoice attached",
    messageId: "<c1@yahoo.com>",
    inReplyTo: "<b1@vendor.example>",
    from: [{ address: "me@yahoo.com" }],
    to: [{ address: "billing@vendor.example" }],
  },
  structure: html("1"),
  headers:
    "Message-ID: <c1@yahoo.com>\r\nIn-Reply-To: <b1@vendor.example>\r\nReferences: <b1@vendor.example>\r\n <x0@vendor.example>\r\n",
  parts: {
    // quoted-printable as Yahoo would send it: an =3D escape and a soft line break inside "alert"
    "1": '<div class=3D"r">Got it &amp; paid.<br>Thanks!</div><script>al=\r\nert(1)</script><style>p{}</style>',
  },
  internalDate: new Date("2026-09-03T12:00:01Z"),
};

/** 60,000 characters, base64 transfer-encoded like a large plain-text newsletter would be. */
export const MSG_HUGE: FakeMessage = {
  uid: 104,
  flags: [],
  size: 90_000,
  envelope: {
    date: new Date("2026-09-04T08:00:00Z"),
    subject: "Newsletter",
    messageId: "<d1@news.example>",
    from: [{ name: "Newsletter", address: "news@news.example" }],
    to: [{ address: "me@yahoo.com" }],
  },
  structure: plain(undefined, { encoding: "base64" }),
  headers: "Message-ID: <d1@news.example>\r\n",
  parts: {
    "1": Buffer.from("x".repeat(60_000), "utf8")
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n"),
  },
  internalDate: new Date("2026-09-04T08:00:01Z"),
};

/** Latin-1 body ("café"), 8bit, to prove charset decoding goes through iconv. Lives in Archive. */
export const MSG_LATIN1: FakeMessage = {
  uid: 105,
  flags: ["\\Seen"],
  size: 400,
  envelope: {
    date: new Date("2026-08-01T08:00:00Z"),
    subject: "Old note",
    messageId: "<e1@old.example>",
    from: [{ address: "old@old.example" }],
    to: [{ address: "me@yahoo.com" }],
  },
  structure: plain(undefined, {
    encoding: "8bit",
    parameters: { charset: "iso-8859-1" },
  }),
  headers: "Message-ID: <e1@old.example>\r\n",
  parts: { "1": Uint8Array.from([0x63, 0x61, 0x66, 0xe9]) },
  internalDate: new Date("2026-08-01T08:00:01Z"),
};

export const DRAFT_1: FakeMessage = {
  uid: 7,
  flags: ["\\Draft"],
  size: 300,
  envelope: {
    date: new Date("2026-09-05T08:00:00Z"),
    subject: "Draft to Sam",
    to: [{ address: "sam@example.com" }],
  },
  structure: plain(),
  parts: { "1": "draft body" },
};

export const DRAFT_2: FakeMessage = {
  uid: 9,
  flags: ["\\Draft"],
  size: 300,
  envelope: {
    date: new Date("2026-09-06T08:00:00Z"),
    subject: "Newer draft",
    to: [{ address: "maris@example.com" }],
  },
  structure: plain(),
  parts: { "1": "newer draft body" },
};

export function yahooFolders(): FakeFolder[] {
  return [
    { path: "INBOX", messages: [MSG_PLAIN, MSG_MIXED, MSG_REPLY, MSG_HUGE] },
    { path: "Sent", specialUse: "\\Sent", messages: [] },
    { path: "Draft", specialUse: "\\Drafts", messages: [DRAFT_1, DRAFT_2] },
    { path: "Archive", specialUse: "\\Archive", messages: [MSG_LATIN1] },
    { path: "Bulk", specialUse: "\\Junk", messages: [] },
    { path: "Trash", specialUse: "\\Trash", messages: [] },
  ];
}

/**
 * A folder large enough to need several SEARCH_WINDOW windows. Every 777th message is a
 * "Needle" (uids 1000, 1777, 2554, 3331 for n = 2500); the rest are "Bulk mail N".
 */
export function bigFolder(n = 2500): FakeFolder {
  const messages: FakeMessage[] = [];
  for (let i = 0; i < n; i++) {
    const needle = i % 777 === 0;
    messages.push({
      uid: 1000 + i,
      flags: ["\\Seen"],
      size: 500,
      envelope: {
        date: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
        subject: needle ? `Needle ${i}` : `Bulk mail ${i}`,
        messageId: `<big-${i}@example>`,
        from: [{ address: "sender@example.com" }],
        to: [{ address: "me@yahoo.com" }],
      },
      structure: plain(),
      parts: { "1": "x" },
    });
  }
  return { path: "Big", messages };
}
