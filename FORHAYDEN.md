# FORHAYDEN.md

A plain-language tour of yahoo-mcp: what it is, how it is built, why it is built that way, and what we learned along the way. Written for future-you who has forgotten everything.

## What we are building, in one picture

Think of a hotel concierge desk. Guests (AI assistants like Claude, ChatGPT, Codex) walk up and ask for things: "any mail from the property manager this week?", "draft a reply", "archive the newsletters". The concierge (our Worker) knows how to get into your mailbox (Yahoo IMAP and SMTP) but never hands guests the key. Each guest gets a wristband (an OAuth token) that proves they were let in by you, and every action they take is written in the concierge's ledger (the audit log). Some requests, like sending a letter on your behalf, the concierge will only carry out after showing you the envelope and hearing you say yes.

Yahoo has no official connector in any of these assistants. We are building the missing one, with the same permission model Anthropic chose for Gmail so nothing feels surprising.

## Architecture: one Worker, three jobs

Everything runs in a single Cloudflare Worker. That was not obvious at the start; see the spike story below. The Worker does three things:

1. **OAuth 2.1 authorization server.** When a client like claude.ai wants in, it registers itself, gets sent to our consent page, and after you click Allow it receives its own access token. The library `@cloudflare/workers-oauth-provider` does the heavy lifting and keeps its state in Cloudflare KV. We only write the consent page.
2. **MCP endpoint at `/mcp`.** This is the protocol the assistants speak. The OAuth layer checks the token first, then hands the request to our Hono app, which spins up an MCP server, registers the tools, answers, and throws it all away. Stateless by design.
3. **The mailbox client.** `imapflow` opens a TLS connection to Yahoo for each tool call, does the work, and logs out. SMTP (for sending) arrives in milestone 5.

Two layers of authentication, and it matters to keep them apart in your head:

- **Layer A, the bouncer at the door.** Cloudflare Access sits in front of `/authorize` only. It shows a sign-in page and lets only your email through. Our code then verifies the signed token Access attaches. Nobody else can ever reach the consent page, so a stolen or malicious client cannot approve itself.
- **Layer B, the wristbands.** Each AI client gets its own OAuth grant and tokens. Revoke one, the others keep working. The grant carries the client's name so the audit log can say who did what.

Data lives in two free Cloudflare stores: KV for OAuth state (managed by the library) and D1, a small SQLite database, for pending sends and the audit log.

## Codebase map

```
src/
  index.ts          wires the OAuth provider around the two Hono apps; scheduled purge
  types.ts          Env bindings, GrantProps (what a token carries), the four scopes
  auth/
    access.ts       verifies the Cloudflare Access JWT (Layer A); dev bypass for localhost
    consent.ts      landing page, /healthz, and the /authorize consent page (Layer B)
  mcp/
    handler.ts      the protected /mcp route: origin check, fresh server per request
    server.ts       builds the McpServer and registers tool groups
    tool.ts         runTool(): the wrapper that turns errors into codes and writes audit rows
    tools/read.ts   list_folders today; search, get_message, get_thread next
  lib/
    imap.ts         withImap / withMailbox: one connection per call
    audit.ts        writeAudit + digestArgs (bodies never logged)
    errors.ts       ToolError and the imapflow error mapping
migrations/         D1 schema
scripts/e2e-oauth.mjs   drives the whole OAuth + MCP flow like a real client would
spike/              the 100-line experiment that decided the architecture
```

The most important file to understand is `src/mcp/tool.ts`. Every tool, now and later, runs inside `runTool()`. That is where the two promises the spec makes are kept: errors always come back as a stable code the model can act on, and every write is audited with which client did it. If you ever find yourself writing a try/catch or a D1 insert inside a tool, stop; it belongs in the wrapper.

## Technologies and why

| Choice | Why |
|---|---|
| Cloudflare Workers | Free tier, always on, one URL for every client. Raw TCP sockets are supported now, which is the only reason IMAP works here. |
| `imapflow` 2.0 | The mature IMAP client for Node. Version 2.0 shipped the day before we started and added Workers support. Lucky timing. |
| `@cloudflare/workers-oauth-provider` | Implements OAuth 2.1, dynamic registration, PKCE, refresh rotation, and the MCP discovery documents. Writing that ourselves would be weeks and mistakes. |
| `@modelcontextprotocol/sdk` + `@hono/mcp` | The official MCP SDK; the Hono adapter gives it a fetch-style transport that fits Workers. |
| Hono | Tiny router that runs everywhere, with an `html` helper that escapes by default. |
| `jose` | Verifies the Cloudflare Access JWT against the team's public keys. Standard, audited, Workers-compatible. |
| Cloudflare Access | A login page we do not have to write, with a one-line policy: allow this email. |
| KV + D1 | Free, single vendor, tiny state. Postgres would be a second bill for nothing. |

