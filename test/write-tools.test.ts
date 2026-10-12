import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeImapFlow } from "./helpers/fake-imap";
import { yahooFolders } from "./helpers/fixtures";
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

const uidsIn = (path: string) =>
  FakeImapFlow.folder(path)
    .messages.map((m) => m.uid)
    .sort((a, b) => a - b);
const lastAudit = () => h.db.rows.at(-1)!;
const lastDetail = () => JSON.parse(lastAudit().detail ?? "null") as Record<string, unknown> | null;

describe("tools/list annotations", () => {
  it("marks organize tools idempotent, drafts non-idempotent, delete_draft a reversible move", async () => {
    const { tools } = await h.client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(by).sort()).toEqual(
      [
        "archive_messages",
        "create_draft",
        "delete_draft",
        "fetch",
        "flag_messages",
        "get_message",
        "get_thread",
        "list_drafts",
        "list_folders",
        "mark_read",
        "mark_unread",
        "move_messages",
        "search",
        "search_messages",
        "trash_messages",
        "unflag_messages",
        "update_draft",
      ].sort(),
    );
    for (const name of [
      "move_messages",
      "archive_messages",
      "trash_messages",
      "mark_read",
      "mark_unread",
      "flag_messages",
      "unflag_messages",
    ]) {
      expect(by[name]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(by.create_draft).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(by.update_draft).toMatchObject({ idempotentHint: false });
    expect(by.delete_draft).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tools.some((t) => t.name.includes("send"))).toBe(false);
  });
});

describe("create_draft", () => {
  it("appends a quoted-printable draft to the Drafts folder with the \\Draft flag", async () => {
    const { data } = await h.call("create_draft", {
      to: ["Sam <sam@example.com>"],
      subject: "Thursday",
      body_text: "I'm available Thursday = yes.\n",
    });
    expect(data).toMatchObject({ uid: 10, folder: "Draft" });
    const saved = FakeImapFlow.folder("Draft").messages.find(
      (m) => m.uid === 10,
    )!;
    expect(saved.flags).toEqual(["\\Draft", "\\Seen"]);
    expect(saved.raw).toContain("From: user@example.com\r\n");
    expect(saved.raw).toContain("To: Sam <sam@example.com>\r\n");
    expect(saved.raw).toContain("Subject: Thursday\r\n");
    expect(saved.raw).toContain("I'm available Thursday =3D yes.\r\n");
    expect(FakeImapFlow.calls).toContain("append:Draft:10:\\Draft,\\Seen");
  });

  it("threads a reply onto the original's Message-ID and References", async () => {
    const { data } = await h.call("create_draft", {
      to: ["billing@vendor.example"],
      subject: "Re: Invoice attached",
      body_text: "Paid.",
      in_reply_to_uid: 103,
    });
    const saved = FakeImapFlow.folder("Draft").messages.find(
      (m) => m.uid === (data as { uid: number }).uid,
    )!;
    expect(saved.raw).toContain("In-Reply-To: <c1@yahoo.com>\r\n");
    expect(saved.raw).toContain(
      "References: <b1@vendor.example> <x0@vendor.example> <c1@yahoo.com>\r\n",
    );
    expect(FakeImapFlow.calls.filter((c) => c === "connect")).toHaveLength(1);
  });

  it("writes an html alternative when given, and audits with an args digest but no bodies", async () => {
    await h.call("create_draft", {
      to: ["a@b.example"],
      subject: "Hi",
      body_text: "plain",
      body_html: "<p>plain</p>",
    });
    const saved = FakeImapFlow.folder("Draft").messages.at(-1)!;
    expect(saved.raw).toContain("multipart/alternative");
    expect(lastAudit()).toMatchObject({
      tool: "create_draft",
      outcome: "ok",
      uids: null,
    });
    expect(lastAudit().args_digest).toMatch(/^[0-9a-f]{64}$/);
    const again = await (async () => {
      await h.call("create_draft", {
        to: ["a@b.example"],
        subject: "Hi",
        body_text: "DIFFERENT body",
        body_html: "<p>x</p>",
      });
      return lastAudit().args_digest;
    })();
    expect(again).toBe(h.db.rows.at(-2)!.args_digest);
  });

  it("rejects bad addresses and a missing reply target with stable codes", async () => {
    let r = await h.call("create_draft", {
      to: ["not-an-address"],
      subject: "x",
      body_text: "y",
    });
    expect(r.raw.isError).toBe(true);
    expect(String(r.data).startsWith("INVALID_ARGUMENT:")).toBe(true);
    expect(uidsIn("Draft")).toEqual([7, 9]);

    r = await h.call("create_draft", {
      to: ["a@b.example"],
      subject: "x",
      body_text: "y",
      in_reply_to_uid: 999,
    });
    expect(String(r.data).startsWith("NOT_FOUND:")).toBe(true);
    expect(uidsIn("Draft")).toEqual([7, 9]);
  });
});

