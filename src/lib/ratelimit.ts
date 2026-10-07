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

export async function rateLimitGate(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const pick = LIMITED[new URL(request.url).pathname];
  const limiter = pick?.(env);
  if (!limiter) return null;

  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
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
