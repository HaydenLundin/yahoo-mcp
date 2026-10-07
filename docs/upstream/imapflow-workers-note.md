# Optional comment for postalsys/imapflow#408

Status: not posted, optional. The issue is closed and fixed in 2.1.0, so this is only a data point for the next person who searches for the symptom. Paste at https://github.com/postalsys/imapflow/issues/408 if you want it on record. An earlier version of this file asked for a `disableCompression` recommendation in the README; that request was based on a wrong diagnosis (the inflater is fine) and is withdrawn.

---

One more way to hit this, for anyone searching: imapflow 2.0.0 against Yahoo Mail (which advertises `COMPRESS=DEFLATE`) from a Cloudflare Worker. Every highly compressible response over about 16 KB stalled to `socketTimeout`, such as a `* SEARCH` line with 10,000 uids or a quoted-printable text body, while envelope fetches of similar size went through.

Compression makes the race near-deterministic: `createInflateRaw({ chunkSize: 16 * 1024 })` hands `ImapStream` several 16 KiB chunks per socket read, so the second one lands in the gap between the loop finding its queue empty and the `.finally()` clearing `processingInput`. Plain TLS delivers one chunk per read and mostly does not trip it, which is why `disableCompression: true` looked like a fix. We first blamed workerd's `node:zlib`; a standalone inflate test inside `workerd test` with no imapflow showed the inflater delivers everything, so the README's statement that COMPRESS=DEFLATE works on Workers as on Node is accurate from 2.1.0 on. c73f3ea resolves it.
