# yahoo-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server that lets AI assistants read, organize, draft, and (with your approval) send email from a Yahoo Mail account. One HTTPS URL works for claude.ai on web and phone, Claude Desktop, Claude Code, ChatGPT, Codex CLI, and any other client that speaks Streamable HTTP with OAuth 2.1.

Yahoo has no first-party connector in any of these tools. This fills the gap with the same permission model as Anthropic's Gmail connector: search and read, drafts, folders and flags, attachment metadata only, and send gated behind an explicit confirmation. No permanent delete. No attachment downloads.

- **What it does and how to connect each client:** [OVERVIEW.md](OVERVIEW.md)
- **Design spec (auth, tool manifest, data, security):** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Plain-language tour of the code and the lessons learned:** [FORHAYDEN.md](FORHAYDEN.md)

## Status

Milestone 5 of 7: a single Cloudflare Worker serving OAuth 2.1 (dynamic client registration, PKCE, refresh rotation), a Cloudflare Access guarded consent page, and a stateless MCP endpoint with read tools (`list_folders`, `search_messages`, `get_message`, `get_thread`, `list_drafts`), organize tools (`move_messages`, `archive_messages`, `trash_messages`, `mark_read`, `mark_unread`, `flag_messages`, `unflag_messages`), draft tools (`create_draft`, `update_draft`, `delete_draft`), and, when `SEND_ENABLED` is true, the two-phase send tools (`send_message`, `reply_message`, `forward_message` prepare a preview and a five-minute token; `confirm_send` delivers and files a copy in Sent; `cancel_send` discards). Connected and working from Claude Code against the live mailbox. Remaining: the client matrix (ChatGPT, Codex, Antigravity) and a hardening pass.

## Run it

Prerequisites: Node 22, pnpm, a Cloudflare account, a Yahoo app password (Account Security, requires two-step verification).

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in YAHOO_USER and YAHOO_APP_PASSWORD
pnpm db:migrate:local
pnpm dev                          # http://localhost:8787
pnpm e2e                          # exercises the full OAuth + MCP path against the live mailbox
pnpm test                         # unit tests with a mocked IMAP server
```

Deploying: `pnpm run deploy`, then set the secrets listed in `.dev.vars.example` with `wrangler secret put`, apply `pnpm db:migrate:remote`, and put a Cloudflare Access application on `<your-host>/authorize` allowing only your email. Details in [OVERVIEW.md](OVERVIEW.md#operating-it).

## Stack

Cloudflare Workers (`nodejs_compat`), Hono, `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk` via `@hono/mcp`, `imapflow` for IMAP, Cloudflare KV (OAuth state) and D1 (pending sends, audit log). Runs on the free tier.
