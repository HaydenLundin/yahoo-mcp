# yahoo-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server that lets AI assistants read, organize, draft, and (with your approval) send email from a Yahoo Mail account. One HTTPS URL works for claude.ai on web and phone, Claude Desktop, Claude Code, ChatGPT, Codex CLI, and any other client that speaks Streamable HTTP with OAuth 2.1.

Yahoo has no first-party connector in any of these tools. This fills the gap with the same permission model as Anthropic's Gmail connector: search and read, drafts, folders and flags, attachment metadata only, and send gated behind an explicit confirmation. No permanent delete. No attachment downloads.

- **What it does and how to connect each client:** [OVERVIEW.md](OVERVIEW.md)
- **Design spec (auth, tool manifest, data, security):** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Plain-language tour of the code and the lessons learned:** [FORHAYDEN.md](FORHAYDEN.md)

## Status

Milestone 2 of 7: a single Cloudflare Worker serving OAuth 2.1 (dynamic client registration, PKCE, refresh rotation), a Cloudflare Access guarded consent page, and a stateless MCP endpoint with one tool, `list_folders`. Read, organize, draft, and two-phase send tools follow in milestones 3 to 5.

## Run it

Prerequisites: Node 22, pnpm, a Cloudflare account, a Yahoo app password (Account Security, requires two-step verification).

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in YAHOO_USER and YAHOO_APP_PASSWORD
pnpm db:migrate:local
pnpm dev                          # http://localhost:8787
pnpm e2e                          # exercises the full OAuth + MCP path
```

Deploying: `pnpm deploy`, then set the secrets listed in `.dev.vars.example` with `wrangler secret put`, apply `pnpm db:migrate:remote`, and put a Cloudflare Access application on `<your-host>/authorize` allowing only your email. Details in [OVERVIEW.md](OVERVIEW.md#operating-it).

## Stack

Cloudflare Workers (`nodejs_compat`), Hono, `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk` via `@hono/mcp`, `imapflow` for IMAP, Cloudflare KV (OAuth state) and D1 (pending sends, audit log). Runs on the free tier.
