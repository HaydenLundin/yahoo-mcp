# yahoo-mcp — Architecture Spec

Remote MCP server exposing a single Yahoo Mail account to multiple AI clients with Gmail-connector-parity permissions.

**Tier-1 clients (tested before each release):** claude.ai web/mobile, Claude Desktop, Claude Code, ChatGPT web/mobile, OpenAI Codex CLI.
**Tier-2 (should work, verified once):** Cursor, Windsurf, any client that speaks Streamable HTTP + OAuth 2.1 with DCR. Google Antigravity CLI is not planned at this time (operator decision, 2026-10-07); its notes below are kept for reference.

The design is client-agnostic by construction: it targets the strictest client (claude.ai) and everything else is a subset.

Status: **all seven milestones built.** Verified live from Claude Code, claude.ai (web and mobile), ChatGPT, and Codex CLI. Appendix §12 lists the stable error codes. See §10 for the spike outcome and §6 for the IMAP compression note.

---

## 1. Goals / non-goals

**Goals**
- One HTTPS endpoint, one OAuth flow, every client connects the same way.
- Works from claude.ai on a phone (this rules out anything stdio/local).
- Permission surface mirrors Anthropic's Gmail connector: read, draft, organize, send-with-approval. No attachment content, no permanent delete.
- Single user (the operator). No multi-tenant concerns.
- Cheap: target $0/mo on free tiers, ceiling ~$5/mo.
- Portfolio-quality: typed, tested, audited.

**Non-goals (v1)**
- Multiple mailboxes / multiple users
- XOAUTH2 to Yahoo (app password only)
- IMAP IDLE / push
- Attachment download
- Calendar

---

## 2. Client requirements (drive the spec)

| Client | Transport | Auth | Add method |
|---|---|---|---|
| claude.ai web + iOS/Android | Streamable HTTP (SSE legacy, deprecated) | OAuth 2.1, DCR, PKCE S256. **Refuses no-auth servers.** Callback `https://claude.ai/api/mcp/auth_callback` | Settings → Connectors → Add custom connector → paste URL. Syncs to mobile. |
| Claude Desktop | same as claude.ai | same | same UI, or `mcp-remote` shim in `claude_desktop_config.json` |
| Claude Code | Streamable HTTP | OAuth, loopback redirect | `claude mcp add --transport http yahoo https://<host>/mcp` |
| ChatGPT web + iOS/Android | Streamable HTTP over HTTPS only (no stdio, no localhost) | OAuth 2.1 with DCR (ChatGPT registers its redirect URI dynamically). | Settings → Apps & Connectors → Advanced → **Developer mode** on → Create → paste URL → auth "OAuth". Paid plan required. Connector then must be enabled per-conversation from the composer. |
| Codex CLI | Streamable HTTP | OAuth or bearer | `codex mcp add yahoo --url https://<host>/mcp` then `codex mcp login yahoo` |
| Antigravity CLI (`agy`) | Streamable HTTP (inherits Gemini CLI schema: `httpUrl` field; `url` = SSE) | OAuth (`oauth.enabled: true`) | No `mcp add` verb. Paste into `~/.gemini/config/mcp_config.json` (see §2.1). Fallback: `mcp-remote` stdio wrapper. |

Gemini CLI itself was retired for free / AI Pro / AI Ultra tiers on 2026-06-18; only Code Assist Standard/Enterprise and paid-API-key users still have it. Don't target it.

### 2.1 ChatGPT-specific notes

- Developer mode is the gate for general-purpose custom connectors. Plan availability has shifted across 2026 (reported on Plus/Pro/Business/Enterprise/Edu; Free excluded). Verify on the operator's plan before milestone 6.
- Connectors are created on web; the ChatGPT mobile apps use the same account-level connector list. Community reports of connectors "vanishing" or OAuth completing without tools appearing exist — retest after any OpenAI UI change.
- ChatGPT prompts the user before invoking tools that are not marked read-only. **Set MCP tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on every tool (see §5.6). This makes ChatGPT's native confirmation UX line up with our two-phase send, and is harmless for other clients.
- ChatGPT historically expected `search` and `fetch` tools for Deep Research connectors. Not required in Developer mode, but exposing thin `search`/`fetch` aliases over `search_messages`/`get_message` is a cheap compatibility win (milestone 6, optional).

