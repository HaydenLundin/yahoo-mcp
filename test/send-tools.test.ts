import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../src/lib/errors";
import { PENDING_TTL_MS } from "../src/lib/pending";
import { FakeImapFlow } from "./helpers/fake-imap";
import { FakeSmtp } from "./helpers/fake-smtp";
import { yahooFolders } from "./helpers/fixtures";
import { PROPS, startHarness, type Harness } from "./helpers/harness";

vi.mock("imapflow", async () => {
  const { FakeImapFlow } = await import("./helpers/fake-imap");
  return { ImapFlow: FakeImapFlow };
});

vi.mock("../src/lib/smtp", async () => {
  const { FakeSmtp } = await import("./helpers/fake-smtp");
  return { sendRaw: (...a: Parameters<typeof FakeSmtp.sendRaw>) => FakeSmtp.sendRaw(...a) };
});

let h: Harness;

beforeEach(async () => {
  FakeImapFlow.reset(yahooFolders());
  FakeSmtp.reset();
  h = await startHarness({ SEND_ENABLED: "true", YAHOO_USER: "me@yahoo.com" });
});

afterEach(async () => {
  await h.close();
});

type Staged = {
  confirm_token: string;
  expires_at: string;
  preview: Record<string, unknown>;
  next_step: string;
};
const SEND_TOOLS = [
  "send_message",
  "reply_message",
  "forward_message",
  "confirm_send",
  "cancel_send",
];

