import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeImapFlow } from "./helpers/fake-imap";
import { bigFolder, yahooFolders } from "./helpers/fixtures";
import { IMAP_CHUNK_BYTES } from "../src/lib/imap";
import { startHarness, type Harness } from "./helpers/harness";

vi.mock("imapflow", async () => {
  const { FakeImapFlow } = await import("./helpers/fake-imap");
  return { ImapFlow: FakeImapFlow };
});

let h: Harness;

beforeEach(async () => {
  FakeImapFlow.reset(yahooFolders());
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const uids = (data: unknown) =>
  (data as { messages: Array<{ uid: number }> }).messages.map((m) => m.uid);
const searchCalls = () =>
  FakeImapFlow.calls.filter((c) => c.startsWith("search:"));

describe("tools/list", () => {
  it("exposes the read tools as read-only and no send tools", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    const readTools = ["get_message", "get_thread", "list_drafts", "list_folders", "search_messages"];
    for (const n of readTools) expect(names).toContain(n);
    for (const t of tools.filter((t) => readTools.includes(t.name))) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
    expect(names.some((n) => n.includes("send"))).toBe(false);
  });
});

describe("list_folders", () => {
  it("maps Yahoo's odd folder names to special-use roles by flag, not by name", async () => {
    const { data } = await h.call("list_folders");
    expect(data).toEqual({
      folders: [
        { path: "INBOX", delimiter: "/", special_use: "inbox" },
        { path: "Sent", delimiter: "/", special_use: "sent" },
        { path: "Draft", delimiter: "/", special_use: "drafts" },
        { path: "Archive", delimiter: "/", special_use: "archive" },
        { path: "Bulk", delimiter: "/", special_use: "junk" },
        { path: "Trash", delimiter: "/", special_use: "trash" },
      ],
    });
    expect(FakeImapFlow.calls).toEqual(["connect", "list", "logout"]);
  });
});

describe("search_messages", () => {
  it("returns newest first with paging and never includes bodies", async () => {
    const { data } = await h.call("search_messages", { limit: 2 });
    expect(data).toMatchObject({
      folder: "INBOX",
      total: 4,
      has_more: true,
      offset: 0,
      limit: 2,
    });
    expect(uids(data)).toEqual([104, 103]);
    const d = data as { messages: Array<Record<string, unknown>> };
    expect(Object.keys(d.messages[0])).not.toContain("body");
    expect(d.messages[1]).toMatchObject({
      uid: 103,
      subject: "Re: Invoice attached",
      unread: false,
      flagged: true,
      has_attachments: false,
      date: "2026-09-03T12:00:00.000Z",
    });
  });

  it("pages with offset and reports when the last page is reached", async () => {
    const { data } = await h.call("search_messages", { limit: 2, offset: 2 });
    expect(uids(data)).toEqual([102, 101]);
    expect(data).toMatchObject({ has_more: false });
  });

  it("applies unread, flagged, from, subject, and date filters with exact totals on a full scan", async () => {
    let r = await h.call("search_messages", { unread_only: true });
    expect(uids(r.data)).toEqual([104, 102]);
    expect(r.data).toMatchObject({ total: 2, has_more: false });

    r = await h.call("search_messages", { flagged_only: true });
    expect(uids(r.data)).toEqual([103]);

    r = await h.call("search_messages", { from: "vendor", subject: "invoice" });
    expect(uids(r.data)).toEqual([102]);

    r = await h.call("search_messages", {
      since: "2026-09-03",
      before: "2026-09-04",
    });
    expect(uids(r.data)).toEqual([103]);
  });

  it("reports attachments presence from the body structure", async () => {
    const { data } = await h.call("search_messages", {
      from: "billing@vendor.example",
      limit: 1,
    });
    const first = (
      data as { messages: Array<{ uid: number; has_attachments: boolean }> }
    ).messages[0];
    expect(first).toMatchObject({ uid: 102, has_attachments: true });
  });

  it("rejects a bad date with a stable code and audits the error", async () => {
    const { raw, data } = await h.call("search_messages", {
      since: "last tuesday",
    });
    expect(raw.isError).toBe(true);
    expect(String(data).startsWith("INVALID_ARGUMENT:")).toBe(true);
    expect(h.db.rows.at(-1)).toMatchObject({
      tool: "search_messages",
      outcome: "error",
    });
  });

  it("surfaces an unknown folder as an IMAP error code", async () => {
    const { raw, data } = await h.call("search_messages", { folder: "Nope" });
    expect(raw.isError).toBe(true);
    expect(String(data).startsWith("IMAP_NONEXISTENT:")).toBe(true);
  });

  it("validates input: limit above the cap is refused before any IMAP call", async () => {
    const res = await h.client.callTool({
      name: "search_messages",
      arguments: { limit: 500 },
    });
    expect(res.isError).toBe(true);
    expect(FakeImapFlow.calls).not.toContain("connect");
  });
});

describe("search windows (Workers cannot receive a single IMAP line over ~16 KB)", () => {
  beforeEach(async () => {
    await h.close();
    FakeImapFlow.reset([...yahooFolders(), bigFolder(2500)]);
    h = await startHarness();
  });

  it("asks Yahoo for at most one window of 1000 messages when the newest page suffices", async () => {
    const { data } = await h.call("search_messages", {
      folder: "Big",
      limit: 20,
    });
    expect(data).toMatchObject({ total: 2500, has_more: true });
    expect(uids(data)).toEqual(Array.from({ length: 20 }, (_, i) => 3499 - i));
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0]).toContain('"seq":"1501:2500"');
  });

  it("keeps scanning older windows for rare matches and gives an exact total once the folder is covered", async () => {
    const { data } = await h.call("search_messages", {
      folder: "Big",
      subject: "Needle",
    });
    expect(uids(data)).toEqual([3331, 2554, 1777, 1000]);
    expect(data).toMatchObject({ total: 4, has_more: false });
    expect(searchCalls().map((c) => /"seq":"(\d+:\d+)"/.exec(c)?.[1])).toEqual([
      "1501:2500",
      "501:1500",
      "1:500",
    ]);
  });

  it("stops as soon as the page is full and then reports total as unknown", async () => {
    const { data } = await h.call("search_messages", {
      folder: "Big",
      subject: "Bulk",
      limit: 5,
    });
    expect(uids(data)).toHaveLength(5);
    expect(data).toMatchObject({ total: null, has_more: true });
    expect(searchCalls()).toHaveLength(1);
  });

  it("reaches deep pages by walking windows", async () => {
    const { data } = await h.call("search_messages", {
      folder: "Big",
      limit: 10,
      offset: 1995,
    });
    expect(uids(data)).toEqual(
      Array.from({ length: 10 }, (_, i) => 3499 - 1995 - i),
    );
    expect(searchCalls()).toHaveLength(3);
  });
});

