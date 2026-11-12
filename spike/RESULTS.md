# Spike results (issue #2)

Throwaway measurements for the owner's decision in #3. PGlite 0.5.10. Nothing under `spike/` or
`bench/` ships. Raw numbers: `spike/results/trace.json` (the trace, Node) and
`spike/results/<browser>.json` (the benchmark page, headless Playwright on the Linux host, a 16 GB
ROG G14 that other harness jobs share: timings are noisy, see "Noise" below).

**Verdict: STOP condition 4 applies.** G2 at 10 MB (≤ 400 ms) fails in Chromium at every unit
size: plain `idb://` itself takes 361-746 ms to open the same data directory, so the 400 ms
budget is below what PGlite needs to start on its smallest store. G2 at 100 MB passes at 64 KB in
Chromium and at 32 and 64 KB in Firefox. G3 fails as measured, for plain `idb://` too. Every other
gate passes at 32 and 64 KB on both engines.

## 1. Filesystem-operation trace (steps 1-3)

`spike/traceFs.ts` wraps every `MEMFS.stream_ops` and `MEMFS.node_ops` function from a `preRun`
hook; `spike/workload.ts` runs initdb, a note-taking schema (BYTEA update blobs, a search table with
`TEXT`, `JSONB`, a `tsvector` GIN index and a `pg_trgm` GIN index, a key-value table, one `live`
query), 2,000 inserts of 4 KB blobs, 200 updates, 20 transactions, deletes, `VACUUM`,
`CHECKPOINT`, writes until the WAL switches segment twice, close and reopen. Before close and after
reopen every table's row count and the blob checksum are equal.

### Op histogram (whole run, both sessions)

