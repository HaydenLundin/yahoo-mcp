# yahoo-mcp

Remote MCP server (one Cloudflare Worker) exposing a single Yahoo Mail account to AI clients with Gmail-connector-parity permissions. Spec lives in `ARCHITECTURE.md` (design) and `OVERVIEW.md` (operator-facing). Plain-language tour: `FORHAYDEN.md`.

## Context routing

- Changing auth (OAuth provider, Cloudflare Access, consent page) -> read `ARCHITECTURE.md` section 4, then `src/auth/*` and `src/index.ts`.
- Adding or changing a tool -> `ARCHITECTURE.md` section 5 (manifest + annotations), `src/mcp/tool.ts` (the `runTool` wrapper every tool uses), `docs/rules/coding-rules.md`.
- IMAP or SMTP behaviour -> `ARCHITECTURE.md` section 6, `src/lib/imap.ts`; Yahoo and Workers quirks in `docs/rules/debugging-rules.md`.
- Building outgoing mail -> `src/lib/compose.ts` (RFC 5322 + quoted-printable + RFC 2047); never hand-roll MIME elsewhere. Sending -> `src/lib/smtp.ts` (our own minimal SMTP client over node:tls; nodemailer does not connect from Workers) and `src/lib/pending.ts` (single-use confirm tokens in D1).
- Client compatibility (ChatGPT `search`/`fetch` shape, claude.ai discovery quirks) -> `ARCHITECTURE.md` section 2 and `src/mcp/tools/compat.ts`.
- Operator tasks (deploy, secrets, migrations, audit, rotating credentials) -> `docs/workflows/common-tasks.md`.
- Why the project is one Worker and not two -> `docs/adr/0001-single-cloudflare-worker.md`.

## Critical commands

```
pnpm typecheck            # tsc, no emit
pnpm test                 # vitest, ImapFlow mocked, tools driven through an in-memory MCP client
pnpm dev                  # wrangler dev on :8787 (reads .dev.vars)
pnpm e2e [base-url]       # full OAuth + MCP path against a running server (needs ACCESS_DEV_BYPASS)
pnpm db:migrate:local     # apply migrations/ to the local D1
pnpm db:migrate:remote    # same, production D1
pnpm run deploy               # wrangler deploy
pnpm audit:tail           # last 50 audit rows from production D1
```

## Project context

- `pnpm deploy` is pnpm's own built-in command and never runs our script. Always `pnpm run deploy`.
- pnpm 10 blocks postinstall scripts; `workerd` and `esbuild` are allowlisted in `package.json` (`pnpm.onlyBuiltDependencies`). Do not remove.
- Secrets never enter the repo or this assistant. The operator runs `wrangler secret put`. Local dev reads `.dev.vars` (gitignored); `.dev.vars.example` lists the keys.
- `ACCESS_DEV_BYPASS=true` skips Cloudflare Access only when the request host is localhost. Production needs `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
- MCP is stateless: a fresh `McpServer` per request, JSON responses, no session ids, no Durable Objects. That is what lets `SEND_ENABLED` take effect on the next request.
- Every tool body runs inside `runTool()`: errors become stable `CODE: message` tool errors and an audit row is written in the background. Never write to D1 or catch IMAP errors ad hoc inside a tool.
- Server-side MCP clients send no `Origin` header; the `/mcp` origin check only rejects a present, non-allowlisted origin.
- Production hostname: `https://yahoo-mcp.clthrl.workers.dev` (workers.dev subdomain `clthrl`). Cloudflare Access is scoped to `/authorize` and everything beneath it, which is why the operator console lives at `/authorize/connections`.
- `/token` and `/register` are rate limited per IP through Workers Rate Limiting bindings (`src/lib/ratelimit.ts`); the gate is a no-op when a binding is absent, so tests and stripped configs still run.
- Tests: `pnpm test` runs vitest in the node environment; `test/helpers/fake-imap.ts` stands in for ImapFlow via `vi.mock("imapflow")`, and `test/helpers/harness.ts` wires `buildServer()` to an in-memory MCP client so tools are exercised exactly as a client sees them. `scripts/e2e-oauth.mjs` covers the real runtime path against `wrangler dev`. Add a fixture and a test for every new tool.
- Audit writes are awaited inside `runTool()`, never deferred with `waitUntil`, so a row exists before the client sees the result.
- Send tools register only when `SEND_ENABLED === "true"`; locally that is `.dev.vars`, in production a secret. The e2e script never calls `confirm_send`; a real send needs the operator's explicit go-ahead.

## Sync rule

This file has a corresponding `AGENTS.md` at the repo root for Factory Droid. When updating this file, also update `AGENTS.md`.
