import { describe, expect, it } from "vitest";
import { authApp } from "../src/auth/consent";
import type { Env } from "../src/types";
import { FakeD1, makeEnv } from "./helpers/harness";

const OPERATOR = "dev-bypass@localhost";

function fakeProvider(
  grants: Array<Record<string, unknown>>,
  revoked: Array<[string, string]>,
) {
  return {
    listUserGrants: async (userId: string) => ({
      items: grants.filter((g) => g.userId === userId),
    }),
    revokeGrant: async (id: string, userId: string) => {
      revoked.push([id, userId]);
    },
  } as unknown as Env["OAUTH_PROVIDER"];
}

function setup(withBypass = true) {
  const db = new FakeD1();
  db.rows.push(
    {
      ts: Date.parse("2026-10-07T13:21:11Z"),
      client_id: "claude-code",
      client_name: "Claude Code",
      tool: "search_messages",
      args_digest: "",
      uids: null,
      outcome: "ok",
    },
    {
      ts: Date.parse("2026-10-07T13:21:18Z"),
      client_id: "claude-code",
      client_name: "Claude Code",
      tool: "get_message",
      args_digest: "",
      uids: "[1]",
      outcome: "ok",
    },
    {
      ts: Date.parse("2026-10-06T10:00:00Z"),
      client_id: "claude-code",
      client_name: "Claude Code",
      tool: "list_folders",
      args_digest: "",
      uids: null,
      outcome: "ok",
    },
  );
  const revoked: Array<[string, string]> = [];
  const grants = [
    {
      id: "g-1",
      clientId: "claude-code",
      userId: OPERATOR,
      scope: ["mail.read", "mail.organize"],
      metadata: { clientName: "Claude Code" },
      createdAt: Date.parse("2026-10-06T09:00:00Z"),
    },
    {
      id: "g-2",
      clientId: "chatgpt",
      userId: OPERATOR,
      scope: ["mail.read"],
      metadata: { clientName: "ChatGPT" },
      createdAt: Date.parse("2026-10-07T12:00:00Z"),
    },
    {
      id: "g-other",
      clientId: "someone",
      userId: "someone@else.example",
      scope: ["mail.read"],
      metadata: {},
      createdAt: 0,
    },
  ];
  const env = makeEnv(db, {
    OAUTH_PROVIDER: fakeProvider(grants, revoked),
    ...(withBypass ? { ACCESS_DEV_BYPASS: "true" } : {}),
  });
  return { env, revoked };
}

describe("connected clients console", () => {
  it("lists the operator's grants newest first with names, scopes, activity, and a revoke form", async () => {
    const { env } = setup();
    const res = await authApp.request(
      "http://localhost/authorize/connections",
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.indexOf("ChatGPT")).toBeLessThan(body.indexOf("Claude Code"));
    expect(body).toContain("mail.read mail.organize");
    expect(body).toContain("2026-10-07 13:21 UTC (3 calls)");
    expect(body).toContain("never");
    expect(body).toContain('name="grant_id" value="g-1"');
    expect(body).not.toContain("someone@else.example");
  });

  it("revokes a grant for the signed-in operator only and redirects back", async () => {
    const { env, revoked } = setup();
    const res = await authApp.request(
      "http://localhost/authorize/connections/revoke",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
        body: "grant_id=g-2",
      },
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/authorize/connections?revoked=1",
    );
    expect(revoked).toEqual([["g-2", OPERATOR]]);
  });

  it("rejects cross-site revoke attempts and empty ids", async () => {
    const { env, revoked } = setup();
    const cross = await authApp.request(
      "http://localhost/authorize/connections/revoke",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
        body: "grant_id=g-1",
      },
      env,
    );
    expect(cross.status).toBe(403);
    const empty = await authApp.request(
      "http://localhost/authorize/connections/revoke",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
        },
        body: "grant_id=",
      },
      env,
    );
    expect(empty.status).toBe(400);
    expect(revoked).toEqual([]);
  });

  it("is unreachable without Cloudflare Access", async () => {
    const { env } = setup(false);
    const res = await authApp.request(
      "http://localhost/authorize/connections",
      {},
      env,
    );
    expect(res.status).toBe(503);
  });

  it("sends security headers on operator pages and keeps the OAuth popup flow possible", async () => {
    const { env } = setup();
    const res = await authApp.request("http://localhost/", {}, env);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).not.toContain("form-action");
    expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