describe("get_message", () => {
  it("returns plain text, references, and attachment metadata for a multipart message", async () => {
    const { data } = await h.call("get_message", { uid: 102 });
    expect(data).toMatchObject({
      uid: 102,
      folder: "INBOX",
      from: ["Vendor Billing <billing@vendor.example>"],
      to: ["Me <me@yahoo.com>"],
      cc: ["cc@vendor.example"],
      message_id: "<b1@vendor.example>",
      body_format: "text",
      body: "Please find invoice 0042 attached.",
      truncated: false,
      attachments: [
        { filename: "invoice-0042.pdf", mime: "application/pdf", size: 48_211 },
        { filename: "logo.png", mime: "image/png", size: 2_048 },
      ],
    });
    expect(FakeImapFlow.calls.some((c) => c.startsWith(`bodyPart:102:1.1:0:${IMAP_CHUNK_BYTES}`))).toBe(true);
    expect(FakeImapFlow.calls.some((c) => c.startsWith("bodyPart:102:2:"))).toBe(false);
  });

  it("fetches bodies in bounded byte ranges, never through imapflow download()", async () => {
    const { data } = await h.call("get_message", { uid: 104 });
    const ranges = FakeImapFlow.calls.filter((c) => c.startsWith("bodyPart:104:1:")).map((c) => c.split(":").slice(3).join(":"));
    expect(ranges.slice(0, 2)).toEqual([`0:${IMAP_CHUNK_BYTES}`, `${IMAP_CHUNK_BYTES}:${IMAP_CHUNK_BYTES}`]);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect((data as { body: string }).body.startsWith("xxxxxxxxxx")).toBe(true);
    expect(FakeImapFlow.calls.some((c) => c.startsWith("download:"))).toBe(false);
  });

  it("decodes quoted-printable, base64, and legacy charsets", async () => {
    const latin = await h.call("get_message", { uid: 105, folder: "Archive" });
    expect(latin.data).toMatchObject({ body: "café", body_format: "text" });
  });

  it("returns the HTML part when asked, with active content removed", async () => {
    const { data } = await h.call("get_message", { uid: 103, format: "html" });
    const d = data as { body: string; body_format: string };
    expect(d.body_format).toBe("html");
    expect(d.body).toContain('<div class="r">Got it &amp; paid.<br>Thanks!</div>');
    expect(d.body).toContain("<style>p{}</style>");
    expect(d.body).not.toContain("<script");
  });

  it("converts HTML to text when no plain part exists and parses References", async () => {
    const { data } = await h.call("get_message", { uid: 103 });
    expect(data).toMatchObject({
      body_format: "text",
      body: "Got it & paid.\nThanks!",
      in_reply_to: "<b1@vendor.example>",
      references: ["<b1@vendor.example>", "<x0@vendor.example>"],
      flagged: true,
    });
  });

  it("caps the body at the limit and says so", async () => {
    const { data } = await h.call("get_message", { uid: 104 });
    const d = data as { body: string; truncated: boolean };
    expect(d.truncated).toBe(true);
    expect(d.body.length).toBeLessThan(50_100);
    expect(d.body).toContain("[... truncated at 50000 characters]");
  });

  it("reports NOT_FOUND for a missing uid and audits the uid", async () => {
    const { raw, data } = await h.call("get_message", { uid: 999 });
    expect(raw.isError).toBe(true);
    expect(String(data).startsWith("NOT_FOUND:")).toBe(true);
    expect(h.db.rows.at(-1)).toMatchObject({
      tool: "get_message",
      outcome: "error",
      uids: "[999]",
    });
  });
});

