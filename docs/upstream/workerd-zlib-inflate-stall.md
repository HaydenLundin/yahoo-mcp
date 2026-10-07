# Retracted: workerd `node:zlib` inflate stall

Status: **do not file.** Kept as a record of a wrong diagnosis and of how it was caught.

Until 2026-10-07 this file held a paste-ready cloudflare/workerd issue claiming that a `zlib.createInflateRaw()` stream fed from a `node:tls` socket stops producing output once one input chunk inflates past `chunkSize`. The claim rested on two facts: disabling IMAP compression fixed a stall, and raw-socket probes had cleared the socket layer. The inflater itself was never tested on its own.

Before filing, two checks were run.

1. **Upstream search.** postalsys/imapflow#408 (opened and fixed 2026-09-27) describes the same symptom on Cloudflare Workers with a different cause: `ImapStream` cleared its `processingInput` guard in a `.finally()` a few microtasks after the loop found its queue empty. On workerd the next chunk arrives in that gap, is queued, and is never processed, so the socket is never read again and the command runs into `socketTimeout`. The installed imapflow 2.0.0 contains exactly that code. Fixed in imapflow 2.1.0, commit c73f3ea.
2. **Standalone experiment** under `spike/zlib-lab/`: the same inflate code runs in Node 22 and inside workerd 1.20260908.1 through `workerd test`, with no imapflow and no network. A highly compressible `* SEARCH ...` line is DEFLATE-raw compressed with `Z_SYNC_FLUSH` (no final block, like a live IMAP COMPRESS session), written to `createInflateRaw({ chunkSize: 16384 })` in one or several pieces, and the writable side is deliberately never ended. Output is counted after 1.5 s.

| mode | writes | chunkSize | expected bytes | Node 22 | workerd |
|---|---|---|---|---|---|
| sync | 1 | 16384 | 8,003 | complete | complete |
| sync | 1 | 16384 | 70,006 | complete, 5 chunks | complete, 5 chunks |
| sync | 8 | 16384 | 70,006 | complete, 12 chunks | complete, 12 chunks |
| final | 1 | 16384 | 70,006 | complete, `end` fired | complete, `end` fired |
| sync | 4 | 16384 | 300,004 | complete, 22 chunks | complete, 22 chunks |
| sync | 1 | 131072 | 70,006 | complete, 1 chunk | complete, 1 chunk |

Conclusion: workerd's inflater is fine. Compression caused the stall only indirectly. The inflater emits several 16 KiB chunks per socket read, which is exactly the back-to-back delivery that trips the imapflow race, whereas plain TLS delivers one chunk per read and mostly does not. That also explains why it looked like a 16 KB threshold and why less compressible envelope fetches got through.

What follows from this:

- Nothing to file with cloudflare/workerd for zlib.
- Optionally, a confirmation comment on postalsys/imapflow#408 (`imapflow-workers-note.md`).
- Project fix, done 2026-10-07: upgraded imapflow to 2.2.8 and removed `disableCompression`. The spike's large-response probe and the full e2e pass with compression on.
