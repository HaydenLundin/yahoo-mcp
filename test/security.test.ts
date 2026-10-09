import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { requireOperator } from "../src/auth/access";
import { buildMessage, parseAddress } from "../src/lib/compose";
import { normalizeError } from "../src/lib/errors";
import type { Env } from "../src/types";

/**
 * Attack-shaped tests for the two trust boundaries we own outright: the Cloudflare Access
 * JWT check in front of the operator pages, and the outgoing-mail builder. The OAuth
 * provider and the MCP transport are exercised live by scripts/e2e-oauth.mjs instead.
 */

const TEAM = "team.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const AUD = "aud-for-this-app";
const KID = "key-1";

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
  otherKey = (await generateKeyPair("RS256")).privateKey;
  // jose fetches the JWKS with global fetch; serve our test key for the team domain only.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const env = (extra: Partial<Env> = {}): Env =>
  ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra }) as Env;

async function mint(
  opts: {
    key?: CryptoKey;
    iss?: string;
    aud?: string;
    email?: string | null;
    exp?: string | number;
    alg?: string;
  } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.email !== null) claims.email = opts.email ?? "operator@example.com";
  return new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: KID })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? privateKey);
}

const request = (
  token?: string,
  via: "header" | "cookie" = "header",
  url = "https://yahoo-mcp.example/authorize",
) =>
  new Request(url, {
    headers: token
      ? via === "header"
        ? { "cf-access-jwt-assertion": token }
        : { cookie: `other=1; CF_Authorization=${token}; more=2` }
      : {},
  });

const statusOf = (r: unknown) =>
  r instanceof Response ? r.status : "operator";

