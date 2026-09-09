import { createRemoteJWKSet, jwtVerify } from "jose";
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
    console.warn(
      "Access JWT verification failed",
      err instanceof Error ? err.message : err,
    );
    return new Response("Invalid Cloudflare Access token", { status: 403 });
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
