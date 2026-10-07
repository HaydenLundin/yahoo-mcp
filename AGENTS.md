# yahoo-mcp

Remote MCP server (one Cloudflare Worker) exposing a single Yahoo Mail account to AI clients with Gmail-connector-parity permissions. Design spec: `ARCHITECTURE.md`. Operator guide: `OVERVIEW.md`. Plain-language tour: `FORHAYDEN.md`.

## Commands

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

## Conventions

- TypeScript strict, ES modules, Hono router, `@modelcontextprotocol/sdk` with zod v4 schemas.
- One tool per `server.registerTool(...)` call in `src/mcp/tools/*.ts`. Tool and parameter names are snake_case. Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) per `ARCHITECTURE.md` section 5.6.
- Every tool body runs inside `runTool()` from `src/mcp/tool.ts`. Do not catch IMAP errors or write audit rows inside tools; the wrapper does both.
- IMAP access goes through `withImap` / `withMailbox` in `src/lib/imap.ts`: one connection per tool call, always UID based, never sequence numbers.
- Resolve special folders (Sent, Drafts, Trash, Archive, Junk) by IMAP special-use flag, never by name. Yahoo names them `Sent`, `Draft`, `Trash`, `Archive`, `Bulk`.
- Message bodies never reach logs or the audit table. Audit digests exclude `body_text`, `body_html`, `note`.
- Secrets never enter the repo. Local dev reads `.dev.vars` (gitignored). Production uses `wrangler secret put`.
- `ACCESS_DEV_BYPASS=true` works only for localhost hosts. Production requires `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
- MCP is stateless: fresh `McpServer` per request, JSON responses, no Durable Objects. Send tools are registered only when `SEND_ENABLED === "true"`.
- `pnpm deploy` is pnpm's built-in command, not our script; use `pnpm run deploy`.
- Operator HTML lives under `/authorize/*` so one Cloudflare Access application covers it. Never add operator pages elsewhere without adding Access in front of them.
- pnpm 10: `workerd` and `esbuild` build scripts are allowlisted in `package.json`; keep them.
- Tests: every tool gets a fixture in `test/helpers/fixtures.ts` and a test in `test/*.test.ts` that calls it through the in-memory MCP client (`test/helpers/harness.ts`). `vi.mock("imapflow")` swaps in `FakeImapFlow`; extend the fake when a tool needs a new ImapFlow method.

## Sync rule

This file has a corresponding `CLAUDE.md` at the repo root for Claude Code. When updating this file, also update `CLAUDE.md`.
