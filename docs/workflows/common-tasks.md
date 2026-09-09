# Common tasks

Step-by-step checklists for recurring work.

## Local development loop

1. `pnpm typecheck`
2. `pnpm db:migrate:local` (only after adding a migration)
3. `pnpm dev` (or the `dev` entry in `.claude/launch.json`)
4. `pnpm e2e` in another terminal; it must print `E2E PASS`
5. Commit.

## Deploy to production

1. `pnpm typecheck && pnpm e2e` against a local server.
2. `pnpm deploy`. First deploy prints the workers.dev URL.
3. If migrations changed: `pnpm db:migrate:remote`.
4. If secrets changed: the operator runs `wrangler secret put <NAME>` for each one (`YAHOO_USER`, `YAHOO_APP_PASSWORD`, `SEND_ENABLED`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`). Never paste secret values into chat or files.
5. Smoke test: `curl -i https://<host>/mcp` returns 401 with `WWW-Authenticate`; `https://<host>/authorize` redirects to the Cloudflare Access login.

## Set up Cloudflare Access on /authorize (once)

1. Cloudflare dashboard, Zero Trust, choose a team name (free plan, up to 50 users).
2. Access, Applications, Add an application, Self-hosted.
3. Application domain: `yahoo-mcp.clthrl.workers.dev`, path `authorize`. Session duration: 24 h is fine.
4. Policy: Allow, include Emails, your address only.
5. Copy the Application Audience (AUD) tag from the application overview.
6. `wrangler secret put ACCESS_TEAM_DOMAIN` (value `<team>.cloudflareaccess.com`) and `wrangler secret put ACCESS_AUD`.

## Connect a client

See `OVERVIEW.md`, section "Connecting a client". Claude Code first, because it prints the clearest OAuth errors:

```
claude mcp add --transport http yahoo https://yahoo-mcp.clthrl.workers.dev/mcp
```

## Rotate the Yahoo app password

1. Yahoo Account Security, delete the old app password, create a new one.
2. `wrangler secret put YAHOO_APP_PASSWORD`. Takes effect on the next request.
3. Update `.dev.vars` locally.

## Switch to read-only mode

`wrangler secret put SEND_ENABLED` with value `false`. The send tools disappear from `tools/list` on the next request for every client. Set `true` to re-enable.

## Read the audit log

`pnpm audit:tail` prints the last 50 rows from production. For a specific client, filter by `client_name`.

## Revoke one client

Until the admin endpoint exists: list grants in the Cloudflare dashboard under the `OAUTH_KV` namespace (keys prefixed `grant:`), delete the grant and its tokens. Rotating the Yahoo app password revokes everyone at once.

## Add a tool

1. Add the row to the manifest in `ARCHITECTURE.md` section 5 (params, behaviour, annotations).
2. Implement in the matching `src/mcp/tools/*.ts` inside `runTool`.
3. Extend `scripts/e2e-oauth.mjs` or the vitest suite so the tool is exercised.
4. Run the local loop, then update `OVERVIEW.md` if the user-facing capability changed.
