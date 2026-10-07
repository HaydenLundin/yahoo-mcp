# Draft note for postalsys/imapflow

Status: not filed. Paste into https://github.com/postalsys/imapflow/issues/new when ready. This is a heads-up, not a bug in imapflow.

---

**Title:** Cloudflare Workers: COMPRESS=DEFLATE stalls on large responses; suggest documenting `disableCompression`

**Summary**

imapflow 2.0.0 works on Cloudflare Workers (`nodejs_compat`) as the README says, with one catch. When the server advertises `COMPRESS=DEFLATE` (Yahoo Mail does), imapflow negotiates it and pipes the socket through `zlib.createInflateRaw({ chunkSize: 16 * 1024 })`. workerd's streaming inflater stops producing output once a single input chunk inflates past `chunkSize` (reported separately to cloudflare/workerd), so any highly compressible response over about 16 KB never completes: `search()` returns `false` after `socketTimeout`, a body `download()` hangs, and the connection is dead afterwards.

Setting `disableCompression: true` avoids it entirely; a 70 KB `* SEARCH` line then arrives in under a second on the edge.

**Suggestion**

Add a line to the Workers paragraph of the README recommending `disableCompression: true` on Cloudflare Workers until workerd fixes the inflater, or skip the COMPRESS negotiation automatically when `navigator.userAgent === "Cloudflare-Workers"`.

**Details**

- imapflow 2.0.0, wrangler 4.130.0, workerd 1.20260908.1 and production edge, 2026-10-07
- Server: Yahoo Mail IMAP (`imap.mail.yahoo.com:993`), capability `COMPRESS=DEFLATE`
- Raw `node:tls` sockets on Workers deliver the same 70 KB line fine, including piped into a Transform with backpressure, so the socket layer is not involved.
