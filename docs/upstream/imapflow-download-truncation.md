# Draft issue for postalsys/imapflow

Status: not filed. Observation-grade: the data below is solid, but there is no standalone repro yet, so either file it as a report with the numbers or spend an hour on a Miniflare repro first. Paste into https://github.com/postalsys/imapflow/issues/new when ready. Filing is a public action in the operator's name.

---

**Title:** Cloudflare Workers: `download()` sometimes ends after its first chunk; ranged `fetchOne` windows for the same part are always complete

**Describe the bug**

On Cloudflare Workers (`nodejs_compat`), `client.download(uid, part, { uid: true })` of a 183,558-byte quoted-printable `text/html` part sometimes yields only the first chunk and then ends the stream cleanly, with no error. Which run comes up short varies:

| run | runtime | `chunkSize` | bytes received (decoded) |
|---|---|---|---|
| 1 | `wrangler dev` (workerd 1.20260908.1) | 65536 (default) | 64,156 of ~174,045 |
| 1 | same session | 12,000 | 174,045 (complete) |
| 2 | production edge via `wrangler dev --remote` | 65536 (default) | 174,045 (complete) |
| 2 | same session | 12,000 | 11,792 |

A plain loop of `fetchOne(uid, { uid: true, bodyParts: [{ key, start, maxLength }] })` windows over the same part, which is what we use in production, returned all 183,558 raw bytes in every run: four windows of 60,000 and three of 65,536, with `COMPRESS=DEFLATE` on and off, locally and on the edge. So the socket, the parser, and the server's partial fetches are fine; whatever stops early is inside `download()`.

**To reproduce**

1. Yahoo Mail IMAP (`imap.mail.yahoo.com:993`), a message with a large QP text part (ours: 199 KB message, part `2`).
2. In a Worker: `await client.download(String(uid), "2", { uid: true })`, read the stream to the end, count bytes.
3. Repeat a few times, also with `chunkSize: 12000`. Some runs stop after the first chunk.

Plain Node with the same code and mailbox has not shown this in our runs.

**Expected behavior**

The stream delivers the whole part, or errors.

**Environment**

- imapflow 2.2.8 (ESM build), wrangler 4.130.0, workerd 1.20260908.1 and the production edge, 2026-10-07
- `compatibility_date: "2026-09-01"`, `compatibility_flags: ["nodejs_compat"]`
- Server: Yahoo Mail IMAP, `COMPRESS=DEFLATE` advertised and in use (the ranged control was also run with `disableCompression: true`)

**Additional context**

Looking at `downloadMessage()` in 2.2.8, the loop ends when `chunk.length !== chunkSize`, and `getNextPart()` returns `{}` without error when `fetchExpected()` yields no response or no body part. Since the server's windows are full-length in the raw probes, the early end is most likely one of those `{}` returns, for example the response of a later window not being matched to the download. We did not dig further because our code does not use `download()`.