| Operation | Calls | Notes |
| --- | ---: | --- |
| `stream_ops.write` | 16,633 | 15,217 inside PGDATA |
| `stream_ops.llseek` | 7,105 | |
| `stream_ops.read` | 6,254 | |
| `node_ops.setattr` | 6,213 | 1,983 inside PGDATA, **none with a size** |
| `node_ops.lookup` | 4,282 | |
| `node_ops.mknod` | 2,544 | 1,039 creates inside PGDATA |
| `node_ops.getattr` | 100 | |
| `node_ops.readdir` | 33 | |
| `node_ops.rename` | 12 | |
| `node_ops.unlink` | 9 | |
| `stream_ops.mmap` | 4 | `/dev/shm/PostgreSQL.N` only (outside PGDATA) |
| `node_ops.symlink` | 4 | outside PGDATA (PGlite's own layout) |
| `node_ops.readlink` | 4 | |
| `stream_ops.msync` | 0 | |
| `node_ops.rmdir` | 0 | |

No other `stream_ops` or `node_ops` key exists on `MEMFS` beyond these.

Writes inside PGDATA by file class:

| File class | Writes | Bytes | Unaligned offset | Unaligned length |
| --- | ---: | ---: | ---: | ---: |
| `base/N/N` (relations) | 12,083 | 112,156,672 | 0 | 0 |
| `pg_wal/<segment>` | 2,358 | 79,380,480 | 0 | 0 |
| `base/N/pg_internal.init.N` | 242 | 261,336 | 240 | 242 |
| `base/N/N_fsm` | 201 | 3,612,672 | 0 | 0 |
| `base/N/N_vm` | 148 | 1,212,416 | 0 | 0 |
| `global/N` | 48 | 376,832 | 0 | 0 |
| `global/pg_internal.init.N` | 42 | 45,656 | 40 | 42 |
| `pg_wal/xlogtemp.N` | 32 | 33,554,432 | 0 | 0 |
| `global/N_fsm`, `global/N_vm` | 18 | 229,376 | 0 | 0 |
| `global/pg_control` | 9 | 73,728 | 0 | 0 |
| `pg_xact/N`, `pg_subtrans/N`, `pg_multixact/*` | 12 | 98,304 | 0 | 0 |
| `pg_logical/replorigin_checkpoint.tmp` | 6 | 24 | 3 | 6 |
| `postmaster.pid` | 4 | 180 | 0 | 4 |
| `base/N/pg_filenode.map`, `global/pg_filenode.map` | 4 | 2,096 | 0 | 4 |
| `base/N/PG_VERSION`, `PG_VERSION` | 4 | 12 | 0 | 4 |
| `pg_stat/pgstat.stat` | 1 | 116,163 | 0 | 1 |
| config files (initdb) | 4 | 41,136 | 0 | 4 |

### Explicit answers

- **`msync`:** never called. **`mmap`:** 4 calls, only on `/dev/shm/PostgreSQL.N` (dynamic shared
  memory, `MAP_SHARED`), outside PGDATA. No write path bypasses `MEMFS.stream_ops.write`, so STOP
  condition 1 does not apply.
- **Unaligned writes:** only on small whole-file rewrites: `pg_internal.init.N` (base and global),
  `pg_logical/replorigin_checkpoint.tmp`, `postmaster.pid`, `pg_filenode.map`, `PG_VERSION`,
  `pgstat.stat` and the config files written by initdb. Relation, WAL, SLRU and `pg_control`
  writes are 8 KB-aligned in offset and length.
- **Writes past EOF (holes):** none. Files grow only by writes at EOF.
- **Truncates and re-extends:** no `setattr` with a size at all (no truncate, no
  `posix_fallocate`), so no truncate followed by a re-extend between syncs.
- **WAL segments:** a new segment is written in full as `pg_wal/xlogtemp.N` (16 MB of 8 KB writes)
  and renamed into place. Old segments are recycled by rename (`pg_wal/<segment> -> pg_wal/<segment>`,
  3 times). No WAL segment is unlinked in this workload.
- **Fresh data directory:** 972 files, 26 directories, 39,854,275 bytes (16 MB is one WAL segment,
  22.4 MB is `base/`).

### Upstream sync behaviour (step 2)

- **When PGlite syncs:** once after every `query` and once after every `exec` (an `exec` of three
  statements syncs once).
- **`pg.transaction()` (electric-sql/pglite#1065):** two queries and the commit make **one** sync,
  and it comes from the `BEGIN`, before the inner queries run; the inner queries and the `COMMIT`
  do not sync. #1065 is confirmed in 0.5.10: a committed transaction is not synced until the next
  query.
- **#1191:** confirmed. A second `pg.syncToFs()` while one is queued returns before any sync has
  run (0 syncs done when it resolved), both when the first has not started and when one is
  already running.
- **#1063:** under `relaxedDurability: true` a failing sync reaches neither the query (it resolves)
  nor an explicit `pg.syncToFs()` (it resolves); it surfaces only as a process-level unhandled
  rejection (`spike/relaxedProbe.mjs`: 2 unhandled rejections from 4 failed syncs).
- **`pg.close()` does not sync.** It writes the shutdown checkpoint into MEMFS and then calls
  `closeFs()`; whatever the filesystem has not written by then is lost (recovery replays the WAL
  at the next open, which is why the round trip still holds). #8 has to sync in `closeFs`.
- `MemoryFS` can be subclassed and `initialSyncFs` runs before PGlite checks for `PG_VERSION`, so
  STOP condition 2 does not apply. `/pglite/data` does not exist yet when `initialSyncFs` runs.

### How often a sync changes the file table (write commits only)

A write commit is a sync with at least one write; the others (a `SELECT`) are left out. A sync
changes the file table when it creates, grows, shrinks, renames or removes a file.

TRACE_TABLE

The growth is almost all the TOAST relation of the blob table: a 4,096-byte blob is 3 TOAST chunks
of about 2 KB, an 8 KB page holds 4, so the TOAST file gains a page on about 2 of every 3 inserts.
Owner decision on the issue (option 1): growth syncs may write a table block. The prototype keeps a
file's size and mode with its tail run of block ids (`spike/protoFs.ts`), so a growing file
rewrites one table block, never all of its runs. The test `spike/protoFs.test.ts` checks that a
sync that changes no file writes no table block and a growing file writes at most one per file
(plus one when its run spills into a new table block).

## 2. Prototype filesystem (step 4)

`spike/protoFs.ts`, as specified: dirty blocks from the hooks; `syncToFs` copies them before the
first `await`, encrypts with AES-256-GCM under HKDF-SHA256(key, session salt), and writes them in
one `readwrite` transaction; packed layout (`44 + blockSize` records under random 16-byte ids,
file-table blocks of the same size, root under the number key `2`). Two fixes over the first
version: the table fix above, and an in-place write now marks only its own blocks (the first
version marked from the write to EOF, which made a one-row `UPDATE` rewrite 13.5 MB of the WAL
segment).

## 3. Gates

Measured by the page (`bench/`), 20 runs each, p50 / p95 in ms. "10 MB" and "100 MB" are the blob
payload added to a fresh database; the data directory is then **67.8 MB** (8,347 records at 8 KB)
and **266.6 MB** (26,501 records at 8 KB), because a fresh directory is 40 MB and the build leaves
WAL segments that the checkpoint recycles but keeps. Every open reads all of it. G4 is a
`SELECT pg_switch_wal()` plus a 4 KB insert in one `exec`, after an untimed `CHECKPOINT`; all 20
runs switched segment. Gates are judged on p50.

### Chromium 158 (headless, Linux)

| | plain | 8 KB | 32 KB | 64 KB |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE, 100 MB | 75.4 / 96.2 | 0.75 / 1.85 ✅ | 1.06 / 4.27 ✅ | 6.84 / 21.0 ✅ |
| G1b sync, one 4 KB insert, 10 MB | 136 / 277 | 1.23 / 1.95 ✅ | 1.53 / 2.23 ✅ | 2.72 / 3.62 ✅ |
| G1b sync, one 4 KB insert, 100 MB | 516 / 687 | 0.96 / 2.16 ✅ | 1.86 / 2.47 ✅ | 10.1 / 19.7 ✅ |
| G1b table blocks per sync (p50 / p95), both sizes | | 1 / 1 ✅ | 1 / 1 ✅ | 1 / 1 ✅ |
| G2 open, 10 MB (≤ 400 ms, ≤ 2× plain) | 746 / 1,091 | 1,523 / 2,044 ❌ | 1,110 / 1,492 ❌ | 771 / 1,133 ❌ |
| G2 open, 100 MB (≤ 1,500 ms, ≤ 2× plain) | 776 / 1,187 | 3,424 / 11,866 ❌ | 2,553 / 4,046 ❌ | 1,432 / 2,738 ✅ |
| G4 segment switch, 10 MB (≤ 500 ms) | 212 / 350 | 289 / 472 ✅ | 148 / 285 ✅ | 136 / 275 ✅ |
| G4 segment switch, 100 MB (≤ 500 ms) | 546 / 671 | 192 / 216 ✅ | 147 / 267 ✅ | 280 / 522 ✅ |
| G9 file-map phase of the open, 10 MB (≤ 20 ms) | | 22.2 ❌ | 19.5 ✅ | 10.1 ✅ |
| G9 file-map phase of the open, 100 MB (≤ 75 ms) | | 34.8 ✅ | 23.3 ✅ | 20.1 ✅ |
| G9 table blocks in the G1 sync (p50 / max) | | 0 / 1 (2 at 100 MB) | 0 / 1 | 0 / 1 |
| G9 table blocks in the open | | 25 / 64 | 4 / 7 | 2 / 3 |

An earlier run on a quieter machine (same build, before the G9 counters were added) measured G2
at 10 MB: plain 361, 8 KB 1,034, 32 KB 732, 64 KB 449; at 100 MB: plain 542, 8 KB 2,896,
32 KB 1,516, 64 KB 871. Same verdicts: 10 MB fails everywhere, 100 MB passes at 64 KB.

### Firefox (Playwright build, headless, Linux)

| | plain | 8 KB | 32 KB | 64 KB |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE, 100 MB | 176 / 234 | 1.58 / 11.3 ✅ | 1.82 / 5.74 ✅ | 2.02 / 6.54 ✅ |
| G1b sync, one 4 KB insert, 10 MB | 233 / 331 | 1.98 / 2.84 ✅ | 2.66 / 3.54 ✅ | 3.26 / 5.14 ✅ |
| G1b sync, one 4 KB insert, 100 MB | 1,064 / 1,377 | 2.72 / 3.98 ✅ | 2.88 / 10.7 ✅ | 4.52 / 6.12 ✅ |
| G1b table blocks per sync (p50 / p95), both sizes | | 1 / 1 ✅ | 1 / 1 ✅ | 1 / 1 ✅ |
| G2 open, 10 MB (≤ 400 ms, ≤ 2× plain) | 673 / 939 | 776 / 983 ❌ | 560 / 610 ❌ | 602 / 809 ❌ |
| G2 open, 100 MB (≤ 1,500 ms, ≤ 2× plain) | 1,829 / 2,337 | 2,139 / 3,154 ❌ | 1,221 / 1,652 ✅ | 1,332 / 1,622 ✅ |
| G4 segment switch, 10 MB (≤ 500 ms) | 289 / 508 | 638 / 834 ❌ | 322 / 352 ✅ | 293 / 520 ✅ |
| G4 segment switch, 100 MB (≤ 500 ms) | 1,073 / 1,202 | 920 / 1,091 ❌ | 355 / 645 ✅ | 330 / 458 ✅ |
| G9 file-map phase of the open, 10 MB (≤ 20 ms) | | 17.2 ✅ | 8.1 ✅ | 6.8 ✅ |
| G9 file-map phase of the open, 100 MB (≤ 75 ms) | | 51.5 ✅ | 15.4 ✅ | 12.4 ✅ |
| G9 table blocks in the G1 sync (p50 / max) | | 0 / 1 (2 at 100 MB) | 0 / 1 | 0 / 1 |

### WebKit

WEBKIT_SECTION

### Gates across targets

| Gate | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| G1 sync (≤ 2× plain, 100 MB) | ✅ all units (0.75-6.8 ms vs 75 ms) | ✅ all units | WEBKIT_G1 |
| G1b sync (≤ 1 table block p50, ≤ 2× plain) | ✅ all units, 10 and 100 MB | ✅ all units | WEBKIT_G1B |
| G2 open, 100 MB (≤ 1.5 s, ≤ 2× plain) | ✅ 64 KB only | ✅ 32 and 64 KB | WEBKIT_G2_100 |
| G2 open, 10 MB (≤ 400 ms) | ❌ every unit (plain: 746 ms) | ❌ every unit (plain: 673 ms) | WEBKIT_G2_10 |
| G3 memory (≤ data + 64 MB) | ❌ as measured, plain too (see below) | not available | WEBKIT_G3 |
| G4 segment switch (≤ 500 ms) | ✅ all units | ✅ 32 and 64 KB; ❌ 8 KB | WEBKIT_G4 |
| G5 unit size | 64 KB | 32 KB | WEBKIT_G5 |
| G6 support | ✅ all present | ✅ all present | WEBKIT_G6 |
| G7 Rust store | owner (Tauri only) | owner | owner |
| G8 subkeys (≤ 150 ms) | ✅ 366 salts × 0.010 ms = 3.7 ms | ✅ 366 × 0.08 ms = 29 ms | WEBKIT_G8 |
| G9 file table | ✅ at 32 and 64 KB; 8 KB misses the 10 MB file-map budget (22 vs 20 ms) | ✅ all units | WEBKIT_G9 |

**G9 and the G1 sync.** In 1 of the 20 G1 syncs (2 at 8 KB, 100 MB) a file grew (a GIN pending-list
or free-space-map page) and that sync wrote one table block. No sync that changed no file wrote a
table block, in any run (`tableBlocksWithoutFileChange` is 0 everywhere), so STOP condition 5 as
the owner restated it does not apply. Strictly read ("the G1 sync writes no file-table block"), G9
fails on that one sync; the page reports both (`G9`, `G9_g1p50`).

**G9 per sync over the whole workload** (build, G1, G1b, G4; Chromium, 100 MB): table blocks per
sync p50 0, p95 7 (8 KB) / 3 (32 KB) / 2 (64 KB); over the syncs that changed a file, p50 3 / 1 / 1,
p95 9 / 3 / 2. The large ones are the 10 MB build inserts and new WAL segments (16 MB = 2,048 ids
at 8 KB, five runs).

**G3.** Headless Chromium has no `measureUserAgentSpecificMemory` (SecurityError); with
`--enable-precise-memory-info`, `performance.memory` plus the wasm heap reads 375-481 MB at
10 MB (data directory 68 MB) and 671-966 MB at 100 MB (267 MB), plain included. The wasm heap alone
is 198 MB in every variant, and MEMFS keeps the whole data directory in JS memory, so G3 as written
(≤ data + 64 MB) fails for plain `idb://` too; the JS-heap figure also holds what earlier variants
left for the GC. Only the owner's devices (Chrome with `measureUserAgentSpecificMemory`) give a
clean number.

**G6.** AES-GCM, HKDF `deriveKey` to AES-GCM, `unwrapKey` of a raw key into HKDF, IndexedDB
`durability` `"strict"` and `"relaxed"` (reported back as asked), number keys ordered before
string keys, key-range `getAll` over the string keys: all present in Chromium and Firefox. 2,048
puts then 2,048 deletes of 8 KB records in one transaction: Chromium 243 / 242 ms, Firefox
449 / 189 ms.

**G8.** After 365 open/edit/checkpoint/close sessions at 8 KB, **366** distinct salts still own a
live record (7,252 records): every session rewrites some record (`pg_control` at least), and the
initdb session still owns most of the blocks. One `deriveKey` is 0.010 ms (Chromium) and 0.08 ms
(Firefox), so the subkeys cost 3.7 and 29 ms at open, under the 150 ms budget (10 % of G2).

**AES-GCM micro-benchmark** (100 MB, 64 calls in flight, encrypt / decrypt MB/s): Chromium
445 / 590 at 8 KB, 916 / 921 at 32 KB, 1,043 / 874 at 64 KB; Firefox 102 / 206, 466 / 496,
722 / 1,002.

## 4. Unit size

**64 KB.** It is the only unit that passes G2 at 100 MB in Chromium, and it passes in Firefox
(where 32 KB passes too). 8 KB fails G2 at 100 MB on both and G4 in Firefox. Nothing passes the
10 MB open budget.

## 5. What only the owner can measure

- **WKWebView** (macOS and iOS), **WebView2** (Windows), **Android WebView**: every gate, on real
  devices, through the Tauri shells (`bench/README.md`). The Linux numbers above are a desktop
  Chromium and Firefox under load from other jobs.
- **iOS** and the slowest target: the G2 ≤ 3 s and G4 ≤ 1 s budgets.
- **G7** (Rust store throughput and whether Tauri used its fetch IPC): only inside a shell built
  with `encfs-bench`.
- **G3** with `measureUserAgentSpecificMemory` (headed Chrome, cross-origin isolated).

## Noise

The host is shared with other harness jobs (`cargo test`, builds) and its heavy lock serializes
only the jobs that take it. Two Chromium runs of the same build differed by up to 2× on G2. Relative
numbers (encrypted against plain in the same run) are stable; absolute ones are not.
