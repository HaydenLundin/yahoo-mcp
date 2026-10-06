import { describe, expect, it } from "vitest";
import { digestArgs } from "../src/lib/audit";
import { normalizeError, ToolError } from "../src/lib/errors";

describe("digestArgs", () => {
  it("is stable across key order and ignores message bodies", async () => {
    const a = await digestArgs({
      to: ["x@example.com"],
      subject: "Hi",
      body_text: "secret body",
    });
    const b = await digestArgs({
      subject: "Hi",
      body_text: "a completely different body",
      to: ["x@example.com"],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a non-body argument changes", async () => {
    const a = await digestArgs({ uids: [1, 2] });
    const b = await digestArgs({ uids: [1, 3] });
    expect(a).not.toBe(b);
  });
});

describe("normalizeError", () => {
  it("keeps ToolError as-is", () => {
    const e = new ToolError("X", "y");
    expect(normalizeError(e)).toBe(e);
  });

  it("maps imapflow authentication failures", () => {
    const e = normalizeError(
      Object.assign(new Error("Command failed"), {
        authenticationFailed: true,
      }),
    );
    expect(e.code).toBe("IMAP_AUTH_FAILED");
  });

  it("recognises Yahoo's login rate limit instead of blaming the password", () => {
    const e = normalizeError(
      Object.assign(new Error("Command failed"), {
        authenticationFailed: true,
        serverResponseCode: "LIMIT",
        responseText: "AUTHENTICATE Rate limit hit.",
      }),
    );
    expect(e.code).toBe("IMAP_RATE_LIMITED");
    expect(e.message).toContain("Wait a few minutes");
  });

  it("maps connection errors and server response codes", () => {
    expect(
      normalizeError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })).code,
    ).toBe("IMAP_CONNECT_FAILED");
    const e = normalizeError(
      Object.assign(new Error("Command failed"), {
        serverResponseCode: "NONEXISTENT",
        responseText: "no such box",
      }),
    );
    expect(e.code).toBe("IMAP_NONEXISTENT");
    expect(e.message).toBe("no such box");
  });

  it("falls back to INTERNAL", () => {
    expect(normalizeError(new Error("boom")).code).toBe("INTERNAL");
    expect(normalizeError("weird").code).toBe("INTERNAL");
  });
});
