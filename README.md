# yahoo-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server that lets AI assistants read, organize, draft, and (with your approval) send email from a Yahoo Mail account. One HTTPS URL works for claude.ai on web and phone, Claude Desktop, Claude Code, ChatGPT, Codex CLI, and any other client that speaks Streamable HTTP with OAuth 2.1.

Yahoo has no first-party connector in any of these tools. This fills the gap with the same permission model as Anthropic's Gmail connector: search and read, drafts, folders and flags, attachment metadata only, and send gated behind an explicit confirmation. No permanent delete of mail. No attachment downloads.

Runs as a single Cloudflare Worker on the free tier. Verified end to end against a live Yahoo mailbox from Claude Code, claude.ai, ChatGPT, and Codex CLI.

- **What it does and how to connect each client:** [OVERVIEW.md](OVERVIEW.md)
- **Design spec (auth, tool manifest, data, security, error codes):** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Plain-language tour of the code and the lessons learned:** [FORHAYDEN.md](FORHAYDEN.md)

## What the assistant can do

| Area | Tools |
|---|---|
| Read | `list_folders`, `search_messages`, `get_message`, `get_thread`, `list_drafts`, plus `search` / `fetch` aliases for ChatGPT connectors |
| Organize | `move_messages`, `archive_messages`, `trash_messages`, `mark_read`, `mark_unread`, `flag_messages`, `unflag_messages` |
| Draft | `create_draft`, `update_draft`, `delete_draft` |
| Send, only when `SEND_ENABLED` is true | `send_message`, `reply_message`, `forward_message` prepare a preview and a five-minute token; `confirm_send` delivers and files a copy in Sent; `cancel_send` discards |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients that prompt before non-read-only tools do so at the right moments. Every write is audited in D1 with the client that made it.

## Security model in one paragraph

Two layers. Cloudflare Access guards the consent page so only the operator's identity can approve a new client; each client then gets its own OAuth 2.1 grant and tokens, revocable individually from an operator console. The Yahoo app password lives only in Worker secrets. Email bodies are treated as untrusted input: sending is two-phase with a human in the loop, there is no permanent delete and no attachment download, `SEND_ENABLED=false` removes the send tools from every client at once, and the two unauthenticated OAuth endpoints are rate limited per IP. Details in [ARCHITECTURE.md](ARCHITECTURE.md) sections 4, 5.4, and 9.

## Run it

Prerequisites: Node 22, pnpm, a Cloudflare account, a Yahoo app password (Account Security, requires two-step verification).

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in YAHOO_USER and YAHOO_APP_PASSWORD
pnpm db:migrate:local
pnpm dev                          # http://localhost:8787
pnpm e2e                          # exercises the full OAuth + MCP path against the live mailbox
pnpm test                         # unit tests with a mocked IMAP server and scripted SMTP
```

The default `pnpm e2e` never sends mail. `E2E_SEND_SELF=1 pnpm e2e` sends one message from the account to itself and checks it arrives and is filed in Sent.

## Deploy and operate

```bash
pnpm run deploy                   # "pnpm deploy" without "run" is pnpm's own command and does nothing useful here
pnpm db:migrate:remote
```

Then set the secrets listed in `.dev.vars.example` with `wrangler secret put`, create a Cloudflare Access application on `<your-host>/authorize` allowing only your email, and connect a client. Step-by-step instructions, including enabling send, rotating the app password, read-only mode, and revoking a client from the operator console, are in [OVERVIEW.md](OVERVIEW.md#operating-it) and [docs/workflows/common-tasks.md](docs/workflows/common-tasks.md).

## Stack, and the two things worth knowing about Workers

Cloudflare Workers (`nodejs_compat`), Hono, `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk` via `@hono/mcp`, `imapflow` for IMAP, a small SMTP client of our own over `node:tls`, Cloudflare KV for OAuth state, D1 for pending sends and the audit log, and Workers Rate Limiting for the public OAuth endpoints.

Two runtime facts cost real time and are documented so nobody pays twice. A stall on every large IMAP response turned out to be an imapflow 2.0.x input race that only Workers' task ordering exposes (fixed upstream in imapflow 2.1.0); compression is disabled as the workaround until the dependency is upgraded, and the full diagnosis, including a wrong first attribution to workerd's zlib, is in [FORHAYDEN.md](FORHAYDEN.md). And nodemailer cannot open an SMTP connection from Workers while raw TLS to the same port works, hence the home-grown client. Upstream notes and comment drafts live in [docs/upstream](docs/upstream).