### 2.2 Antigravity-specific notes

- Config path: `~/.gemini/config/mcp_config.json` (the path baked into the `agy` binary; some third-party docs cite `~/.gemini/antigravity/mcp_config.json` — treat the former as canonical, verify on install).
- Native HTTP + OAuth snippet (Gemini CLI schema, expected to carry over):
  ```json
  { "mcpServers": { "yahoo": { "httpUrl": "https://<host>/mcp", "oauth": { "enabled": true } } } }
  ```
- If native OAuth fails, wrap with `mcp-remote`:
  ```json
  { "mcpServers": { "yahoo": { "command": "npx", "args": ["-y", "mcp-remote", "https://<host>/mcp"] } } }
  ```
- Antigravity is Tier-2: confirm once, document, don't block releases on it.

**Derived hard requirements**
- `POST /mcp` Streamable HTTP, MCP spec ≥ 2025-06-18. Support `HEAD /mcp` (claude.ai probes it).
- `GET /.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414). Serve both root and path-suffixed variants (`/.well-known/oauth-protected-resource/mcp`) — claude.ai has been observed requesting either.
- `POST /register` — RFC 7591 Dynamic Client Registration. (MCP 2026-07-28 deprecates DCR in favor of CIMD; keep DCR on for client compatibility.)
- `GET /authorize`, `POST /token` — auth code + PKCE S256, refresh tokens with rotation.
- `401` on `/mcp` must carry `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`.
- Validate `redirect_uri` against registered URIs exactly. Validate `Origin` on `/mcp` (DNS rebinding).

---

## 3. Deployment target

**Primary: single Cloudflare Worker.**

Rationale: as of compatibility date `2026-08-04`, `nodejs_compat` + `nodejs_compat_v2` are on by default in workerd, and the runtime provides client-side `node:net` and `node:tls` (backed by `cloudflare:sockets`). `imapflow` and `nodemailer` only need the client side. Server-side APIs (`net.Server`, `tls.createServer`) are unsupported, which is fine.

```
MCP client
   │  POST /mcp  (Streamable HTTP, Bearer)
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Cloudflare Worker  (wrangler, TypeScript, Hono router)      │
│                                                             │
│  @cloudflare/workers-oauth-provider                         │
│    ├─ /.well-known/*   /register   /authorize   /token      │
│    └─ state → KV: OAUTH_KV                                  │
│                                                             │
│  /authorize  ← Cloudflare Access (one-email allowlist)      │
│                                                             │
│  McpAgent (agents SDK)  or  @modelcontextprotocol/sdk       │
│    └─ tools/read.ts  draft.ts  organize.ts  send.ts         │
│                                                             │
│  lib/imap.ts   (imapflow, per-call connect/logout)          │
│  lib/smtp.ts   (nodemailer)                                 │
│                                                             │
│  D1: pending_sends, audit_log                               │
│  Secrets: YAHOO_USER, YAHOO_APP_PASSWORD, SEND_ENABLED      │
└─────────────────────────────────────────────────────────────┘
        │ 993/TLS                      │ 465/TLS
        ▼                              ▼
  imap.mail.yahoo.com           smtp.mail.yahoo.com
```

**Fallback (only if §10 spike fails):** Worker keeps OAuth + MCP transport + D1; IMAP/SMTP moves to a Vercel Node function (`/api/imap`) called with a shared `INTERNAL_SECRET` header. Each MCP tool call = one short IMAP session, so function limits are not a concern. Two deployables; avoid unless forced.

**Rejected**
- Vercel-only: serverless is poor for raw sockets; can't host the OAuth server cleanly.
- Neon Postgres: state is tiny; KV + D1 are free and single-vendor. `workers-oauth-provider` requires KV regardless.
- Cloudflare Access on the whole origin: forces bypass rules for every OAuth path. Scope Access to `/authorize` only.

---

## 4. Auth design

Two layers, both on the Worker.

**Layer A — human identity (who is allowed to grant access).**
Cloudflare Access application on `https://<host>/authorize` with policy `Allow: emails = [<operator email>]`. Free tier (≤50 users). Access injects `Cf-Access-Jwt-Assertion`; the `/authorize` handler verifies it against the team's JWKS and refuses otherwise. This replaces a login page.

**Layer B — MCP client authorization (OAuth 2.1).**
`@cloudflare/workers-oauth-provider` wraps the Worker:
```ts
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpHandler,          // gets ctx.props from the grant
  defaultHandler: AuthorizeUI,     // renders consent at /authorize
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mail.read", "mail.draft", "mail.organize", "mail.send"],
});
```
- Access tokens opaque, stored hashed in KV by the library.
- Refresh tokens rotate on use.
- Consent screen shows the client's registered name + requested scopes; approve button only. (Single user; no per-scope toggles in v1. Scopes are still recorded on the grant for audit.)
- Grant `props` = `{ clientId, clientName, scopes, grantedAt }` → available to every tool call for the audit log.

**Secrets** (`wrangler secret put`): `YAHOO_USER`, `YAHOO_APP_PASSWORD`, `SEND_ENABLED` (`"true"|"false"`), `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`.

---

## 5. Tool manifest (Gmail-connector parity)

Reference: Anthropic's Gmail connector = search/read, drafts, labels/threads, attachment *metadata* only, send/reply/forward with approval by default. No permanent delete. Map to IMAP:

### 5.1 Read (`mail.read`)

| Tool | Params | Returns |
|---|---|---|
| `search_messages` | `query?, from?, to?, subject?, since?, before?, unread_only?, flagged_only?, folder="INBOX", limit=20, offset=0` | `{ messages: [{uid, folder, from, to, cc, subject, date, flags, unread, flagged, has_attachments, size}], total, has_more }` — headers only, never bodies; `total` is `null` when unknown (see §6) |
| `get_message` | `uid, folder="INBOX", format="text"\|"html"` | headers + body + `attachments: [{filename, mime, size}]` (no content) |
| `get_thread` | `uid, folder="INBOX", include_bodies=false` | messages in the same conversation, oldest first. Uses the server-side OBJECTID `THREADID` when Yahoo provides one, else the References / In-Reply-To chain. `include_bodies` adds plain-text bodies (first 20 messages, 20 KB each) so a thread can be summarised in one call |
| `list_folders` | — | `[{path, delimiter, special_use?}]` |
| `list_drafts` | `limit=20` | same shape as `search_messages` over Drafts |

### 5.2 Draft (`mail.draft`)

| Tool | Params | Behavior |
|---|---|---|
| `create_draft` | `to[], cc?[], bcc?[], subject, body_text, body_html?, in_reply_to_uid?, in_reply_to_folder="INBOX"` | IMAP `APPEND` to Drafts (found by `\Drafts` special-use) with `\Draft \Seen`; quoted-printable UTF-8, `multipart/alternative` when `body_html` is given; sets In-Reply-To/References from the original when replying. Bcc is kept on the draft so the user sees it |
| `update_draft` | `uid, ...same` | full replacement: append new, then `UID EXPUNGE` the old one (IMAP has no in-place edit). The old draft is only removed after the new one is saved |
| `delete_draft` | `uid` | hard delete from Drafts — the only expunge in the system |

### 5.3 Organize (`mail.organize`)

| Tool | Params |
|---|---|
| `move_messages` | `uids[], to_folder, from_folder="INBOX"` |
| `archive_messages` | `uids[], from_folder="INBOX"` → `Archive` |
| `trash_messages` | `uids[], from_folder="INBOX"` → `Trash`. **No `permanent` option.** |
| `mark_read` / `mark_unread` | `uids[], folder="INBOX"` |
| `flag_messages` / `unflag_messages` | `uids[], folder="INBOX"` (`\Flagged` = Gmail star) |

Yahoo has no labels; folders + `\Flagged` are the analogue. `create_folder` is **not** exposed in v1.

### 5.4 Send — gated (`mail.send`)

Two-phase. Phase 1 never touches SMTP.

| Tool | Params | Returns |
|---|---|---|
| `send_message` | `to[], cc?[], bcc?[], subject, body_text, body_html?` | `{ confirm_token, expires_at, preview: {to, cc, bcc, subject, body_text} }` |
| `reply_message` | `uid, folder?, body_text, body_html?, reply_all=false` | same |
| `forward_message` | `uid, folder?, to[], note?` | same |
| `confirm_send` | `confirm_token` | sends via SMTP, appends copy to Sent, deletes token, writes audit row |
| `cancel_send` | `confirm_token` | deletes token |

Rules:
- Token: 32 random bytes, base64url, single-use, 5-minute TTL, row in D1 `pending_sends` with the fully rendered MIME payload.
- `confirm_send` tool description (verbatim, matters for model behavior): *"Send a message previously prepared by send_message / reply_message / forward_message. ONLY call this after the user has explicitly confirmed the preview in the current turn. Never call it speculatively."*
- If `SEND_ENABLED != "true"`, none of the five send tools are registered. `tools/list` simply doesn't include them.
- A token is consumed the moment `confirm_send` reads it, before SMTP is attempted, so a retried confirm can never send twice. If SMTP then fails, the tool reports the error and the user re-prepares; nothing is silently retried.
- `reply_message`: Reply-To wins over From; this account is never a recipient of its own reply, and replying to a message we sent goes to its original recipients. `reply_all` adds the original To and Cc minus this account.
- `forward_message` forwards the plain text with a header block (From, Date, Subject, To) under an optional note. Attachments are never forwarded; their names are returned as `attachments_omitted` so the model can say so.
- After a successful send the rendered message is `APPEND`ed to the `\\Sent` special-use folder with `\\Seen`, because Yahoo does not file SMTP sends itself. A failure there is reported as `saved_to_sent: false`, not as a failed send.

### 5.5 Explicitly not exposed
`get_attachment`, `expunge`, `delete_folder`, `rename_folder`, raw `set_flags`, `create_folder`, account management, anything that reads another mailbox.

### 5.6 Tool annotations (MCP `ToolAnnotations`)

Every tool declares annotations. ChatGPT uses them to decide whether to prompt the user; Claude clients surface them in the tool list; they cost nothing elsewhere.

| Tools | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|
| all §5.1 read tools, and the `search` / `fetch` aliases (§2.1) | `true` | `false` | `true` | `false` |
| `create_draft`, `update_draft` | `false` | `false` | `false` | `false` |
| `delete_draft` | `false` | `true` | `true` | `false` |
| §5.3 organize tools | `false` | `false` | `true` | `false` |
| `send_message`, `reply_message`, `forward_message` (phase 1) | `false` | `false` | `false` | `false` |
| `confirm_send` | `false` | `true` | `false` | **`true`** (leaves the mailbox) |
| `cancel_send` | `false` | `false` | `true` | `false` |

Phase-1 send tools are deliberately *not* destructive — they only write a D1 row — so clients that auto-prompt on destructive tools prompt once, at `confirm_send`, not twice.

---

## 6. IMAP / SMTP layer

`lib/imap.ts`
- One `ImapFlow` per tool call: `connect → getMailboxLock → op → lock.release → logout`. No pooling (Workers isolates are ephemeral; Yahoo tolerates short sessions).
- Always UID-based (`uid: true` on fetch/search/move). Sequence numbers appear only as search *criteria* in `pagedSearch` windows, never to address a message.
- **COMPRESS=DEFLATE stays on** (imapflow's default). It was disabled for a day as a workaround for an imapflow 2.0.x bug, not a Workers limitation: imapflow 2.0.0's `ImapStream` cleared its input-loop guard a few microtasks after finding its queue empty, and on workerd a chunk delivered in that gap was never processed (postalsys/imapflow#408, fixed in 2.1.0). Compression made it near-deterministic because the inflater hands over several 16 KiB chunks per socket read, so every highly compressible response over 16 KB (uid lists, text bodies) stalled to `socketTimeout`. Found 2026-10-06, misattributed to workerd's `node:zlib` on 2026-10-07, corrected the same day with a standalone inflate test under `spike/zlib-lab/`, and closed by upgrading to imapflow 2.2.8, now 2.2.10: the spike probe (10,000-uid search, 1000-message fetch, 170 KB body) and the full e2e pass with compression on. `pagedSearch` (1000-message sequence windows, newest first) and ranged 60 KB body fetches stay as defence in depth; `search_messages.total` is exact when the folder was fully scanned or the search was unfiltered, else `null` with `has_more: true`.
- Yahoo specifics: host `imap.mail.yahoo.com:993` `secure:true`; special-use folders are `Archive`, `Bulk Mail`, `Draft`, `Sent`, `Trash` — resolve via `list()` special-use flags, don't hardcode names. Yahoo does support `MOVE`.
- Timeouts: 15s connect, 30s per op. Surface IMAP errors as MCP tool errors with a stable `code`.
- Body handling: prefer `text/plain`; if only HTML, run through a sanitizer and produce text. Cap body at 50 KB in responses; note truncation.

`lib/smtp.ts`
- A ~200-line SMTP client of our own over `node:tls` to `smtp.mail.yahoo.com:465`: EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA (dot-stuffed), QUIT, with per-step timeouts and stable error codes (`SMTP_AUTH_FAILED`, `SMTP_RECIPIENT_REJECTED`, `SMTP_MESSAGE_REJECTED`, `SMTP_CONNECT_FAILED`). `nodemailer` was tried first and could not open a connection from Workers, locally or on the edge, while raw `node:tls` to the same port works; the IMAP side had already proven that primitive, so the sender stays on it and off a 1 MB dependency. `verifySmtp()` (connect, EHLO, AUTH, QUIT) exists for probes.
- After send, `APPEND` raw message to Sent with `\Seen` (Yahoo does not auto-save SMTP sends).

---

## 7. Data

**KV `OAUTH_KV`** — managed entirely by `workers-oauth-provider` (clients, grants, tokens).

**D1 `yahoo_mcp`**
```sql
CREATE TABLE pending_sends (
  token       TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('send','reply','forward')),
  preview     TEXT NOT NULL,          -- JSON
  mime        BLOB NOT NULL,          -- rendered message
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  client_id   TEXT NOT NULL,
  client_name TEXT,
  tool        TEXT NOT NULL,
  args_digest TEXT NOT NULL,          -- sha256 of canonical args (no bodies)
  uids        TEXT,                   -- JSON array when applicable
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok','error','denied'))
);
```
Audit every tool call in `draft`, `organize`, `send`. Read calls are logged at `tool` level only (no args) to keep the table small. A cron trigger (`*/10 * * * *`) purges expired `pending_sends`.

---

## 8. Repo layout

```
yahoo-mcp/
├── wrangler.jsonc
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # OAuthProvider export, Hono routes
│   ├── auth/
│   │   ├── access.ts       # Cloudflare Access JWT verification
│   │   └── consent.tsx     # /authorize consent page
│   ├── mcp/
│   │   ├── server.ts       # McpServer setup, tool registration, SEND_ENABLED gate
│   │   └── tools/
│   │       ├── read.ts
│   │       ├── draft.ts
│   │       ├── organize.ts
│   │       └── send.ts
│   ├── lib/
│   │   ├── imap.ts
│   │   ├── smtp.ts
│   │   ├── mime.ts         # build/parse, sanitize HTML→text
│   │   ├── audit.ts
│   │   └── errors.ts
│   └── types.ts
├── migrations/
│   └── 0001_init.sql
├── test/
│   ├── read-tools.test.ts  # vitest (node env): tools driven through an in-memory MCP client, ImapFlow mocked
│   ├── mime.test.ts
│   ├── audit.test.ts
│   └── helpers/            # FakeImapFlow, fixtures, harness
├── scripts/
│   └── e2e-oauth.mjs       # full client path against a running server: OAuth + MCP + real IMAP
├── ARCHITECTURE.md         # this file
└── OVERVIEW.md
```

Tests run in plain vitest rather than `@cloudflare/vitest-pool-workers`: the tool logic has no Workers-specific surface once ImapFlow and D1 are mocked, and the real runtime path (workerd, OAuth, Yahoo) is exercised by `scripts/e2e-oauth.mjs` against `wrangler dev`.

`wrangler.jsonc` essentials:
```jsonc
{
  "name": "yahoo-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",      // ≥ 2026-08-04 → nodejs_compat default
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<id>" }],
  "d1_databases": [{ "binding": "DB", "database_name": "yahoo_mcp", "database_id": "<id>" }],
  "triggers": { "crons": ["*/10 * * * *"] },
  "observability": { "enabled": true }
}
```

---

## 9. Security

- Yahoo app password is the only long-lived secret; it never leaves Worker secrets. Rotate by `wrangler secret put`.
- Every MCP request is Bearer-authenticated by the OAuth layer; the tool handler never sees an unauthenticated call.
- Prompt injection is the primary threat model (email bodies are attacker-controlled input read by the model). Mitigations: send is two-phase with user-in-the-loop; no attachment content; no permanent delete; `SEND_ENABLED` kill switch; audit log ties every write to a `client_id`.
- No `Origin`-less POSTs accepted on `/mcp`.
- Consent page is behind Cloudflare Access; a stolen OAuth client cannot complete a grant without the operator's identity.
- Rate limit `/token` and `/register` (Workers Rate Limiting bindings, free): 30 and 5 requests per minute per connecting IP, HTTP 429 with `Retry-After` beyond that (`src/lib/ratelimit.ts`). Both are the only endpoints an anonymous caller can POST to.
- Operator console at `/authorize/connections` (covered by the same Access application as `/authorize`): lists grants with last audited activity and revokes one client's tokens. CSRF-guarded like the consent form.
- Operator pages send a Content-Security-Policy with no scripts and `frame-ancestors 'none'`; `form-action` and a cross-origin-opener policy are deliberately omitted because the consent POST redirects to the client's origin and claude.ai completes OAuth in a popup that needs its opener.

---

## 10. Open question → spike first

**Does `imapflow` run on workerd with `nodejs_compat`?** Documented support for client `node:net`/`node:tls` says yes in principle; no published confirmation exists.

Spike (`spike/` branch, ~30 lines):
```ts
import { ImapFlow } from "imapflow";
export default {
  async fetch(_req, env) {
    const c = new ImapFlow({ host: "imap.mail.yahoo.com", port: 993, secure: true,
      auth: { user: env.YAHOO_USER, pass: env.YAHOO_APP_PASSWORD }, logger: false });
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    try { const m = await c.fetchOne("*", { envelope: true }); return Response.json(m?.envelope ?? null); }
    finally { lock.release(); await c.logout(); }
  }
};
```
Run `wrangler dev` (local workerd) **and** `wrangler dev --remote` — behavior can differ.

Outcomes:
- **Works** → proceed single-Worker (§3 primary).
- **Fails on streams/Buffer edge cases** → try `cf-imap` (Workers-native, pre-release, smaller API; would need a thin adapter to match `lib/imap.ts` interface).
- **Both fail** → §3 fallback (Vercel Node function for IMAP/SMTP).

**Outcome (2026-09-08): works.** imapflow 2.0.0 (released 2026-09-07) documents Workers support with implicit TLS. Verified on local workerd and on the real edge (`wrangler dev --remote`) with real credentials: TLS to `imap.mail.yahoo.com:993`, AUTHENTICATE, SELECT INBOX, FETCH envelope, LOGOUT. Edge timings: ~1.7 s connect+auth, ~0.9 s SELECT on a 10k-message INBOX, ~0.4 s FETCH, ~0.3 s LOGOUT. Proceeding with §3 primary. Spike kept in `spike/`.

Notes from the spike:
1. A freshly registered workers.dev subdomain returned an opaque `internal error` for every path for ~2 minutes. Wait; don't debug code.
2. Local workerd logs `Uncaught TypeError ... reading 'emit'` from `process.emitWarning` after a MaxListeners warning. It does not occur on the edge. Cosmetic.
3. Yahoo reported INBOX `EXISTS` as exactly 10000 across runs while new mail arrived. Verify whether Yahoo caps exposed messages before relying on `total` in `search_messages`.
4. pnpm ≥ 10 must allowlist the `workerd` and `esbuild` build scripts (`pnpm.onlyBuiltDependencies`) or wrangler has no runtime binary.

---

## 11. Milestones

1. Spike (§10). Decide deployable shape.
2. Scaffold: wrangler, Hono, `workers-oauth-provider`, KV, D1, Access on `/authorize`. Serve `tools/list` with one `list_folders` tool. Connect from Claude Code first (best error output), then claude.ai web, then phone.
3. Read tools + tests.
4. Organize + draft tools + audit log.
5. Send tools (two-phase) + cron purge + `SEND_ENABLED` gate.
6. Connect ChatGPT (web → verify on phone) and Codex CLI. Add tool annotations (§5.6). Optional `search`/`fetch` aliases. Then Antigravity CLI as Tier-2. Document per-client setup in OVERVIEW.md.
7. Hardening pass: rate limits, Origin check, error codes, README. Done 2026-10-07: per-IP limits on `/token` and `/register`, operator revocation console, security headers, error-code appendix, README rewrite.

---

## 12. Error codes

Every tool error is returned as `CODE: message` in a single text content item with `isError: true`, so a model can branch on the code and read the message. OAuth endpoints use standard OAuth error responses; throttling is HTTP 429 `slow_down`.

| Code | Meaning | Typical cause |
|---|---|---|
| `INVALID_ARGUMENT` | an argument failed validation beyond the JSON schema | bad date, bad email address, malformed id |
| `NOT_FOUND` | no message with that uid in that folder | stale uid after a move, wrong folder |
| `FOLDER_NOT_FOUND` | Yahoo reported no folder with the needed special-use flag | unusual account layout |
| `NO_RECIPIENT` | a reply has nobody to go to | original has no usable address |
| `IMAP_AUTH_FAILED` | Yahoo rejected the app password | revoked or mistyped app password |
| `IMAP_RATE_LIMITED` | Yahoo is throttling logins for the account | too many tool calls in a short time |
| `IMAP_CONNECT_FAILED` | could not reach or lost the IMAP server | network, timeout, server closed |
| `IMAP_SEARCH_FAILED`, `IMAP_MOVE_FAILED`, `IMAP_STORE_FAILED`, `IMAP_APPEND_FAILED`, `IMAP_DELETE_FAILED` | Yahoo refused that command | server-side policy or state |
| `IMAP_<RESPONSE-CODE>` | Yahoo returned a standard response code, surfaced verbatim | `IMAP_NONEXISTENT`, `IMAP_TRYCREATE` |
| `IMAP_FETCH_INCOMPLETE` | a body window came back short of the size Yahoo declared, twice in a row | server hiccup; retry the call |
| `SMTP_AUTH_FAILED` | Yahoo SMTP rejected the app password | as above |
| `SMTP_RECIPIENT_REJECTED` | every recipient was refused | bad address, relaying denied |
| `SMTP_MESSAGE_REJECTED` | Yahoo refused the sender or the message data | policy, size |
| `SMTP_CONNECT_FAILED` | could not reach SMTP, or it closed or timed out | network |
| `SMTP_FAILED` | any other SMTP reply | unexpected server behaviour |
| `CONFIRM_TOKEN_INVALID` | unknown, used, cancelled, or another client's token | model retried a confirm |
| `CONFIRM_TOKEN_EXPIRED` | the five-minute window passed | slow confirmation |
| `INTERNAL` | anything not mapped above | bug; check the Worker log |

## 13. References

- claude.ai custom connectors: https://claude.com/docs/connectors/building
- ChatGPT developer mode / MCP apps: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- Gemini CLI → Antigravity CLI transition: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Antigravity CLI install: `curl -fsSL https://antigravity.google/cli/install.sh | bash` (provides `agy`)
- Cloudflare `workers-oauth-provider`: https://github.com/cloudflare/workers-oauth-provider
- Workers `node:net` / `node:tls`: https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/ , https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/
- imapflow: https://imapflow.com
- cf-imap (fallback): https://github.com/Exerra/cf-imap
- Prior art (design reference only, not dependencies): cldt-fr/imap-mcp (remote OAuth + imapflow, Next.js), nikolausm/imap-mcp-server (local, mature tool surface), jwlutz/gmail_connector (`GMAIL_MCP_MODE` read-only gate pattern)