describe("update_draft and delete_draft", () => {
  it("saves the replacement before removing the old draft", async () => {
    const { data } = await h.call("update_draft", {
      uid: 7,
      to: ["sam@example.com"],
      subject: "Draft to Sam, v2",
      body_text: "v2",
    });
    expect(data).toMatchObject({
      uid: 10,
      folder: "Draft",
      replaced_uid: 7,
      old_version_in: "Trash",
    });
    expect(uidsIn("Draft")).toEqual([9, 10]);
    expect(uidsIn("Trash")).toEqual([1]);
    const appendAt = FakeImapFlow.calls.findIndex((c) =>
      c.startsWith("append:Draft:10"),
    );
    const moveAt = FakeImapFlow.calls.findIndex(
      (c) => c === "move:Draft->Trash:7",
    );
    expect(appendAt).toBeGreaterThan(-1);
    expect(moveAt).toBeGreaterThan(appendAt);
    expect(FakeImapFlow.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(lastAudit()).toMatchObject({
      tool: "update_draft",
      uids: "[7]",
      outcome: "ok",
    });
  });

  it("refuses to update a draft that does not exist, without appending anything", async () => {
    const { raw, data } = await h.call("update_draft", {
      uid: 404,
      to: ["a@b.example"],
      subject: "x",
      body_text: "y",
    });
    expect(raw.isError).toBe(true);
    expect(String(data).startsWith("NOT_FOUND:")).toBe(true);
    expect(uidsIn("Draft")).toEqual([7, 9]);
  });

  it("moves a draft to Trash, never expunging, and reports NOT_FOUND for unknown uids", async () => {
    const { data } = await h.call("delete_draft", { uid: 9 });
    expect(data).toEqual({
      trashed: true,
      uid: 9,
      folder: "Draft",
      trash_folder: "Trash",
      trash_uid: 1,
    });
    expect(uidsIn("Draft")).toEqual([7]);
    expect(uidsIn("Trash")).toEqual([1]);
    expect(FakeImapFlow.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(lastAudit()).toMatchObject({ tool: "delete_draft", uids: "[9]" });

    const r = await h.call("delete_draft", { uid: 9 });
    expect(String(r.data).startsWith("NOT_FOUND:")).toBe(true);
  });

  it("never touches a non-Drafts folder: the uid is looked up in Drafts only", async () => {
    const r = await h.call("delete_draft", { uid: 101 });
    expect(String(r.data).startsWith("NOT_FOUND:")).toBe(true);
    expect(uidsIn("INBOX")).toEqual([101, 102, 103, 104]);
  });
});

describe("move, archive, trash", () => {
  it("moves by uid and returns the destination uids", async () => {
    const { data } = await h.call("move_messages", {
      uids: [101, 103],
      to_folder: "Archive",
    });
    expect(data).toMatchObject({
      moved: 2,
      from_folder: "INBOX",
      to_folder: "Archive",
      uid_map: { "101": 106, "103": 107 },
    });
    expect(uidsIn("INBOX")).toEqual([102, 104]);
    expect(uidsIn("Archive")).toEqual([105, 106, 107]);
    expect(lastAudit()).toMatchObject({
      tool: "move_messages",
      uids: "[101,103]",
      outcome: "ok",
    });
  });

  it("surfaces a missing destination as an IMAP error code", async () => {
    const { raw, data } = await h.call("move_messages", {
      uids: [101],
      to_folder: "Nowhere",
    });
    expect(raw.isError).toBe(true);
    expect(String(data).startsWith("IMAP_TRYCREATE:")).toBe(true);
    expect(uidsIn("INBOX")).toEqual([101, 102, 103, 104]);
  });

  it("archives and trashes via special-use flags, whatever Yahoo calls the folders", async () => {
    await h.close();
    const folders = yahooFolders();
    folders.find((f) => f.specialUse === "\\Archive")!.path = "Archived Mail";
    folders.find((f) => f.specialUse === "\\Trash")!.path = "Deleted Items";
    FakeImapFlow.reset(folders);
    h = await startHarness();

    let r = await h.call("archive_messages", { uids: [101] });
    expect(r.data).toMatchObject({ moved: 1, to_folder: "Archived Mail" });
    expect(uidsIn("Archived Mail")).toContain(106);

    r = await h.call("trash_messages", { uids: [102] });
    expect(r.data).toMatchObject({ moved: 1, to_folder: "Deleted Items" });
    expect(uidsIn("INBOX")).toEqual([103, 104]);
    expect(
      FakeImapFlow.calls.some(
        (c) => c.includes("Trash") && !c.includes("Deleted Items"),
      ),
    ).toBe(false);
  });

  it("is a no-op when the messages are already in the destination", async () => {
    const { data } = await h.call("trash_messages", {
      uids: [1],
      from_folder: "Trash",
    });
    expect(data).toMatchObject({ moved: 0, note: "already there" });
  });

  it("validates uid lists before touching IMAP", async () => {
    const res = await h.client.callTool({
      name: "move_messages",
      arguments: { uids: [], to_folder: "Archive" },
    });
    expect(res.isError).toBe(true);
    expect(FakeImapFlow.calls).not.toContain("connect");
  });
});

describe("flags", () => {
  const flagsOf = (uid: number) =>
    FakeImapFlow.folder("INBOX").messages.find((m) => m.uid === uid)!.flags ?? [];

  it("marks read and unread", async () => {
    await h.call("mark_read", { uids: [102, 104] });
    expect(flagsOf(102)).toContain("\\Seen");
    expect(flagsOf(104)).toContain("\\Seen");
    const { data } = await h.call("mark_unread", { uids: [101] });
    expect(data).toEqual({
      updated: 1,
      missing: [],
      folder: "INBOX",
      flag: "\\Seen",
      set: false,
    });
    expect(flagsOf(101)).not.toContain("\\Seen");
  });

  it("flags and unflags, idempotently", async () => {
    await h.call("flag_messages", { uids: [101] });
    await h.call("flag_messages", { uids: [101] });
    expect(flagsOf(101).filter((f) => f === "\\Flagged")).toHaveLength(1);
    await h.call("unflag_messages", { uids: [101, 103] });
    expect(flagsOf(101)).not.toContain("\\Flagged");
    expect(flagsOf(103)).not.toContain("\\Flagged");
    expect(lastAudit()).toMatchObject({
      tool: "unflag_messages",
      uids: "[101,103]",
    });
  });
});

describe("counts reflect the server, not the request", () => {
  it("move reports only the uids COPYUID confirms and names the rest", async () => {
    const { data } = await h.call("move_messages", {
      uids: [101, 999],
      to_folder: "Archive",
    });
    expect(data).toMatchObject({ moved: 1, missing: [999], uid_map: { "101": 106 } });
  });

  it("flag changes count only messages that exist", async () => {
    const { data } = await h.call("mark_read", { uids: [102, 999] });
    expect(data).toMatchObject({ updated: 1, missing: [999] });
    const none = await h.call("mark_read", { uids: [998, 999] });
    expect(none.data).toMatchObject({ updated: 0, missing: [998, 999] });
    expect(FakeImapFlow.calls.filter((c) => c.startsWith("flags:"))).toHaveLength(1);
  });

  it("update_draft fails loudly when the old draft cannot be moved to Trash", async () => {
    FakeImapFlow.failMove = true;
    const { raw, data } = await h.call("update_draft", {
      uid: 7,
      to: ["sam@example.com"],
      subject: "v3",
      body_text: "v3",
    });
    expect(raw.isError).toBe(true);
    expect(String(data)).toMatch(/^IMAP_MOVE_FAILED: Saved the new draft as uid \d+/);
    expect(uidsIn("Draft")).toContain(7);
  });
});

describe("mail moved into Drafts cannot be lost through the draft tools", () => {
  it("delete_draft on a message that merely sits in Drafts moves it to Trash; nothing is ever expunged", async () => {
    const moved = await h.call("move_messages", { uids: [101], to_folder: "Draft" });
    const newUid = (moved.data as { uid_map: Record<string, number> }).uid_map["101"];
    expect(newUid).toBeGreaterThan(0);

    const del = await h.call("delete_draft", { uid: newUid });
    expect(del.raw.isError).toBeFalsy();
    const trashUid = (del.data as { trash_uid: number }).trash_uid;
    expect(uidsIn("Draft")).not.toContain(newUid);
    expect(uidsIn("Trash")).toContain(trashUid);
    const survivor = FakeImapFlow.folder("Trash").messages.find((m) => m.uid === trashUid);
    expect(survivor?.envelope.subject).toBe("Lease renewal");
    expect(FakeImapFlow.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });
});

describe("audit detail", () => {
  it("records what a move touched: folders and a count, never the arguments", async () => {
    await h.call("move_messages", { uids: [101, 102], to_folder: "Archive" });
    expect(lastAudit().tool).toBe("move_messages");
    expect(lastDetail()).toEqual({ from_folder: "INBOX", to_folder: "Archive", moved: 2 });
    await h.call("trash_messages", { uids: [103] });
    expect(lastDetail()).toMatchObject({ to_folder: "Trash", moved: 1 });
  });

  it("stays empty for tools that do not note anything", async () => {
    await h.call("mark_read", { uids: [101] });
    expect(lastAudit().detail).toBeNull();
  });
});
