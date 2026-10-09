import { describe, expect, it } from "vitest";
import { authApp } from "../src/auth/consent";
import type { Env } from "../src/types";
import { FakeD1, makeEnv } from "./helpers/harness";

/**
 * The consent handler's error paths. The provider validates the request; what we own is turning
 * its refusals into proper OAuth error responses that still carry the security headers.
 */

function envWith(provider: Record<string, unknown>): Env {
  return makeEnv(new FakeD1(), {
    OAUTH_PROVIDER: provider as unknown as Env["OAUTH_PROVIDER"],
    ACCESS_DEV_BYPASS: "true",
  });
}

const authorizationError = (extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("Public clients must use PKCE"), {
    code: "invalid_request",
    description: "Public clients must use PKCE with the S256 method",
    ...extra,
  });

describe("consent page error paths", () => {
  it("sends a validated client back to its redirect URI with the OAuth error, security headers intact", async () => {
    const env = envWith({
      parseAuthRequest: async () => {
        throw authorizationError({
          redirectUri: "http://localhost:9999/cb",
          state: "s1",
          issuer: "http://localhost",
        });
      },
    });
    const res = await authApp.request(
      "http://localhost/authorize?client_id=x",
      {},
      env,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe("http://localhost:9999/cb");
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("s1");
    expect(loc.searchParams.get("iss")).toBe("http://localhost");
    expect(res.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
  });

  it("renders the error locally when the redirect URI was not validated", async () => {
    const env = envWith({
      parseAuthRequest: async () => {
        throw authorizationError();
      },
    });
    const res = await authApp.request(
      "http://localhost/authorize?client_id=x",
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_request");
  });

  it("answers 400, not 500, when a URL-shaped client_id cannot be resolved", async () => {
    const env = envWith({
      parseAuthRequest: async () => {
        const e = new Error(
          "CIMD fetch failed for https://evil.example/client.json",
        );
        e.name = "CimdFetchError";
        throw Object.assign(e, {
          metadataUrl: "https://evil.example/client.json",
        });
      },
    });
    const res = await authApp.request(
      "http://localhost/authorize?client_id=https://evil.example/client.json",
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_client");
  });

  it("still fails loudly on an unexpected error", async () => {
    const env = envWith({
      parseAuthRequest: async () => {
        throw new Error("KV unavailable");
      },
    });
    const res = await authApp.request(
      "http://localhost/authorize?client_id=x",
      {},
      env,
    );
    expect(res.status).toBe(500);
  });
});
