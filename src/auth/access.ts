import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { Env } from "../types";

export interface Operator {
  email: string;
}

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Layer A of the auth design: only the operator may reach the consent page.
 * Cloudflare Access sits in front of /authorize and injects a signed JWT; we verify it
 * against the team's JWKS and the app's AUD. Returns the operator, or a Response to send instead.
 */
export async function requireOperator(
  req: Request,
  env: Env,
): Promise<Operator | Response> {
  const url = new URL(req.url);

  if (env.ACCESS_DEV_BYPASS === "true" && LOCAL_HOSTS.has(url.hostname)) {
    console.warn(
      "ACCESS_DEV_BYPASS active: skipping Cloudflare Access check for",
      url.pathname,
    );
    return { email: "dev-bypass@localhost" };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return new Response(
      "Cloudflare Access is not configured on this deployment (ACCESS_TEAM_DOMAIN / ACCESS_AUD).",
      { status: 503 },
    );
  }

  const token =
    req.headers.get("cf-access-jwt-assertion") ??
    readCookie(req, "CF_Authorization");
  if (!token) {
    return new Response(
      "Missing Cloudflare Access token. Is /authorize behind an Access application?",
      {
        status: 401,
      },
    );
  }

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
    });
    const email = typeof payload.email === "string" ? payload.email : undefined;
    if (!email)
      return new Response("Access token has no email claim", { status: 403 });
    return { email };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const claims = describeClaims(token);
    console.warn("Access JWT verification failed:", reason, "|", claims);
    // Only visitors who already passed Cloudflare Access reach this handler, so the reader
    // is the operator. Name the mismatched claim so the fix is obvious; never echo the token.
    return new Response(
      [
        `Invalid Cloudflare Access token: ${reason}.`,
        `Token claims: ${claims}.`,
        `This server expects iss=${issuer} and aud=${env.ACCESS_AUD}.`,
        "Fix the mismatched secret with `wrangler secret put ACCESS_TEAM_DOMAIN` or `wrangler secret put ACCESS_AUD`, then retry.",
      ].join("\n"),
      { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}

/** Unverified read of iss/aud/exp for diagnostics only. Never use these for authorization. */
function describeClaims(token: string): string {
  try {
    const { iss, aud, exp } = decodeJwt(token);
    const audText = Array.isArray(aud) ? aud.join(",") : aud;
    const expText = exp ? new Date(exp * 1000).toISOString() : "none";
    return `iss=${iss ?? "none"} aud=${audText ?? "none"} exp=${expText}`;
  } catch {
    return "token is not a decodable JWT";
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
