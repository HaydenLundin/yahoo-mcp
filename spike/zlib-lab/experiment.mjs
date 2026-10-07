// Shared experiment: feed a highly compressible, DEFLATE-raw payload into a streaming
// inflater the way imapflow does (createInflateRaw({ chunkSize: 16 KiB }), socket piped in,
// writable side never ended) and count how many inflated bytes come out on their own.
// Runs unchanged in Node (control) and in workerd (system under test).
const CRLF = String.fromCharCode(13, 10);

export async function experiment(zlibMod, { bytes, writes, chunkSize, mode }) {
  const { createInflateRaw, deflateRawSync, constants } = zlibMod;
  let line = "* SEARCH";
  let i = 1;
  while (line.length < bytes) line += " " + i++;
  line += CRLF;
  const input = new TextEncoder().encode(line);
  // "final": a complete deflate stream. "sync": Z_SYNC_FLUSH with no final block, which is
  // what an IMAP COMPRESS=DEFLATE server emits mid-session (the stream never ends).
  const compressed =
    mode === "sync"
      ? deflateRawSync(input, { finishFlush: constants.Z_SYNC_FLUSH })
      : deflateRawSync(input);
  const inflate = createInflateRaw({ chunkSize });
  let out = 0;
  let dataEvents = 0;
  let ended = false;
  let error = null;
  inflate.on("data", (c) => {
    out += c.length;
    dataEvents++;
  });
  inflate.on("end", () => {
    ended = true;
  });
  inflate.on("error", (e) => {
    error = String(e && e.message);
  });
  const piece = Math.ceil(compressed.length / writes);
  for (let p = 0; p < compressed.length; p += piece) {
    inflate.write(compressed.subarray(p, Math.min(p + piece, compressed.length)));
  }
  // Like a live socket: do NOT end the writable side. Measure what came out on its own.
  await new Promise((r) => setTimeout(r, 1500));
  const outBeforeEnd = out;
  const eventsBeforeEnd = dataEvents;
  inflate.end();
  await new Promise((r) => setTimeout(r, 500));
  return {
    mode,
    writes,
    chunkSize,
    expected: input.length,
    compressedBytes: compressed.length,
    outBeforeEnd,
    eventsBeforeEnd,
    outAfterEnd: out,
    ended,
    error,
    complete: outBeforeEnd === input.length,
  };
}

export const CASES = [
  { bytes: 8_000, writes: 1, chunkSize: 16 * 1024, mode: "sync" }, // under one chunk: control
  { bytes: 70_000, writes: 1, chunkSize: 16 * 1024, mode: "sync" }, // the Yahoo SEARCH case
  { bytes: 70_000, writes: 8, chunkSize: 16 * 1024, mode: "sync" }, // input arriving in pieces
  { bytes: 70_000, writes: 1, chunkSize: 16 * 1024, mode: "final" },
  { bytes: 300_000, writes: 4, chunkSize: 16 * 1024, mode: "sync" }, // many output chunks
  { bytes: 70_000, writes: 1, chunkSize: 128 * 1024, mode: "sync" }, // chunkSize above output
];

export function row(r) {
  const pad = (v, n) => String(v).padEnd(n);
  return (
    `${pad(r.mode, 5)} writes=${pad(r.writes, 2)} chunk=${pad(r.chunkSize, 6)} ` +
    `expected=${pad(r.expected, 6)} outBeforeEnd=${pad(r.outBeforeEnd, 6)} ` +
    `events=${pad(r.eventsBeforeEnd, 3)} afterEnd=${pad(r.outAfterEnd, 6)} ` +
    `ended=${r.ended} err=${r.error} => ${r.complete ? "COMPLETE" : "INCOMPLETE"}`
  );
}
