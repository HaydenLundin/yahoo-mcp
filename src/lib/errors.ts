/** Error with a stable machine-readable code, surfaced to MCP clients as `CODE: message`. */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

interface ImapLikeError {
  message?: string;
  code?: string;
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  responseText?: string;
}

const CONNECT_CODES = new Set([
  "ETIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** Normalise anything thrown by imapflow (or us) into a ToolError with a stable code. */
export function normalizeError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  const e = (err ?? {}) as ImapLikeError;
  if (e.serverResponseCode === "LIMIT" || /rate limit/i.test(e.responseText ?? "")) {
    return new ToolError(
      "IMAP_RATE_LIMITED",
      "Yahoo is rate-limiting IMAP logins for this account. Wait a few minutes and try again; the app password is fine.",
    );
  }
  if (e.authenticationFailed) {
    return new ToolError(
      "IMAP_AUTH_FAILED",
      "Yahoo rejected the app password. Generate a new one and run `wrangler secret put YAHOO_APP_PASSWORD`.",
    );
  }
  if (e.code === "InvalidStringValue") {
    // imapflow refused to put the value on the wire (control characters, quotes it cannot
    // escape). Nothing reached Yahoo; the argument was bad.
    return new ToolError(
      "INVALID_ARGUMENT",
      "A folder name or search value contains characters IMAP cannot carry (control characters or unescapable quotes).",
    );
  }
  if (e.code && CONNECT_CODES.has(e.code)) {
    return new ToolError(
      "IMAP_CONNECT_FAILED",
      `Could not reach Yahoo IMAP (${e.code}). Try again shortly.`,
    );
  }
  if (e.serverResponseCode) {
    return new ToolError(
      `IMAP_${e.serverResponseCode}`,
      e.responseText || e.message || "IMAP command failed",
    );
  }
  return new ToolError("INTERNAL", e.message || String(err));
}