describe("get_thread", () => {
  it("uses the server thread id when available and returns oldest first", async () => {
    const { data } = await h.call("get_thread", { uid: 103 });
    expect(data).toMatchObject({
      thread_id: "T-1",
      matched_by: "thread_id",
      truncated: false,
    });
    expect(uids(data)).toEqual([102, 103]);
    expect(
      (data as { messages: Array<{ body_text?: string }> }).messages[0]
        .body_text,
    ).toBeUndefined();
  });

  it("falls back to the References chain when the server rejects THREADID search", async () => {
    FakeImapFlow.rejectThreadIdSearch = true;
    const { data } = await h.call("get_thread", { uid: 103 });
    expect(data).toMatchObject({ thread_id: null, matched_by: "references" });
    expect(uids(data)).toEqual([102, 103]);
  });

  it("includes plain-text bodies on request", async () => {
    const { data } = await h.call("get_thread", {
      uid: 102,
      include_bodies: true,
    });
    const d = data as { messages: Array<{ body_text?: string }> };
    expect(d.messages.map((m) => m.body_text)).toEqual([
      "Please find invoice 0042 attached.",
      "Got it & paid.\nThanks!",
    ]);
  });

  it("returns just the message when it has no thread", async () => {
    const { data } = await h.call("get_thread", { uid: 104 });
    expect(uids(data)).toEqual([104]);
  });
});

describe("list_drafts", () => {
  it("finds the Drafts folder by special-use flag and lists newest first", async () => {
    const { data } = await h.call("list_drafts", { limit: 1 });
    expect(data).toMatchObject({ folder: "Draft", total: 2, has_more: true });
    expect(uids(data)).toEqual([9]);
    expect(FakeImapFlow.calls).toContain("lock:Draft");
  });
});

describe("audit and connection handling", () => {
  it("writes one ok audit row per successful read call, with no args digest", async () => {
    await h.call("list_folders");
    await h.call("search_messages", { limit: 1 });
    expect(
      h.db.rows.map((r) => [r.tool, r.outcome, r.args_digest, r.client_name]),
    ).toEqual([
      ["list_folders", "ok", "", "Test Client"],
      ["search_messages", "ok", "", "Test Client"],
    ]);
  });

  it("maps an authentication failure to IMAP_AUTH_FAILED and still answers", async () => {
    FakeImapFlow.failConnect = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
    });
    const { raw, data } = await h.call("list_folders");
    expect(raw.isError).toBe(true);
    expect(String(data)).toContain("IMAP_AUTH_FAILED");
  });

  it("does not fail the tool call when the audit write fails", async () => {
    h.db.failNext = true;
    const { raw } = await h.call("list_folders");
    expect(raw.isError).toBeFalsy();
  });

  it("always logs out, even when the tool body throws", async () => {
    await h.call("get_message", { uid: 999 });
    expect(FakeImapFlow.calls.at(-1)).toBe("logout");
  });
});
