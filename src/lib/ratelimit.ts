import type { Env } from "../types";

/**
 * Per-IP throttles on the two OAuth endpoints an attacker can hit without any credential
 * (ARCHITECTURE.md section 9). Backed by Workers Rate Limiting bindings, which are free and
 * local to the colo. Limits are generous for one operator's handful of clients and tight for
 * a brute-force or registration flood. When a binding is absent (tests, a stripped-down local
 * config) the gate is a no-op.
 */
const LIMITED: Record<string, (env: Env) => RateLimit | undefined> = {
  "/token": (env) => env.TOKEN_RATE_LIMITER,
  "/register": (env) => env.REGISTER_RATE_LIMITER,
};

/**
 * One key per client address. An IPv6 client usually owns a whole /64, so the key is the /64
 * prefix there; otherwise a flooder rotates addresses and never hits the limit.
 */
export function rateLimitKey(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip;
}

function expandIpv6(ip: string): string[] | null {
  const [head = "", tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (!ip.includes("::")) return h.length === 8 ? h : null;
  const fill = 8 - h.length - t.length;
  return fill < 0 ? null : [...h, ...Array<string>(fill).fill("0"), ...t];
}

export async function rateLimitGate(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const pick = LIMITED[new URL(request.url).pathname];
  const limiter = pick?.(env);
  if (!limiter) return null;

  const key = rateLimitKey(request.headers.get("cf-connecting-ip"));
  const { success } = await limiter.limit({ key });
  if (success) return null;

  return new Response(
    JSON.stringify({
      error: "slow_down",
      error_description:
        "Too many requests from this address. Try again in a minute.",
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "60",
        "cache-control": "no-store",
      },
    },
  );
}
