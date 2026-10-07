# Draft issue for cloudflare/workerd

Status: not filed. Paste into https://github.com/cloudflare/workerd/issues/new when ready. Replace the two placeholders in the repro with any TLS server that speaks a compressed protocol, or point the maintainers at the IMAP example below.

---

**Title:** `node:zlib` streaming inflate stops producing output once a single input chunk inflates past `chunkSize`

**Summary**

With `nodejs_compat`, a `zlib.createInflateRaw()` stream fed from a `node:tls` socket stops emitting data as soon as one written chunk decompresses to more than the stream's `chunkSize` (default 16 KiB). No error is raised; the stream simply never produces the rest, and the consumer waits forever. The same code works in Node 22.

Observed on `compatibility_date = 2026-09-01` with `nodejs_compat`, both in `wrangler dev` (workerd 1.20260908.1) and on the production edge.

**How it surfaced**

The IMAP client `imapflow` negotiates `COMPRESS=DEFLATE` with Yahoo Mail and pipes the TLS socket through `zlib.createInflateRaw({ chunkSize: 16 * 1024 })`. Highly compressible responses (a `* SEARCH` line with 10,000 uids, about 70 KB uncompressed; quoted-printable text bodies) never completed, while less compressible ones (envelope fetches, roughly 2:1) did. Disabling compression (`disableCompression: true`) makes every response arrive, including the 70 KB line in under a second, so the TLS socket itself is fine.

Raw-socket probes confirmed `node:tls` delivers a 70 KB line correctly in flowing mode, through `pipe()` into a Transform with real backpressure (pause/resume), with `setTimeout` and `setKeepAlive` set.

**Minimal repro (sketch)**

```js
import { connect } from "node:tls";
import { createInflateRaw } from "node:zlib";

export default {
  async fetch() {
    // A TLS endpoint that, after a handshake, sends >16 KiB of DEFLATE-raw compressible data.
    // An IMAP server with COMPRESS=DEFLATE works: send "A1 LOGIN ...", "A2 COMPRESS DEFLATE",
    // then "A3 UID SEARCH ALL" on a large mailbox and pipe the socket through inflate.
    const sock = connect({ host: "<host>", port: 993, servername: "<host>" });
    const inflate = createInflateRaw({ chunkSize: 16 * 1024 });
    let bytes = 0;
    inflate.on("data", (c) => (bytes += c.length));
    sock.pipe(inflate);
    // ... negotiate compression, issue a command whose response is >16 KiB when inflated ...
    await new Promise((r) => setTimeout(r, 15000));
    return new Response(`inflated bytes: ${bytes}`); // stops at or below one chunkSize on workerd
  },
};
```

Expected: `bytes` grows to the full inflated size (Node 22 does this).
Actual: output stops after the first ~16 KiB of inflated data; no `error` event.

**Environment**

- wrangler 4.130.0, workerd 1.20260908.1 (local), production edge 2026-10-07
- `compatibility_flags: ["nodejs_compat"]`, `compatibility_date: "2026-09-01"`
- imapflow 2.0.0 (for the real-world path)
