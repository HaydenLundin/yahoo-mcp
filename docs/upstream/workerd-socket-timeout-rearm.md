# Draft issue for cloudflare/workerd

Status: not filed. Paste into https://github.com/cloudflare/workerd/issues/new when ready.

---

**Title:** `node:net` `socket.setTimeout()` adds a new `'timeout'` listener per data chunk and fires all of them at once

**Summary**

After calling `socket.setTimeout(ms)` once on a `node:tls` (or `node:net`) socket, each incoming data chunk re-arms the idle timer by registering another `'timeout'` listener instead of refreshing a single timer. Symptoms:

1. `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 timeout listeners added` after ~10 chunks, and `socket.listenerCount('timeout')` grows without bound (44 after a 70 KB response in 34 chunks).
2. When the socket then goes idle, all accumulated timers fire in the same millisecond, so a library's `'timeout'` handler runs 20+ times for one idle period.
3. In `wrangler dev` only, the warning path itself throws `Uncaught TypeError: Cannot read properties of undefined (reading 'emit') at node-internal:internal_process`, because `process.emitWarning` reaches for a `process` object that is not available in that context. The edge logs the warning correctly.

Node 22 keeps exactly one listener and one timer, refreshed on activity.

**Repro**

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
    sock.write("A1 CAPABILITY\r\n"); // any server that answers with a few chunks
    await new Promise((r) => setTimeout(r, 2000));
    sock.destroy();
    return Response.json({ chunks, timeoutListenersPerChunk: counts });
  },
};
```

Expected: `timeoutListenersPerChunk` stays at 1.
Actual: it increments with every chunk.

**Environment**

- wrangler 4.130.0, workerd 1.20260908.1 (local) and production edge, 2026-10-07
- `compatibility_flags: ["nodejs_compat"]`, `compatibility_date: "2026-09-01"`
