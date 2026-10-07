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

describe("ChatGPT connector aliases", () => {
  it("exposes read-only tools named exactly search and fetch", async () => {
    const { tools } = await h.client.listTools();
    const search = tools.find((t) => t.name === "search")!;
    const fetchTool = tools.find((t) => t.name === "fetch")!;
    expect(search.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(fetchTool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("search returns {results:[{id,title,url}]} newest first from the inbox", async () => {
    const { data } = await h.call("search", { query: "invoice" });
    const d = data as {
      results: Array<{ id: string; title: string; url: string }>;
    };
    expect(d.results.map((r) => r.id)).toEqual(["INBOX:103", "INBOX:102"]);
    expect(d.results[1].title).toBe(
      "Invoice attached — Vendor Billing <billing@vendor.example> — 2026-09-02",
    );
    expect(d.results[1].url).toBe(
      "https://mail.yahoo.com/d/search/keyword=Invoice%20attached",
    );
    expect(Object.keys(d.results[0]).sort()).toEqual(["id", "title", "url"]);
  });

  it("fetch returns {id,title,text,url,metadata} for a search id", async () => {
    const { data } = await h.call("fetch", { id: "INBOX:102" });
    expect(data).toMatchObject({
      id: "INBOX:102",
      title:
        "Invoice attached — Vendor Billing <billing@vendor.example> — 2026-09-02",
      text: "Please find invoice 0042 attached.",
      url: "https://mail.yahoo.com/d/search/keyword=Invoice%20attached",
      metadata: {
        folder: "INBOX",
        uid: 102,
        from: ["Vendor Billing <billing@vendor.example>"],
        unread: true,
        attachments: ["invoice-0042.pdf", "logo.png"],
      },
    });
  });

  it("fetch accepts ids from other folders and rejects malformed ones before any IMAP call", async () => {
    const ok = await h.call("fetch", { id: "Archive:105" });
    expect(ok.data).toMatchObject({
      text: "café",
      metadata: { folder: "Archive", uid: 105 },
    });

    const bad = await h.client.callTool({
      name: "fetch",
      arguments: { id: "nonsense" },
    });
    expect(bad.isError).toBe(true);
    const connects = FakeImapFlow.calls.filter((c) => c === "connect").length;
    expect(connects).toBe(1);

    const missing = await h.call("fetch", { id: "INBOX:999" });
    expect(String(missing.data).startsWith("NOT_FOUND:")).toBe(true);
  });
});
