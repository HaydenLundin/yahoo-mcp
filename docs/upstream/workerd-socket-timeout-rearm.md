# Draft comment for cloudflare/workerd#7310

Status: not posted. **This bug is already filed:** https://github.com/cloudflare/workerd/issues/7310, open since 2026-09-10, root cause identified by the reporter, no comments yet. Do not open a new issue; add the text below as a comment on that one. Posting is a public action in the operator's name.

---

Independent confirmation from a different setup: imapflow 2.0.0 talking to Yahoo Mail IMAP over `node:tls` from a Worker on `compatibility_date` 2026-09-01 with `nodejs_compat`, wrangler 4.130.0 / workerd 1.20260908.1 locally and the production edge, 2026-10-07.

- `socket.listenerCount('timeout')` grows by one per data chunk after a single `setTimeout(ms)`: 44 listeners after a 70 KB response that arrived in 34 chunks. `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 timeout listeners added` appears after about ten chunks.
- When the socket then goes idle, every accumulated timer fires within the same millisecond, so the library's `'timeout'` handler runs 20+ times for one idle period.
- In `wrangler dev` only, the warning path itself throws `Uncaught TypeError: Cannot read properties of undefined (reading 'emit') at node-internal:internal_process`; the edge logs the warning normally. That looks like `process.emitWarning` reaching for a `process` object that does not exist in that context and may deserve its own issue.

Minimal repro with no library involved:

```js
import { connect } from "node:tls";

export default {
  async fetch() {
    const sock = connect({ host: "imap.mail.yahoo.com", port: 993, servername: "imap.mail.yahoo.com" });
    sock.setTimeout(20_000);
    let chunks = 0;
    const counts = [];
    sock.on("data", () => {
      chunks++;
      counts.push(sock.listenerCount("timeout"));
    });
    await new Promise((r) => sock.once("secureConnect", r));
    sock.write("A1 CAPABILITY\r\n"); // any server that answers in a few chunks
    await new Promise((r) => setTimeout(r, 2000));
    sock.destroy();
    return Response.json({ chunks, timeoutListenersPerChunk: counts });
  },
};
```

Expected: `timeoutListenersPerChunk` stays at 1. Actual: it increments with every chunk.

The fix proposed above, keeping the timer handle rather than the return value of `setTimeout` and refreshing one `'timeout'` listener instead of adding one per call, matches what we observe.