## Decisions and the reasoning

**Stateless MCP instead of McpAgent.** Cloudflare's agents SDK offers `McpAgent`, which keeps sessions in Durable Objects. We do not need sessions: every tool call already opens and closes its own IMAP connection, so there is nothing worth persisting. A fresh server per request is simpler, has no extra binding, and is easy to test. Bonus: the `SEND_ENABLED` kill switch takes effect on the next request because the tool list is rebuilt every time.

**workers.dev hostname, no custom domain.** The plan scopes Cloudflare Access to `/authorize` only, and I initially believed that required a domain you own. Cloudflare's docs say otherwise: a hostname-based Access application can target a workers.dev hostname plus a path. Zero dollars, same security.

**One IMAP connection per tool call.** Simplest thing that works. The spike measured about 1.7 seconds of that per call as TLS plus login. Acceptable for an assistant, and there are cheap wins later: skip selecting a folder when the tool does not need one, let LOGOUT finish after the response is sent (already done via `waitUntil`), reuse a connection across the steps inside one tool.

**Dynamic client registration stays on, and Client ID Metadata Documents are on too.** The MCP spec from July 2026 prefers the newer CIMD method, but clients in the wild still register dynamically. Supporting both costs one config line each.

**Two-phase send.** Email bodies are attacker-controlled text that a model will read. A hostile message could tell the assistant to forward your inbox somewhere. So send tools only prepare a preview and a five-minute token; nothing leaves until you confirm. Permanent delete and attachment download simply do not exist as tools. The safest capability is the one you never built.

## Lessons learned

**Spike first, and let the spike be small.** The single open question was whether `imapflow` runs on Workers. A hundred lines answered it in an afternoon and settled the whole deployment shape. Had we scaffolded first, a "no" would have meant rewriting the IMAP layer for a second host.

**A red herring that looked exactly like a bug.** The first remote run of the spike returned an opaque `internal error` for every path, including the favicon. We had just registered the workers.dev subdomain one second earlier. Two minutes later the identical code worked. Lesson: when something fails immediately after provisioning, wait before debugging. Record the gotcha so the next person does not lose an hour.

**pnpm 10 silently blocks install scripts.** `wrangler dev` had no runtime binary because pnpm refused to run workerd's postinstall. The fix is an allowlist in `package.json`. The symptom looks nothing like the cause.

**Yahoo's login password does not work for IMAP.** You need an app password, generated under Account Security after enabling two-step verification. It is a separate 16-character code that can be revoked without touching your real password. That is the only long-lived secret in the whole system, and it never appears in the repo or in the assistant's conversation; the operator sets it with `wrangler secret put`.

**Local emulator and real edge differ in small ways.** The local workerd printed an uncaught error after every request, triggered by an event-listener warning inside a Node compatibility shim. On the real edge the warning appears once and nothing crashes. Test both before you chase a ghost.

**Yahoo names its folders unexpectedly.** `Draft`, not `Drafts`. `Bulk`, not `Junk` or `Spam`. The IMAP special-use flags are right even when the names are odd, so the code resolves folders by flag, never by name.

**Health probes are not free when every request logs into a mailbox.** The browser pane used to verify the spike polled the server with HEAD requests, and each one performed a full Yahoo login. Stop test servers when you are done with them, and keep expensive work behind tool calls rather than on every route.

**Shell heredocs failed on a large batch of files with no clear cause.** Small tests with the suspicious characters all passed. Rather than spend time on the shell, the files were written with a dedicated file tool. Knowing when to route around a tool is a skill.

**Yahoo reports INBOX as exactly 10,000 messages.** Three runs, same number, while new mail kept arriving. Probably a cap on what the server exposes. Flagged for milestone 3 so search totals are not trusted blindly.

## How good engineers work, as seen in this project

- Decide the one thing that could invalidate the design, and test that first.
- Verify every step before the next one: type-check, migrate, run, end-to-end test, then commit.
- Make dangerous things impossible rather than discouraged. No delete tool beats a warning about the delete tool.
- Keep secrets out of the assistant, the repo, and the logs, and make the safe path the easy path (`.dev.vars` is gitignored, digests exclude bodies).
- Write down gotchas the moment they happen. Memory fades; the next session reads the file.
- Prefer boring, well-maintained libraries for security-critical pieces.