describe("Cloudflare Access gate", () => {
  it("accepts a token signed by the team key with the right issuer and audience, via header or cookie", async () => {
    const token = await mint();
    expect(await requireOperator(request(token), env())).toEqual({
      email: "operator@example.com",
    });
    expect(await requireOperator(request(token, "cookie"), env())).toEqual({
      email: "operator@example.com",
    });
  });

  it("refuses a token for another application (wrong aud)", async () => {
    expect(
      statusOf(
        await requireOperator(
          request(await mint({ aud: "someone-elses-app" })),
          env(),
        ),
      ),
    ).toBe(403);
  });

  it("refuses a token from another team (wrong iss)", async () => {
    expect(
      statusOf(
        await requireOperator(
          request(await mint({ iss: "https://other.cloudflareaccess.com" })),
          env(),
        ),
      ),
    ).toBe(403);
  });

  it("refuses an expired token", async () => {
    expect(
      statusOf(
        await requireOperator(
          request(await mint({ exp: Math.floor(Date.now() / 1000) - 60 })),
          env(),
        ),
      ),
    ).toBe(403);
  });

  it("refuses a token signed by a different key, even with the team's kid", async () => {
    expect(
      statusOf(
        await requireOperator(request(await mint({ key: otherKey })), env()),
      ),
    ).toBe(403);
  });

  it("refuses alg=none", async () => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = `${b64({ alg: "none", kid: KID })}.${b64({ iss: ISSUER, aud: AUD, email: "attacker@evil.example", exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
    expect(statusOf(await requireOperator(request(forged), env()))).toBe(403);
  });

  it("refuses an HMAC token that reuses the public key as the secret (key confusion)", async () => {
    const secret = new TextEncoder().encode(JSON.stringify(jwk));
    const forged = await new SignJWT({ email: "attacker@evil.example" })
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime("1h")
      .sign(secret);
    expect(statusOf(await requireOperator(request(forged), env()))).toBe(403);
  });

  it("refuses a valid token that carries no email", async () => {
    expect(
      statusOf(
        await requireOperator(request(await mint({ email: null })), env()),
      ),
    ).toBe(403);
  });

  it("asks for a token when none is presented, and reports a missing configuration", async () => {
    expect(statusOf(await requireOperator(request(), env()))).toBe(401);
    expect(
      statusOf(
        await requireOperator(
          request(await mint()),
          env({ ACCESS_AUD: undefined }),
        ),
      ),
    ).toBe(503);
  });

  it("never echoes the token in the diagnostic response", async () => {
    const token = await mint({ aud: "wrong" });
    const res = (await requireOperator(request(token), env())) as Response;
    const body = await res.text();
    expect(body).not.toContain(token);
    expect(body).toContain("aud=wrong");
  });

  it("honours ACCESS_DEV_BYPASS only on a loopback host", async () => {
    const bypass = env({ ACCESS_DEV_BYPASS: "true" });
    expect(
      await requireOperator(
        request(undefined, "header", "http://localhost:8787/authorize"),
        bypass,
      ),
    ).toEqual({
      email: "dev-bypass@localhost",
    });
    expect(
      statusOf(
        await requireOperator(
          request(undefined, "header", "https://yahoo-mcp.example/authorize"),
          bypass,
        ),
      ),
    ).toBe(401);
    expect(
      statusOf(
        await requireOperator(
          request(
            undefined,
            "header",
            "https://localhost.evil.example/authorize",
          ),
          bypass,
        ),
      ),
    ).toBe(401);
  });
});

describe("outgoing mail cannot be shaped by header injection", () => {
  const base = { from: "me@yahoo.com", to: ["friend@example.com"], text: "hi" };
  const headerBlock = (raw: string) => raw.split("\r\n\r\n")[0].split("\r\n");

  it("encodes a subject that smuggles CRLF so no new header appears", () => {
    const raw = buildMessage({
      ...base,
      subject: "Hello\r\nBcc: attacker@evil.example\r\nX-Injected: 1",
    });
    const lines = headerBlock(raw);
    expect(lines.some((l) => /^(Bcc|X-Injected):/i.test(l))).toBe(false);
    expect(lines.find((l) => l.startsWith("Subject:"))).toMatch(
      /^Subject: =\?UTF-8\?B\?/,
    );
    expect(raw).not.toContain("attacker@evil.example");
  });

  it("rejects recipient strings that try to escape the angle brackets or add lines", () => {
    for (const bad of [
      "friend@example.com\r\nBcc: attacker@evil.example",
      "Friend <friend@example.com>\r\nBcc: attacker@evil.example",
      "friend@example.com>\r\nRCPT TO:<attacker@evil.example",
      "friend@example.com\nX: y",
    ]) {
      expect(() => parseAddress(bad), bad).toThrow(/Not a valid email address/);
      expect(
        () => buildMessage({ ...base, to: [bad], subject: "x" }),
        bad,
      ).toThrow();
    }
  });

  it("escapes a quote inside a display name so the header stays one well-formed line", () => {
    const raw = buildMessage({
      ...base,
      to: ['friend@example.com" <x@y.example>'],
      subject: "x",
    });
    const to = headerBlock(raw).find((l) => l.startsWith("To:")) ?? "";
    expect(to).toBe('To: "friend@example.com\\"" <x@y.example>');
  });

  it("keeps a display name with specials harmless by quoting it", () => {
    const raw = buildMessage({
      ...base,
      to: ['Evil "Name" <friend@example.com>'],
      subject: "x",
    });
    const to = headerBlock(raw).find((l) => l.startsWith("To:")) ?? "";
    expect(to).toContain("<friend@example.com>");
    expect(headerBlock(raw).filter((l) => /^To:/.test(l))).toHaveLength(1);
  });
});

describe("IMAP refusals are reported as the caller's mistake", () => {
  it("maps imapflow refusing to quote a hostile string to INVALID_ARGUMENT, not INTERNAL", () => {
    const err = Object.assign(
      new Error("Unquotable character in IMAP string value"),
      { code: "InvalidStringValue" },
    );
    expect(normalizeError(err).code).toBe("INVALID_ARGUMENT");
  });
});
