# Debugging rules

Known behaviours that look like bugs but are not, and where to look first.

## Cloudflare

- A freshly registered workers.dev subdomain returns an opaque `internal error; reference=...` for every path for a minute or two. Wait, then retry, before touching code.
- Local workerd (`wrangler dev`) logs `Uncaught TypeError: Cannot read properties of undefined (reading 'emit')` from `node-internal:internal_process` after IMAP sessions, triggered by a MaxListeners warning in the socket shim. Responses are unaffected and it does not happen on the edge. Ignore it locally.
- **Any single IMAP response line or literal over ~16 KB stalls under Workers**, locally and on the edge: the command never completes, `socketTimeout` fires, and the connection is dead. Symptoms: imapflow `search()` returns `false`, "Socket timeout" errors in the log about 20-30 s later, `IMAP_SEARCH_FAILED`. Multi-line responses (FETCH of hundreds of summaries) are fine. Keep searches inside `pagedSearch` and downloads inside `downloadText` (ranged `BODY.PEEK[part]<start.len>` fetches; imapflow's `download()` also pulls the full message header for single-part messages, and Yahoo's headers alone can exceed 16 KB); never call `client.search()` without a `seq` window unless the match set is known to be small (thread ids, header lookups).
- `wrangler dev --remote` uploads `.dev.vars` as preview secrets. `wrangler deploy` does not; production secrets come only from `wrangler secret put`.
- pnpm 10 skips postinstall scripts. If `wrangler dev` cannot find workerd, check `pnpm.onlyBuiltDependencies` in `package.json` and run `pnpm install` again.
- Wrangler's OAuth token expires hourly and refreshes on the next command. A one-off `Authentication error [code: 10000]` on the first API call after a pause is that refresh racing; rerun the command.
- `wrangler d1 migrations apply` and `wrangler kv namespace create` prompt interactively; in scripts they fall back to safe defaults and print `Using fallback value in non-interactive context`.

## Yahoo IMAP

- Yahoo rate-limits IMAP logins per account: `AUTHENTICATE Rate limit hit.` with response code `LIMIT`, surfaced as `IMAP_RATE_LIMITED`. Every tool call is one login, and so is every health probe against the spike Worker. Stop dev servers you are not reading, do not loop `pnpm e2e`, and wait several minutes after a `LIMIT`. The app password is not the problem.
- Failed logins are slow (about 5 s). Successful connect plus login is about 1.7 s on the edge. If every call is slow, check credentials first.
- Folder names: `Sent`, `Draft` (singular), `Trash`, `Archive`, `Bulk` (junk). Special-use flags are correct; names are not to be trusted.
- Yahoo exposes at most the newest 10,000 messages of a folder over IMAP. `EXISTS`, `STATUS MESSAGES`, and `UID SEARCH ALL` all report 10000 on a larger INBOX while `UIDNEXT` keeps growing. `search_messages.total` therefore means "matches among the newest 10,000".
- Yahoo has no ESEARCH, so `RETURN (PARTIAL ...)` is impossible; imapflow emulates COUNT/MIN/MAX client-side from the full uid list. Paging is done in the Worker: search returns all uids (about 70 KB for 10,000), then fetch only the page.
- Capability `MESSAGELIMIT=1000`: fetch ranges are capped at 1000 messages per command. Pages are at most 50, so this never triggers.
- imapflow `search()` returns `false` instead of throwing when the server rejects the command, and only its logger sees why. Set `IMAP_DEBUG=true` in `.dev.vars` to forward those entries, summarised, to the Worker log.
- Capability `UIDONLY` is advertised; the code is UID-based already, so nothing to do, but do not introduce sequence numbers.
- A `STARTTLS` upgrade cannot work on Workers (the runtime cannot upgrade an existing socket). Always implicit TLS on 993 and 465.

## Cloudflare Access on /authorize

- The 403 page on `/authorize` prints the rejection reason, the token's `iss`/`aud`, and what the server expects. Only Access-authenticated visitors see it. The **Token claims** line is the truth; the secrets must match it.
- `ACCESS_TEAM_DOMAIN` is the bare hostname from `iss` without `https://` (for example `hrl01.cloudflareaccess.com`). `ACCESS_AUD` is the `aud` value verbatim.
- "no applicable key found in the JSON Web Key Set" means the team-domain secret points at a different (but existing) Access domain. "Expected 200 OK from the JSON Web Key Set HTTP response" means it points at a domain that does not exist. `unexpected "aud" claim value` means `ACCESS_AUD` is wrong.
- The Access login page header shows the organization's display name (an auto-generated one like `throbbing-block-4f73`), which is not the team domain. The team domain is the host in the login URL and the only one serving `/cdn-cgi/access/certs`.
- Secrets take effect on the next request; no redeploy. The Access cookie from a failed attempt stays valid, so just retry `/mcp` Authenticate.

## OAuth and MCP

- `401` from `/mcp` with a `WWW-Authenticate` header is correct for unauthenticated calls; that is how clients discover the authorization server.
- Server-side clients send no `Origin`. If a client gets `403 Origin not allowed`, it is browser-based; add its origin to `ALLOWED_ORIGINS`.
- The consent POST is rejected with 403 when `Sec-Fetch-Site` is not same-origin. Tools that replay the form must send `Origin` or `Sec-Fetch-Site` like a browser would; see `scripts/e2e-oauth.mjs`.
- `pnpm e2e` is the fastest way to localise a problem: it prints which of the nine steps failed and the server's response body.
