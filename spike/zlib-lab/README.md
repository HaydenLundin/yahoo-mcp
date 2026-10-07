# zlib lab

Standalone check that workerd's `node:zlib` streaming inflater delivers everything. Used on 2026-10-07 to retract a wrong diagnosis of the "16 KB stall" (see `docs/upstream/workerd-zlib-inflate-stall.md`). No imapflow, no network, nothing listens on a port.

`experiment.mjs` compresses a highly compressible `* SEARCH ...` line with DEFLATE-raw and `Z_SYNC_FLUSH`, writes it into `createInflateRaw({ chunkSize })` in one or several pieces without ending the stream, and counts the inflated bytes that come out on their own. `node-control.mjs` runs it in Node; `worker.mjs` plus `config.capnp` run the identical code inside workerd through its one-shot test runner.

Run from this directory:

```bash
node node-control.mjs
```

```bash
../../node_modules/.pnpm/@cloudflare+workerd-windows-64@1.20260908.1/node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe test config.capnp
```

Adjust the platform package name (`workerd-darwin-arm64`, `workerd-linux-64`) and version to what is installed. Expected: every row ends in `COMPLETE` on both runtimes.
