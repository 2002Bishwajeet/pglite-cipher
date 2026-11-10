<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-03).
Title: Spike: prototype filesystem, filesystem-operation trace, and a benchmark page with gates
Labels: agent-ready, security
Replaces: phase 0 of docs/research/2026-11-10-spec-v1.md.
Cross-repository: gate G7 needs the bench endpoints of 2002Bishwajeet/journal (plan file journal/02). Without them the page skips the G7 rows; this issue does not wait for them.
-->
## Context
Before the real code is written, three things must be measured, because each can change the format:

1. **Which filesystem operations Postgres really makes** in PGlite 0.5.10. A dirty-block tracker that misses one operation loses data (review finding B3, `docs/research/2026-11-10-review-fable-5.2.md`).
2. **Open time.** The design decrypts the whole database at open (SQLCipher decrypts lazily, page by page). A 100 MB database is 12,800 records at 8 KB. Node measures 20–65 µs per AES-GCM call; webviews are unmeasured. The store is a packed space of blocks under random ids with an encrypted file table (`docs/plan/05-format-v1-crypto-core.md`), so an open reads the table first and then finds each block's place through it. What that indirection costs, at open and per sync, is unmeasured too (gate G9).
3. **Where the encrypted store should live:** IndexedDB in the webview, or a store on the Rust side of a Tauri app. Prior art (Signal, Notesnook desktop) keeps the store and the key outside the renderer, so the owner decides this **before** the package is built, with numbers.

This issue builds a throwaway prototype and a benchmark page that runs in any browser and inside the Tauri shells. The owner runs the page on real devices and decides in #<PC-04>. Nothing from the prototype ships.

Background: `docs/plan/00-overview.md`, `docs/plan/01-sqlcipher-comparison.md` section 3, `docs/research/2026-11-10-prior-art.md`.

## Change
Everything goes under `spike/` and `bench/`. Nothing under `src/`. Add `spike/**/*.test.ts` to the vitest include for as long as `spike/` exists.

1. **Trace filesystem.** `spike/traceFs.ts`: a class extending `MemoryFS` (from `@electric-sql/pglite`) that, in `init`, adds a `preRun` hook wrapping the Emscripten `MEMFS` operations and counting every call with its arguments' shape: `stream_ops.write`, `stream_ops.msync`, `stream_ops.mmap`, `stream_ops.llseek`, `node_ops.setattr` (record whether `size` is set and whether it grows or shrinks), `node_ops.mknod`, `node_ops.rename`, `node_ops.unlink`, `node_ops.rmdir`, `node_ops.symlink`, and any `stream_ops` or `node_ops` key that exists on `MEMFS` and is not in this list (log its name).
   For each `write`, record: offset mod 8192, length mod 8192, whether `offset > node.usedBytes` (a hole), whether the node is still linked.
