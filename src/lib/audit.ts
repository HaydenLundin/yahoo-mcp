import type { Env, GrantProps } from "../types";

export type AuditOutcome = "ok" | "error" | "denied";

export interface AuditEntry {
  tool: string;
  /** sha256 of canonical args without message bodies; "" for read tools. */
  argsDigest: string;
  uids?: number[] | null;
  outcome: AuditOutcome;
}

/** Append one row to audit_log. Never throws: an audit failure must not break a tool call. */
export async function writeAudit(
  env: Env,
  props: GrantProps,
  entry: AuditEntry,
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (ts, client_id, client_name, tool, args_digest, uids, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
      .bind(
        Date.now(),
        props.clientId,
        props.clientName,
        entry.tool,
        entry.argsDigest,
        entry.uids ? JSON.stringify(entry.uids) : null,
        entry.outcome,
      )
      .run();
  } catch (err) {
    console.error("audit_log write failed", err);
  }
}

/** Keys whose values are message content; excluded from digests so bodies never touch the log. */
const BODY_KEYS = new Set(["body_text", "body_html", "note"]);

/** sha256 hex over canonical (sorted-key) JSON of args with bodies removed. */
export async function digestArgs(args: unknown): Promise<string> {
  const canonical = JSON.stringify(sortKeys(args) ?? null);
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .filter((k) => !BODY_KEYS.has(k))
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}
