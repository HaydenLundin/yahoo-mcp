import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Worker bindings and secrets. Secrets are set with `wrangler secret put`; locally via `.dev.vars`. */
export interface Env {
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  /** Injected by @cloudflare/workers-oauth-provider. */
  OAUTH_PROVIDER: OAuthHelpers;

  YAHOO_USER: string;
  YAHOO_APP_PASSWORD: string;
  /** "true" registers the send tools; anything else hides them from every client. */
  SEND_ENABLED?: string;

  /** Cloudflare Access team domain, e.g. "acme.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag of the Access app that guards /authorize. */
  ACCESS_AUD?: string;
  /**
   * Local development only. Skips the Access check on /authorize, and even then
   * only when the request host is localhost. Never set this in production.
   */
  ACCESS_DEV_BYPASS?: string;
  /** Comma-separated browser origins allowed to call /mcp besides our own (e.g. MCP Inspector). */
  ALLOWED_ORIGINS?: string;
}

/** Stored encrypted on the grant by the OAuth provider; surfaces as ctx.props on every /mcp call. */
export interface GrantProps {
  clientId: string;
  clientName: string;
  scopes: Scope[];
  grantedAt: number;
  /** Operator identity that approved the grant (email from Cloudflare Access). */
  grantedBy: string;
}

export const SCOPES = [
  "mail.read",
  "mail.draft",
  "mail.organize",
  "mail.send",
] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_TEXT: Record<Scope, string> = {
  "mail.read":
    "Search and read messages, threads, folders, and attachment names (never attachment contents)",
  "mail.draft": "Create, edit, and delete drafts",
  "mail.organize":
    "Move, archive, trash, flag, and mark messages read or unread (never permanent delete)",
  "mail.send":
    "Send, reply, and forward, with a preview you must confirm before anything leaves the mailbox",
};
