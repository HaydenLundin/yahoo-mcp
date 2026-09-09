# yahoo-mcp — Overview

A self-hosted connector that lets AI assistants read, organize, draft, and (with your approval) send email from a Yahoo Mail account. One URL works for claude.ai and ChatGPT on your phone, Claude Desktop, Claude Code, OpenAI Codex CLI, and Google's Antigravity CLI — and any other client that speaks remote MCP with OAuth, because the server targets the strictest client and the rest are a subset.

Yahoo has no first-party connector in any of these tools. This fills that gap with the same permission model Anthropic's Gmail connector uses.

---

## What it does

Ask any connected assistant things like:

- "What came in from the property manager this week?"
- "Summarize the thread about the lease renewal."
- "Draft a reply saying I'm available Thursday."
- "Archive everything from newsletters older than 30 days."
- "Reply to Sam and cc Maris" → assistant shows you the exact message → you say yes → it sends.

The assistant never sees your Yahoo password. It gets a scoped OAuth token to *this* server; the server holds a Yahoo app password and talks IMAP/SMTP on your behalf.

---

## Permissions

Modeled on the Gmail connector in claude.ai (as of Aug 2026): search/read, drafts, labels/threads, attachment metadata only, and send/reply/forward gated behind approval.

| Capability | Allowed | How it's enforced |
|---|---|---|
| Search and read messages and threads | ✅ | read tools |
| See attachment names/sizes | ✅ | metadata only — attachment content is never downloaded |
| Create, edit, delete drafts | ✅ | drafts live in your Yahoo Drafts folder |
| Move, archive, trash, flag, mark read/unread | ✅ | trash = move to Trash folder; recoverable |
| Send, reply, forward | ⚠️ with approval | two-step: assistant shows a preview, sends only after you confirm; token expires in 5 min |
| Permanently delete mail | ❌ | no such tool exists |
| Download attachments | ❌ | no such tool exists |
| Create/delete folders | ❌ | not in v1 |
| Read-only mode | switch | set `SEND_ENABLED=false` and all send tools disappear from every client |

Every write action is logged with which AI client did it and when.

**Why the approval step matters.** Email bodies are untrusted input. A malicious message could try to instruct the assistant to forward your inbox somewhere. Requiring you to confirm every send — and never exposing permanent delete or attachment download — limits what a hijacked assistant can do.

---

## Architecture in one paragraph

A single Cloudflare Worker hosts three things: an OAuth 2.1 authorization server (so each AI client can sign in and get its own token), an MCP endpoint (the protocol all these assistants speak), and the IMAP/SMTP client that talks to Yahoo. Cloudflare Access guards the sign-in page so only your email can approve a new client. State lives in Cloudflare KV (OAuth) and D1 (pending sends, audit log). See `ARCHITECTURE.md` for the full spec.

---

## Cost

| Item | Plan | Monthly |
|---|---|---|
| Cloudflare Workers | Free (100k req/day) | $0 |
| Cloudflare KV, D1 | Free tier | $0 |
| Cloudflare Access | Zero Trust Free (≤50 users) | $0 |
| Domain (optional; `*.workers.dev` works) | — | $0–1 |
| Yahoo Mail | existing | $0 |
| AI clients | custom connectors need paid plans (claude.ai: Pro/Max/Team/Enterprise; ChatGPT: Developer mode, not on Free) | already paid |

**Expected: $0/month.** Ceiling if the IMAP spike forces a fallback host: ~$5/month for a small Node runtime.

Time cost: roughly a weekend for a working read/organize connector, another for send + hardening.

---

## Connecting a client

Replace `<host>` with your Worker URL (e.g. `yahoo-mcp.<you>.workers.dev`).

**claude.ai (web, iOS, Android) and Claude Desktop**
Settings → Connectors → Add custom connector → URL `https://<host>/mcp` → Connect. You'll be sent through Cloudflare Access (sign in with your email), then a consent page. Done — it syncs to the phone app automatically.

**Claude Code**
```powershell
claude mcp add --transport http yahoo https://<host>/mcp
```
Type `/mcp` in a session; the first call opens the browser for OAuth.

**ChatGPT (web, iOS, Android)**
Requires a paid plan. On the web: Settings → Apps & Connectors → Advanced → turn on **Developer mode** → Create → name `Yahoo`, URL `https://<host>/mcp`, authentication **OAuth** → complete sign-in. In each new chat, open the tools/connector picker and enable Yahoo. The connector is account-level, so it shows up in the mobile app too. Note: OpenAI reshuffled these menus several times in 2026; if the labels differ, look for the Developer mode toggle.

ChatGPT will ask before running any tool not marked read-only, so you'll get its native prompt at `confirm_send` on top of the preview step.

**Codex CLI**
```powershell
codex mcp add yahoo --url https://<host>/mcp
codex mcp login yahoo
```

**Antigravity CLI (`agy`)** — replaced Gemini CLI for free/Pro/Ultra users on June 18, 2026.
No `mcp add` command; edit `~/.gemini/config/mcp_config.json` (`$HOME\.gemini\config\mcp_config.json` on Windows):
```json
{ "mcpServers": { "yahoo": { "httpUrl": "https://<host>/mcp", "oauth": { "enabled": true } } } }
```
If OAuth doesn't trigger, use the `mcp-remote` wrapper instead:
```json
{ "mcpServers": { "yahoo": { "command": "npx", "args": ["-y", "mcp-remote", "https://<host>/mcp"] } } }
```

**Anything else** (Cursor, Windsurf, etc.): paste the URL if the client supports remote OAuth MCP natively; otherwise the `mcp-remote` snippet above works in any stdio-only client.

Each client gets its own token. Revoking one (from the Worker's KV, or by rotating the Yahoo app password) doesn't affect the others.

---

## Operating it

- **Rotate the Yahoo app password:** generate a new one at login.yahoo.com/account/security, then `wrangler secret put YAHOO_APP_PASSWORD`.
- **Read-only mode:** `wrangler secret put SEND_ENABLED` → `false`. Takes effect on next request.
- **Audit:** `wrangler d1 execute yahoo_mcp --command "SELECT ts, client_name, tool, uids, outcome FROM audit_log ORDER BY ts DESC LIMIT 50"`.
- **Kill a client:** delete its grant from `OAUTH_KV` (or use the admin endpoint once built).
- **Logs:** Workers observability is enabled; `wrangler tail` streams live.

---

## Status

Spike passed on 2026-09-08 on both local workerd and the real edge: `imapflow` runs on Cloudflare Workers, so this is a single deployable. Building milestone 2 (OAuth + MCP scaffold). Details in `ARCHITECTURE.md` §10.
