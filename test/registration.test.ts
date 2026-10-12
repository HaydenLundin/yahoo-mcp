import { describe, expect, it } from "vitest";
import type { ClientRegistrationCallbackOptions } from "@cloudflare/workers-oauth-provider";
import {
  checkRegistration,
  REGISTRATION_LIMITS,
  registrationClosed,
} from "../src/auth/registration";
import { FakeD1, makeEnv } from "./helpers/harness";

/**
 * /register is the one endpoint where an anonymous caller writes to our KV. The callback caps what
 * a registration may carry, and REGISTRATION_ENABLED=false closes the door once every client is in.
 */

function options(
  metadata: Record<string, unknown>,
  body = JSON.stringify(metadata),
): ClientRegistrationCallbackOptions {
  return {
    clientMetadata: metadata,
    request: new Request("https://yahoo-mcp.example/register", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    }),
  } as unknown as ClientRegistrationCallbackOptions;
}

const good = {
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
};

describe("checkRegistration", () => {
  it("lets a normal registration through untouched", async () => {
    expect(await checkRegistration(options(good))).toBeUndefined();
  });

  it("rejects a client_name longer than the cap", async () => {
    const r = await checkRegistration(
      options({
        ...good,
        client_name: "x".repeat(REGISTRATION_LIMITS.nameChars + 1),
      }),
    );
    expect(r).toMatchObject({ code: "invalid_client_metadata", status: 400 });
    expect(r?.description).toContain("client_name");
  });

  it("rejects too many redirect URIs, an over-long one, or none at all", async () => {
    const many = Array.from(
      { length: REGISTRATION_LIMITS.redirectUris + 1 },
      (_, i) => `https://claude.ai/cb${i}`,
    );
    expect(
      (await checkRegistration(options({ ...good, redirect_uris: many })))
        ?.description,
    ).toContain("redirect_uris");
    const long = `https://claude.ai/${"a".repeat(REGISTRATION_LIMITS.redirectUriChars)}`;
    expect(
      (await checkRegistration(options({ ...good, redirect_uris: [long] })))
        ?.description,
    ).toContain("redirect_uri is longer");
    expect(
      (await checkRegistration(options({ client_name: "x" })))?.description,
    ).toContain("required");
  });

  it("rejects a body larger than the cap even when the parsed metadata looks small", async () => {
    const padded = JSON.stringify({
      ...good,
      note: "y".repeat(REGISTRATION_LIMITS.bodyBytes),
    });
    const r = await checkRegistration(options(good, padded));
    expect(r?.description).toContain("bytes");
  });
});

describe("REGISTRATION_ENABLED", () => {
  it("answers 403 on /register when closed, and nothing else changes", async () => {
    const env = makeEnv(new FakeD1(), { REGISTRATION_ENABLED: "false" });
    const post = (path: string) =>
      new Request(`https://yahoo-mcp.example${path}`, {
        method: "POST",
        body: "{}",
      });
    expect(registrationClosed(post("/token"), env)).toBeNull();
    expect(
      registrationClosed(post("/register"), makeEnv(new FakeD1())),
    ).toBeNull();
    const res = registrationClosed(post("/register"), env)!;
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "access_denied" });
  });
});
