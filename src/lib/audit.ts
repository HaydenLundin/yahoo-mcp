import type { Env, GrantProps } from "../types";

export type AuditOutcome = "ok" | "error" | "denied";

export interface AuditEntry {
  tool: string;
  /** sha256 of canonical args without message bodies; "" for read tools. */
  argsDigest: string;
  uids?: number[] | null;
  outcome: AuditOutcome;
  /** Counts, folder names, message ids: what an irreversible action touched. Never addresses or bodies. */
  detail?: Record<string, unknown>;
}

/** Rows older than this are purged by the cron (ARCHITECTURE.md section 7). */
export const AUDIT_RETENTION_DAYS = 180;

/** Append one row to audit_log. Never throws: an audit failure must not break a tool call. */
export async function writeAudit(
  env: Env,
  props: GrantProps,
  entry: AuditEntry,
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (ts, client_id, client_name, tool, args_digest, uids, outcome, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
      .bind(
        Date.now(),
        props.clientId,
        props.clientName,
        entry.tool,
        entry.argsDigest,
        entry.uids ? JSON.stringify(entry.uids) : null,
        entry.outcome,
        entry.detail ? JSON.stringify(entry.detail) : null,
      )
      .run();
  } catch (err) {
    console.error("audit_log write failed", err);
  }
}

export async function purgeOldAudit(
  env: Env,
  days = AUDIT_RETENTION_DAYS,
): Promise<number> {
  const res = await env.DB.prepare("DELETE FROM audit_log WHERE ts < ?1")
    .bind(Date.now() - days * 86_400_000)
    .run();
  return res.meta?.changes ?? 0;
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
