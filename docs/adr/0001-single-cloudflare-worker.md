# ADR 0001: Run IMAP, OAuth, and MCP in a single Cloudflare Worker

Date: 2026-09-08. Status: accepted.

## Context

The MCP server must be reachable from claude.ai on a phone, which rules out anything local or stdio. It must be cheap (target $0/month) and single-user. The one uncertainty was whether an IMAP client could run inside Cloudflare Workers at all: Workers only recently gained client-side `node:net` and `node:tls`, and no published confirmation for `imapflow` existed when the spec was written. The fallback was a second deployable (a Node function on Vercel) for IMAP and SMTP, called from the Worker with a shared secret.

## Decision

Everything runs in one Worker: `@cloudflare/workers-oauth-provider` for OAuth, `@hono/mcp` for the MCP transport, and `imapflow` for IMAP, with KV and D1 for state.

## Evidence

A spike (`spike/index.ts`) connected to `imap.mail.yahoo.com:993`, authenticated, selected INBOX, fetched an envelope, and logged out, both on local workerd and on the real edge via `wrangler dev --remote` with real credentials. imapflow 2.0.0, released 2026-09-07, documents Workers support and requires implicit TLS, which Yahoo uses. Edge timings: about 1.7 s connect plus auth, 0.9 s SELECT on a 10k-message inbox, 0.4 s FETCH, 0.3 s LOGOUT.

## Consequences

- One deployable, one URL, one secret store. No shared-secret hop between services.
- Each tool call pays roughly 2 s of connection setup. Acceptable for an assistant; mitigations noted in `FORHAYDEN.md`.
- STARTTLS is impossible on Workers, so SMTP must use implicit TLS on port 465 (Yahoo supports it).
- If Cloudflare ever restricts raw sockets, the IMAP layer behind `withImap` is the only thing that would move; the fallback design in `ARCHITECTURE.md` section 3 remains valid.
