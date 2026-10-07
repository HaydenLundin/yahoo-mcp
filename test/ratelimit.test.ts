import { describe, expect, it } from "vitest";
import { rateLimitGate } from "../src/lib/ratelimit";
import { FakeD1, makeEnv } from "./helpers/harness";

function limiter(blockedKeys: string[]) {
  const seen: string[] = [];
  const binding = {
    async limit({ key }: { key: string }) {
      seen.push(key);
      return { success: !blockedKeys.includes(key) };
    },
  } as unknown as RateLimit;
  return { binding, seen };
}

const post = (path: string, ip?: string) =>
  new Request(`https://yahoo-mcp.example${path}`, {
    method: "POST",
    headers: ip ? { "cf-connecting-ip": ip } : {},
  });

describe("rateLimitGate", () => {
  it("lets allowed addresses through and keys on the connecting IP", async () => {
    const token = limiter(["9.9.9.9"]);
    const env = makeEnv(new FakeD1(), { TOKEN_RATE_LIMITER: token.binding });
    expect(await rateLimitGate(post("/token", "1.2.3.4"), env)).toBeNull();
    expect(token.seen).toEqual(["1.2.3.4"]);
  });

  it("answers 429 with Retry-After for a throttled address", async () => {
    const token = limiter(["9.9.9.9"]);
    const env = makeEnv(new FakeD1(), { TOKEN_RATE_LIMITER: token.binding });
    const res = await rateLimitGate(post("/token", "9.9.9.9"), env);
    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBe("60");
    expect(await res?.json()).toMatchObject({ error: "slow_down" });
  });

  it("uses the registration limiter for /register and ignores other paths and methods", async () => {
    const token = limiter([]);
    const register = limiter(["5.5.5.5"]);
    const env = makeEnv(new FakeD1(), {
      TOKEN_RATE_LIMITER: token.binding,
      REGISTER_RATE_LIMITER: register.binding,
    });
    expect(
      (await rateLimitGate(post("/register", "5.5.5.5"), env))?.status,
    ).toBe(429);
    expect(await rateLimitGate(post("/mcp", "5.5.5.5"), env)).toBeNull();
    expect(
      await rateLimitGate(
        new Request("https://yahoo-mcp.example/token", { method: "GET" }),
        env,
      ),
    ).toBeNull();
    expect(token.seen).toEqual([]);
  });

  it("is a no-op when the binding is absent", async () => {
    const env = makeEnv(new FakeD1());
    expect(await rateLimitGate(post("/token", "1.2.3.4"), env)).toBeNull();
    expect(await rateLimitGate(post("/register"), env)).toBeNull();
  });
});
