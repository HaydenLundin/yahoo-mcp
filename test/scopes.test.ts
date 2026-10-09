import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeImapFlow } from "./helpers/fake-imap";
import { yahooFolders } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import type { Env, GrantProps, Scope } from "../src/types";

vi.mock("imapflow", async () => {
  const { FakeImapFlow } = await import("./helpers/fake-imap");
  return { ImapFlow: FakeImapFlow };
});

const READ_TOOLS = [
  "list_folders",
  "search_messages",
  "get_message",
  "get_thread",
  "list_drafts",
  "search",
  "fetch",
].sort();
const ORGANIZE_TOOLS = [
  "move_messages",
  "archive_messages",
  "trash_messages",
  "mark_read",
  "mark_unread",
  "flag_messages",
  "unflag_messages",
].sort();
const DRAFT_TOOLS = ["create_draft", "update_draft", "delete_draft"].sort();
const SEND_TOOLS = [
  "send_message",
  "reply_message",
  "forward_message",
  "confirm_send",
  "cancel_send",
].sort();

const grant = (scopes: Scope[]): GrantProps => ({
  clientId: "client-under-test",
  clientName: "Client under test",
  scopes,
  grantedAt: 0,
  grantedBy: "operator@example.com",
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function toolNames(
  scopes: Scope[],
  env: Partial<Env> = {},
): Promise<string[]> {
  FakeImapFlow.reset(yahooFolders());
  h = await startHarness(env, grant(scopes));
  const { tools } = await h.client.listTools();
  return tools.map((t) => t.name).sort();
}

/** The SDK client reports an unregistered tool either as a rejection or as an isError result, depending on version. */
async function refused(p: Promise<unknown>): Promise<void> {
  const r = await p.then(
    (v) => v as { isError?: boolean; content?: Array<{ text?: string }> },
    (e: unknown) => ({ isError: true, content: [{ text: String(e) }] }),
  );
  expect(r.isError).toBe(true);
  expect(r.content?.[0]?.text ?? "").toMatch(/not found|unknown tool|-32602/i);
}

describe("the tool list follows the grant's scopes", () => {
  it("mail.read alone exposes only reading tools and the connector aliases, even with sending switched on", async () => {
    expect(await toolNames(["mail.read"], { SEND_ENABLED: "true" })).toEqual(
      READ_TOOLS,
    );
  });

  it("mail.organize adds the folder and flag tools, mail.draft adds the draft tools", async () => {
    expect(await toolNames(["mail.read", "mail.organize"])).toEqual(
      [...READ_TOOLS, ...ORGANIZE_TOOLS].sort(),
    );
    expect(await toolNames(["mail.read", "mail.draft"])).toEqual(
      [...READ_TOOLS, ...DRAFT_TOOLS].sort(),
    );
  });

  it("send tools need both the mail.send scope and SEND_ENABLED", async () => {
    expect(await toolNames(["mail.read", "mail.send"])).toEqual(READ_TOOLS);
    expect(
      await toolNames(["mail.read", "mail.send"], { SEND_ENABLED: "true" }),
    ).toEqual([...READ_TOOLS, ...SEND_TOOLS].sort());
    expect(
      await toolNames(["mail.read", "mail.draft", "mail.organize"], {
        SEND_ENABLED: "true",
      }),
    ).not.toContain("send_message");
  });

  it("a full grant with sending on sees everything", async () => {
    expect(
      await toolNames(
        ["mail.read", "mail.draft", "mail.organize", "mail.send"],
        {
          SEND_ENABLED: "true",
        },
      ),
    ).toEqual(
      [...READ_TOOLS, ...ORGANIZE_TOOLS, ...DRAFT_TOOLS, ...SEND_TOOLS].sort(),
    );
  });

  it("a tool outside the grant cannot be called by name and never opens an IMAP session", async () => {
    FakeImapFlow.reset(yahooFolders());
    h = await startHarness({ SEND_ENABLED: "true" }, grant(["mail.read"]));
    await refused(
      h.client.callTool({
        name: "archive_messages",
        arguments: { uids: [101] },
      }),
    );
    await refused(
      h.client.callTool({
        name: "send_message",
        arguments: { to: ["x@example.com"], subject: "s", body_text: "b" },
      }),
    );
    expect(FakeImapFlow.calls).not.toContain("connect");
  });
});
