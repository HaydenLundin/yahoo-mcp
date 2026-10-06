# Debugging rules

Known behaviours that look like bugs but are not, and where to look first.

## Cloudflare

- A freshly registered workers.dev subdomain returns an opaque `internal error; reference=...` for every path for a minute or two. Wait, then retry, before touching code.
- Local workerd (`wrangler dev`) logs `Uncaught TypeError: Cannot read properties of undefined (reading 'emit')` from `node-internal:internal_process` after IMAP sessions, triggered by a MaxListeners warning in the socket shim. Responses are unaffected and it does not happen on the edge. Ignore it locally.
- `wrangler dev --remote` uploads `.dev.vars` as preview secrets. `wrangler deploy` does not; production secrets come only from `wrangler secret put`.
- pnpm 10 skips postinstall scripts. If `wrangler dev` cannot find workerd, check `pnpm.onlyBuiltDependencies` in `package.json` and run `pnpm install` again.
- Wrangler's OAuth token expires hourly and refreshes on the next command. A one-off `Authentication error [code: 10000]` on the first API call after a pause is that refresh racing; rerun the command.
- `wrangler d1 migrations apply` and `wrangler kv namespace create` prompt interactively; in scripts they fall back to safe defaults and print `Using fallback value in non-interactive context`.

## Yahoo IMAP

- Failed logins are slow (about 5 s). Successful connect plus login is about 1.7 s on the edge. If every call is slow, check credentials first.
- Folder names: `Sent`, `Draft` (singular), `Trash`, `Archive`, `Bulk` (junk). Special-use flags are correct; names are not to be trusted.
- `INBOX` reports `EXISTS` as exactly 10000 on a mailbox with more mail. Treat totals as "at least" until verified with STATUS.
- Capability `MESSAGELIMIT=1000`: fetch and search ranges are capped at 1000 messages per command. Paginate.
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
