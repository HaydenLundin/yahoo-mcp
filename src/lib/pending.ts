import type { Env } from "../types";

/**
 * Phase one of a send writes a row here; phase two consumes it. The token is the only thing
 * the model gets back, the fully rendered message stays server-side, and nothing touches SMTP
 * until confirm_send. Rows expire after PENDING_TTL_MS and a cron sweep removes stragglers.
 */
export const PENDING_TTL_MS = 5 * 60_000;

export type PendingKind = "send" | "reply" | "forward";

export interface PendingPreview {
  kind: PendingKind;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body_text: string;
  in_reply_to_uid?: number;
  forwarded_uid?: number;
  attachments_omitted?: string[];
}

export interface PendingRow {
  token: string;
  clientId: string;
  kind: PendingKind;
  preview: PendingPreview;
  mime: string;
  createdAt: number;
  expiresAt: number;
}

export async function createPending(
  env: Env,
  clientId: string,
  preview: PendingPreview,
  mime: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + PENDING_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO pending_sends (token, client_id, kind, preview, mime, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(
      token,
      clientId,
      preview.kind,
      JSON.stringify(preview),
      new TextEncoder().encode(mime),
      now,
      expiresAt,
    )
    .run();
  return { token, expiresAt };
}

export type TakeResult =
  | { status: "ok"; row: PendingRow }
  | { status: "missing" | "expired" | "wrong_client" };

/**
 * Consume a token. Single use: a valid row is deleted before it is returned, so a retried
 * confirm_send can never send twice. A row belonging to another client is left untouched
 * and reported as wrong_client; callers surface that as an ordinary invalid token.
 */
export async function takePending(
  env: Env,
  token: string,
  clientId: string,
): Promise<TakeResult> {
  const raw = await env.DB.prepare(
    "SELECT token, client_id, kind, preview, mime, created_at, expires_at FROM pending_sends WHERE token = ?1",
  )
    .bind(token)
    .first<RawRow>();
  if (!raw) return { status: "missing" };
  if (raw.client_id !== clientId) return { status: "wrong_client" };
  await env.DB.prepare("DELETE FROM pending_sends WHERE token = ?1")
    .bind(token)
    .run();
  if (raw.expires_at < Date.now()) return { status: "expired" };
  return { status: "ok", row: toRow(raw) };
}

export async function deletePending(
  env: Env,
  token: string,
  clientId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM pending_sends WHERE token = ?1 AND client_id = ?2",
  )
    .bind(token, clientId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Cron sweep (ARCHITECTURE.md section 7). */
export async function purgeExpiredPending(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    "DELETE FROM pending_sends WHERE expires_at < ?1",
  )
    .bind(Date.now())
    .run();
  return res.meta?.changes ?? 0;
}

interface RawRow {
  token: string;
  client_id: string;
  kind: PendingKind;
  preview: string;
  mime: ArrayBuffer | Uint8Array | string;
  created_at: number;
  expires_at: number;
}

function toRow(r: RawRow): PendingRow {
  const mime =
    typeof r.mime === "string"
      ? r.mime
      : new TextDecoder("utf-8").decode(
          r.mime instanceof Uint8Array ? r.mime : new Uint8Array(r.mime),
        );
  return {
    token: r.token,
    clientId: r.client_id,
    kind: r.kind,
    preview: JSON.parse(r.preview) as PendingPreview,
    mime,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** 32 random bytes, base64url: unguessable, URL-safe, 43 characters. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
