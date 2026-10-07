# postalsys/imapflow#426: `download()` ends after its first chunk on Yahoo

Status: **filed by the operator on 2026-10-07** as https://github.com/postalsys/imapflow/issues/426, closed the same day by commit 74fad57, released in 2.2.10. The fix makes `fetchOne()` merge the rows of the requested message when a FETCH answer also carries unsolicited rows. **Our re-test on 2.2.10 still ends early**, and a protocol trace shows a different mechanism. The follow-up comment below is drafted, not posted. Posting is a public action in the operator's name.

Repro tool: spike route `GET /download?uid=<uid>&part=<part>&chunk=<bytes>` (`spike/index.ts`) runs `download()` under imapflow's own protocol trace and returns the exchange. One Yahoo login per call.

---

## Draft follow-up comment for #426

Thanks for the quick fix. We re-tested on 2.2.10 (the `ID` line in the trace confirms the version) and the early end still happens on Yahoo. A protocol trace of a short run shows no unsolicited rows at all. The server answers the continuation window with an **empty string** instead of the requested literal, and then `OK`:

```
8 UID FETCH 228553 (UID RFC822.SIZE EMAILID BODY.PEEK[2.MIME] BODY.PEEK[2]<0.65536>)
* 9207 FETCH (UID 228553 RFC822.SIZE 199310 EMAILID (AAGaP8jJ9b3Z5wjGJjyVwXGDxMQ) BODY[2.MIME] {109} BODY[2]<0> {65536})
8 OK UID FETCH completed
9 UID FETCH 228553 (EMAILID UID BODY.PEEK[2]<65536.65536>)
* 9207 FETCH (UID 228553 EMAILID (AAGaP8jJ9b3Z5wjGJjyVwXGDxMQ) BODY[2]<65536> "")
9 OK UID FETCH completed
A LOGOUT
```

The identical request in a successful run, one minute earlier, got `BODY[2]<65536> {65536}` and the download continued to 174,045 decoded bytes (183,558 raw). The part is 183,558 bytes long, so `<65536.65536>` is well inside it.

What we have observed across runs today, all against `imap.mail.yahoo.com` with `COMPRESS=DEFLATE` on, from Cloudflare Workers (local workerd 1.20260908.1 and the production edge):

| Call shape | Runs | Result |
|---|---|---|
| `download()` default 64 KiB chunks | 6 | 3 complete, 3 ended after the first window with the server returning `""` |
| `download()` with `chunkSize: 12000` | 4 | 2 complete (15 windows), 2 ended after the first window |
| Our own loop of `fetchOne(uid, { uid: true, bodyParts: [{ key, start, maxLength }] })`, 60,000 or 65,536 byte windows | 8 | 8 complete, every window full length |

The visible difference between the two shapes is that `download()`'s continuation requests include `EMAILID` (`(EMAILID UID BODY.PEEK[2]<65536.65536>)`) while our loop sends `(UID BODY.PEEK[2]<60000.60000>)`. The failing responses came from different Yahoo backend hosts (`jimap400010`, `jimap400170`, `jimap400135` appear in the `ID` replies), so it may be a backend-specific quirk rather than something deterministic.

Two thoughts, offered without certainty:

1. If the empty partial is a Yahoo server bug, `download()` could still defend against it: when a window returns zero bytes but the previous window was full length and the offset is below any known size, retry the window once (or once without `EMAILID`) before treating it as the end. Right now the stream ends cleanly and the caller has no way to tell a short part from a truncated one.
2. It may be worth checking whether requesting `EMAILID` together with a partial body section is what provokes the empty answer. We did not isolate that; our control loop never asked for `EMAILID`.

Full traces for the three runs are available on request. Environment: imapflow 2.2.10 ESM build, wrangler 4.130.0, `compatibility_date: "2026-09-01"`, `nodejs_compat`.

---

## Notes for this project

- Our tools never call `download()`; `downloadText` in `src/lib/imap.ts` is the `fetchOne` window loop in the table, complete in every run so far.
- `downloadText` would also stop on an empty window (`chunk.length === 0`) and return a silently shortened body. We have not seen Yahoo do that to a request without `EMAILID`, but if a user ever reports a cut-off body, this is the first place to look, and a one-shot retry of an empty window is the obvious hardening.
- Trace files from 2026-10-07 were kept in the session scratchpad only; the spike route regenerates them in seconds.