2. **Upstream sync behaviour.** In the same trace, record when PGlite calls `syncToFs`: after every query? after `pg.transaction()` commits (electric-sql/pglite#1065; fix PR #1205 open)? Does `pg.syncToFs()` return before syncing when one is queued (#1191; 0.5.10 has `if (this.#syncQueued) return`)? Does a rejected background sync under `relaxedDurability` surface anywhere (#1063)? Write the answers in `spike/RESULTS.md`. The filesystem is designed not to depend on them (#<PC-08>); the answers size the idle flush in Journal.
3. **Workload.** `spike/workload.ts`: a note-taking shaped schema of its own (do not copy another project's schema): a table of `BYTEA` update blobs keyed by a document UUID with a serial id; a search table with `TEXT`, `JSONB` and a `tsvector` with a GIN index; a `pg_trgm` GIN index; a key-value table; the `live` extension with one live query. Run: initdb, the schema, 2,000 inserts of 4 KB blobs, updates, deletes, `VACUUM`, `CHECKPOINT`, enough writes to switch WAL segment twice, close and reopen. Write the op histogram to `spike/RESULTS.md`. State explicitly: does `msync` occur; do unaligned writes occur and on which files; do writes past EOF occur; do truncates and re-extends occur; how are WAL segments recycled (rename or unlink+create); the size and file count of a fresh data directory.
4. **Prototype filesystem.** `spike/protoFs.ts`: the smallest thing that can be timed. Extends `MemoryFS`; tracks dirty blocks per node from the hooks above (mark every block from `min(oldSize, newSize)` on any size change; treat `msync` as a write); `syncToFs` copies dirty blocks synchronously, encrypts them with WebCrypto AES-256-GCM under a subkey from HKDF-SHA256(key, random 16-byte session salt) (random 12-byte nonce, AAD = file id + block index, the salt stored in each record), and writes them in **one** IndexedDB `readwrite` transaction. **The prototype uses the packed layout, because that is what the gates must price:** every block is a value of `44 + blockSize` bytes under a random 16-byte id (a 32-character hex string key), kept for as long as the block exists and overwritten in place; an in-memory file map (path, size, mode, ordered block ids per file) is packed into file-table blocks of the same size, and a sync rewrites only the table blocks whose entries changed (a new, grown, shrunk, renamed or removed file), never one for a file whose contents alone changed; one root record under the number key `2` lists the table blocks' ids; removed blocks are deleted by id in the same transaction. `initialSyncFs` reads the root, fetches and decrypts the table blocks, builds the id → (file, index) map, then reads every block with key-range `getAll` batches of 512 records in key order and decrypts with 64 calls in flight, deriving one subkey per distinct salt and copying each block to its place through the map. Block size is a constructor option: 8192, 32768, 65536. No key wrapping, no header envelope, no digests, no error handling beyond throwing.
5. **Benchmark page.** `bench/index.html` + `bench/bench.ts`, built to a static `bench/dist/` by `npm run bench:build` and served with COOP/COEP headers by `npm run bench:serve`. The page:
   - builds a database of a chosen size (10 or 100 MB, by inserting blobs), once with plain `IdbFs` and once per block size with the prototype;
   - measures, 20 runs each, p50 and p95: **G1** sync time after a one-row `UPDATE`; **G2** open time (`initialSyncFs` start to `waitReady`); **G4** sync time across a WAL segment switch;
   - reports **G3** peak memory where `performance.measureUserAgentSpecificMemory()` or `performance.memory` exists, else "not available";
   - reports **G6** support: AES-GCM, HKDF `deriveKey` to an AES-GCM key, `unwrapKey` of a raw key into an HKDF key, IndexedDB `durability: "strict"` and `"relaxed"` (open a transaction with each and report `transaction.durability`), number and string keys in one object store with the numbers ordered first, key-range `getAll` over the string keys, and the time of 2,048 single-key deletes in one transaction beside 2,048 puts;
   - reports **G9**: at open, the time from the first read to a complete file map (root, table blocks fetched, decrypted, map built) beside the whole open; the number of table blocks; and per sync over the whole workload, how many table blocks were written (median, 95th percentile, and the count for the G1 sync);
   - reports **G8**: the time of one HKDF `deriveKey` (median of 1,000), and, from a simulated year (365 open/edit/checkpoint/close sessions on the prototype), how many distinct session salts still own at least one live record at the end;
   - reports the raw AES-GCM micro-benchmark: encrypt then decrypt 100 MB at 8, 32 and 64 KB units, 64 calls in flight, a fresh random nonce and 24 bytes of AAD per call (the Node version is `docs/plan/gcmbench.mjs`);
   - **G7 (only when `window.__TAURI_INTERNALS__` exists and the host has the bench endpoints of 2002Bishwajeet/journal plan file `journal/02`):** writes and reads 100 MB of 8 KB and 64 KB blocks through (a) the Tauri command `bench_blob_put` / `bench_blob_get` with raw-byte payloads, relayed from the worker through the page with transferables, and (b) `PUT`/`GET http://localhost:47821/__bench/blob` called by `fetch` from the worker with the per-launch token. Reports MB/s for each, and for (a) whether Tauri used its `fetch`-based IPC or fell back to `postMessage` (time a 1 MB echo: the fallback is an order of magnitude slower);
   - has a **Copy results** button that puts one JSON object (user agent, sizes, every number) on the clipboard, and prints it in a `<pre>`.
6. **Run it** where this machine can: `spike/run.mjs` launches Chromium, Firefox and WebKit through Playwright against `bench:serve`, waits for the JSON and saves it to `spike/results/<browser>.json`. Put a summary table in `spike/RESULTS.md` with the gates and pass/fail per target.
7. **Owner run sheet.** `bench/README.md`: how to run the page inside the Tauri shells from a Journal checkout that has `src-tauri` (branch `feat/97-tauri-shell`, or `main` once it has landed), by building the shell with this page as its frontend so that it is served from the app's own `http://localhost:47821` (a secure context on every platform, which a LAN dev URL on a phone is not):
   `npx tauri build --features encfs-bench --config '{"build":{"frontendDist":"<path to pglite-cipher>/bench/dist","beforeBuildCommand":""}}'`, and the same with `tauri ios build` and `tauri android build`. Say where to paste the JSON (#<PC-04>).

Gates (from `docs/plan/01-sqlcipher-comparison.md` 3.3):

| Gate | Pass |
|---|---|
| G1 sync | encrypted p50 ≤ 2× plain `idb://`, 100 MB, one-row update |
| G2 open | ≤ 2× plain and ≤ 1.5 s (100 MB, desktop), ≤ 3 s (100 MB, slowest target), ≤ 400 ms (10 MB) |
| G3 memory | open ≤ database + 64 MB |
| G4 segment switch | ≤ 500 ms desktop, ≤ 1 s slowest target |
| G5 unit size | smallest of 8/32/64 KB that passes G2 |
| G6 support | all present, or a named fallback |
| G7 Rust store throughput | recorded only; it prices owner question 2 |
| G8 subkeys | (distinct live salts) × (one `deriveKey`) ≤ 10 % of the G2 budget |
| G9 file table | file-map phase of the open ≤ 5 % of the G2 budget; the G1 sync writes no file-table block; table blocks per sync recorded |

## Verification
- `~/.claude/bin/heavy npm test -- spike` runs the trace workload in Node and a round-trip test of the prototype with `fake-indexeddb`: write, sync, reopen, every table's row count and a checksum of the blob table equal.
- `~/.claude/bin/heavy npm run bench:build` exits 0 and writes `bench/dist/index.html`.
- `~/.claude/bin/heavy node spike/run.mjs` writes `spike/results/chromium.json`, `firefox.json` and `webkit.json`.
- `~/.claude/bin/heavy npm run lint` and `~/.claude/bin/heavy npm run build` exit 0.
- `spike/RESULTS.md` exists with: the op histogram and the explicit answers of steps 2 and 3; the gate table per measured target; the G9 numbers and, from the trace, how often a sync changes the file table at all (creates, size changes, renames and removals per sync); the unit size it recommends; a list of what only the owner can measure (WKWebView, iOS, WebView2, Android WebView, G7).
- The PR description repeats the gate table and says plainly which gates failed, if any.

## STOP and comment on the issue if
- The trace shows an operation that changes file contents and cannot be hooked from `preRun` (for example writes through `mmap` with no `msync`, or a write path that bypasses `MEMFS.stream_ops`). Report the operation and the call site in the PGlite bundle.
- `MemoryFS` cannot be subclassed to run `initialSyncFs` before initdb decides whether a database exists (PGlite runs initdb when `PG_VERSION` is missing after `initialSyncFs`).
- A browser lacks HKDF `deriveKey` or cannot unwrap into an HKDF key (G6). Report the browser.
- G1 or G2 fails in Chromium at every unit size. Report the numbers; do not tune the prototype for more than a day.
- G9 fails, or the trace shows that ordinary syncs change the file table most of the time (for example a file whose size changes at every commit). The packed layout then costs a table block on most syncs; report which files and how often, because the remedy is a format decision.

## Metadata
Depends on: #<PC-02>
Size: M
Area: spike, bench, security
Model: opus
Effort: high