describe("SEND_ENABLED gate and annotations", () => {
  it("registers the five send tools only when SEND_ENABLED is true", async () => {
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    for (const n of SEND_TOOLS) expect(names).toContain(n);

    await h.close();
    h = await startHarness({ SEND_ENABLED: "false" });
    const without = (await h.client.listTools()).tools.map((t) => t.name);
    for (const n of SEND_TOOLS) expect(without).not.toContain(n);
  });

  it("marks only confirm_send destructive and open-world, and cancel_send idempotent", async () => {
    const by = Object.fromEntries(
      (await h.client.listTools()).tools.map((t) => [t.name, t.annotations]),
    );
    for (const n of ["send_message", "reply_message", "forward_message"]) {
      expect(by[n]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    expect(by.confirm_send).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(by.cancel_send).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(
      (await h.client.listTools()).tools.find((t) => t.name === "confirm_send")!
        .description,
    ).toContain("ONLY call this after the user has explicitly confirmed");
  });
});

describe("send_message (phase one)", () => {
  it("stores the rendered message and returns a preview and token without touching SMTP", async () => {
    const { data } = await h.call("send_message", {
      to: ["Sam <sam@example.com>"],
      cc: ["cc@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Thursday",
      body_text: "I'm available Thursday.",
    });
    const d = data as Staged;
    expect(d.confirm_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = new Date(d.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(PENDING_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(PENDING_TTL_MS);
    expect(d.preview).toEqual({
      kind: "send",
      to: ["Sam <sam@example.com>"],
      cc: ["cc@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Thursday",
      body_text: "I'm available Thursday.",
    });
    expect(d.next_step).toContain("confirm_send");
    expect(FakeSmtp.sent).toHaveLength(0);
    expect(FakeImapFlow.calls).not.toContain("connect");

    const row = h.db.pending.get(d.confirm_token)!;
    expect(row.client_id).toBe(PROPS.clientId);
    const mime = new TextDecoder().decode(row.mime);
    expect(mime).toContain("From: me@yahoo.com\r\n");
    expect(mime).toContain("Bcc: hidden@example.com\r\n");
    expect(h.db.rows.at(-1)).toMatchObject({
      tool: "send_message",
      outcome: "ok",
    });
  });

  it("rejects bad addresses before storing anything", async () => {
    const { raw, data } = await h.call("send_message", {
      to: ["nope"],
      subject: "x",
      body_text: "y",
    });
    expect(raw.isError).toBe(true);
    expect(String(data).startsWith("INVALID_ARGUMENT:")).toBe(true);
    expect(h.db.pending.size).toBe(0);
  });
});

describe("confirm_send and cancel_send (phase two)", () => {
  async function staged(): Promise<Staged> {
    const { data } = await h.call("send_message", {
      to: ["sam@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Hello",
      body_text: "Body",
    });
    return data as Staged;
  }

  it("sends over SMTP with the full recipient envelope, files a copy in Sent, and burns the token", async () => {
    const s = await staged();
    const { data } = await h.call("confirm_send", {
      confirm_token: s.confirm_token,
    });
    expect(data).toMatchObject({
      sent: true,
      kind: "send",
      to: ["sam@example.com"],
      bcc_count: 1,
      subject: "Hello",
      message_id: expect.stringMatching(/^<[0-9a-f-]{36}@yahoo\.com>$/),
      accepted: 2,
      rejected: [],
      saved_to_sent: true,
    });
    expect(FakeSmtp.sent).toHaveLength(1);
    expect(FakeSmtp.sent[0].envelope).toEqual({
      from: "me@yahoo.com",
      to: ["sam@example.com", "hidden@example.com"],
    });
    expect(FakeSmtp.sent[0].raw).toContain("Subject: Hello\r\n");

    const sent = FakeImapFlow.folder("Sent").messages;
    expect(sent).toHaveLength(1);
    expect(sent[0].flags).toEqual(["\\Seen"]);
    expect(sent[0].raw).toBe(FakeSmtp.sent[0].raw);

    expect(h.db.pending.size).toBe(0);
    const again = await h.call("confirm_send", {
      confirm_token: s.confirm_token,
    });
    expect(String(again.data).startsWith("CONFIRM_TOKEN_INVALID:")).toBe(true);
    expect(FakeSmtp.sent).toHaveLength(1);
    expect(
      h.db.rows.filter((r) => r.tool === "confirm_send").map((r) => r.outcome),
    ).toEqual(["ok", "error"]);
  });

  it("cancel_send discards the message and the token cannot be confirmed afterwards", async () => {
    const s = await staged();
    const { data } = await h.call("cancel_send", {
      confirm_token: s.confirm_token,
    });
    expect(data).toEqual({ cancelled: true });
    expect(h.db.pending.size).toBe(0);
    const again = await h.call("cancel_send", {
      confirm_token: s.confirm_token,
    });
    expect(again.data).toEqual({ cancelled: false });
    const confirm = await h.call("confirm_send", {
      confirm_token: s.confirm_token,
    });
    expect(String(confirm.data).startsWith("CONFIRM_TOKEN_INVALID:")).toBe(
      true,
    );
    expect(FakeSmtp.sent).toHaveLength(0);
  });

  it("refuses an expired token and removes it", async () => {
    const s = await staged();
    h.db.pending.get(s.confirm_token)!.expires_at = Date.now() - 1;
    const { data } = await h.call("confirm_send", {
      confirm_token: s.confirm_token,
    });
    expect(String(data).startsWith("CONFIRM_TOKEN_EXPIRED:")).toBe(true);
    expect(h.db.pending.size).toBe(0);
    expect(FakeSmtp.sent).toHaveLength(0);
  });

  it("refuses a token that belongs to another client and leaves it in place", async () => {
    const s = await staged();
    h.db.pending.get(s.confirm_token)!.client_id = "someone-else";
    const confirm = await h.call("confirm_send", {
      confirm_token: s.confirm_token,
    });
    expect(String(confirm.data).startsWith("CONFIRM_TOKEN_INVALID:")).toBe(
      true,
    );
    expect(h.db.pending.size).toBe(1);
    const cancel = await h.call("cancel_send", {
      confirm_token: s.confirm_token,
    });
    expect(cancel.data).toEqual({ cancelled: false });
  });

  it("maps SMTP failures to stable codes and does not file a copy in Sent", async () => {
    const s = await staged();
    FakeSmtp.failNext = new ToolError("SMTP_RECIPIENT_REJECTED", "Yahoo rejected a recipient. Server said: 554 5.7.9 recipient refused");
    const { raw, data } = await h.call("confirm_send", {
      confirm_token: s.confirm_token,
    });
    expect(raw.isError).toBe(true);
    expect(String(data)).toContain("SMTP_RECIPIENT_REJECTED");
    expect(String(data)).toContain("recipient refused");
    expect(FakeImapFlow.folder("Sent").messages).toHaveLength(0);
    expect(h.db.pending.size).toBe(0);
  });

  it("still reports the send when filing the Sent copy fails", async () => {
    const s = await staged();
    FakeImapFlow.failConnect = new Error("imap down");
    const { data } = await h.call("confirm_send", {
      confirm_token: s.confirm_token,
    });
    expect(data).toMatchObject({ sent: true, saved_to_sent: false });
    expect(FakeSmtp.sent).toHaveLength(1);
  });
});

describe("reply_message", () => {
  it("replies to the sender with Re: subject and threading headers", async () => {
    const { data } = await h.call("reply_message", {
      uid: 102,
      body_text: "Paid, thanks.",
    });
    const d = data as Staged;
    expect(d.preview).toMatchObject({
      kind: "reply",
      to: ["Vendor Billing <billing@vendor.example>"],
      cc: [],
      subject: "Re: Invoice attached",
      in_reply_to_uid: 102,
    });
    const mime = new TextDecoder().decode(
      h.db.pending.get(d.confirm_token)!.mime,
    );
    expect(mime).toContain("In-Reply-To: <b1@vendor.example>\r\n");
    expect(mime).toContain("References: <b1@vendor.example>\r\n");
    expect(mime).toContain("Subject: Re: Invoice attached\r\n");
  });

  it("reply_all adds the original To and Cc minus this account, and keeps an existing Re:", async () => {
    const { data } = await h.call("reply_message", {
      uid: 103,
      body_text: "ok",
      reply_all: true,
    });
    const d = data as Staged;
    // uid 103 is from me@yahoo.com to billing@vendor.example: replying to self is excluded
    expect(d.preview).toMatchObject({
      to: ["billing@vendor.example"],
      subject: "Re: Invoice attached",
    });
    const mime = new TextDecoder().decode(
      h.db.pending.get(d.confirm_token)!.mime,
    );
    expect(mime).toContain(
      "References: <b1@vendor.example> <x0@vendor.example> <c1@yahoo.com>\r\n",
    );

    const r2 = await h.call("reply_message", {
      uid: 102,
      body_text: "all",
      reply_all: true,
    });
    expect((r2.data as Staged).preview).toMatchObject({
      to: ["Vendor Billing <billing@vendor.example>"],
      cc: ["cc@vendor.example"],
    });
  });

  it("answers a note-to-self to ourselves instead of failing", async () => {
    FakeImapFlow.folder("INBOX").messages.push({
      uid: 110,
      flags: [],
      envelope: { date: new Date("2026-10-07T12:00:00Z"), subject: "note", messageId: "<n1@yahoo.com>", from: [{ address: "me@yahoo.com" }], to: [{ address: "me@yahoo.com" }] },
      structure: { type: "text/plain", encoding: "7bit" },
      headers: "Message-ID: <n1@yahoo.com>\r\n",
      parts: { "1": "remember" },
    });
    const { data } = await h.call("reply_message", { uid: 110, body_text: "done" });
    expect((data as Staged).preview).toMatchObject({ to: ["me@yahoo.com"], cc: [], subject: "Re: note" });
  });

  it("reports NOT_FOUND for an unknown uid and stores nothing", async () => {
    const { data } = await h.call("reply_message", {
      uid: 999,
      body_text: "x",
    });
    expect(String(data).startsWith("NOT_FOUND:")).toBe(true);
    expect(h.db.pending.size).toBe(0);
  });
});

describe("forward_message", () => {
  it("forwards the text with a header block, lists omitted attachments, and prefixes Fwd:", async () => {
    const { data } = await h.call("forward_message", {
      uid: 102,
      to: ["x@example.com"],
      note: "FYI",
    });
    const d = data as Staged;
    expect(d.preview).toMatchObject({
      kind: "forward",
      to: ["x@example.com"],
      subject: "Fwd: Invoice attached",
      forwarded_uid: 102,
      attachments_omitted: ["invoice-0042.pdf", "logo.png"],
    });
    const body = d.preview.body_text as string;
    expect(
      body.startsWith(
        "FYI\n\n---------- Forwarded message ----------\nFrom: Vendor Billing <billing@vendor.example>",
      ),
    ).toBe(true);
    expect(body).toContain("Subject: Invoice attached");
    expect(body.trimEnd().endsWith("Please find invoice 0042 attached.")).toBe(
      true,
    );
    expect(
      FakeImapFlow.calls.some((c) => c.startsWith("bodyPart:102:1.1:")),
    ).toBe(true);
    expect(
      FakeImapFlow.calls.some((c) => c.startsWith("bodyPart:102:2:")),
    ).toBe(false);
  });

  it("does not double the Fwd: prefix", async () => {
    FakeImapFlow.folder("INBOX").messages[0].envelope.subject = "Fwd: already";
    const { data } = await h.call("forward_message", {
      uid: 101,
      to: ["x@example.com"],
    });
    expect((data as Staged).preview.subject).toBe("Fwd: already");
  });
});
