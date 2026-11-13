# Spike #47: on-demand PGlite filesystem through an Atomics bridge over OPFS

Design A of `docs/research/opfs-on-demand.md` (section 3.2), built without the cipher to answer the three questions of that document's section 4. Date: 2026-11-13. PGlite 0.5.10. Throwaway code; nothing in `src/` changed.

**How claims were checked.** Every number comes from the JSON in `spike/results/on-demand/`: `<browser>-<platform>.json` holds the reported desktop runs (written by `run.mjs`), `run1/` an earlier desktop run without the reopen step, and `ios-sim.json` the simulator's on-demand parts. That file was taken from the `bench/results/ios-sim.json` that `bench/device/serve.mjs` wrote. A claim with no measurement behind it is marked **[unverified]** or **[inference]**.

## Answers in short

1. **Cross-origin isolation.** `crossOriginIsolated` was `true` and `SharedArrayBuffer` existed in all four targets: Chromium 158 and Firefox 159 on Linux, WebKit (Safari 27.2) on macOS 27, and Mobile Safari 27.0 in the iOS 27.0 Simulator. All four pages were served with COOP/COEP: by Vite's preview server, or by `bench/device/serve.mjs` for the simulator. Whether the Journal shell (Tauri, WKWebView on iOS) can send those headers was not tested **[unverified]**.
2. **Sync access handles.** `createSyncAccessHandle` works in a dedicated worker in all four targets. One worker opened 1,100 of 1,100 handles in Chromium and Firefox (1,100 is the probe's cap), 251 in WebKit on macOS (the 252nd throws `UnknownError: Invalid platform file handle`, as in the research), and 1,100 of 1,100 in the simulator. So the simulator does not reproduce macOS WebKit's limit; what an iPhone allows is **[unverified]**. The spike needs two per database, `data.bin` and `tree.json`, so the limit does not constrain the design. WKWebView and iOS 18.7 (the iPhone 15 of #42) were not measured.
3. **A 100 MB database, on demand.** It builds, opens and queries in all four targets, and both full scans return the built rows and bytes. Emscripten's MEMFS holds only PGlite's 6.2 MB runtime bundle, against 251 MB on `idb://`. After the open, the browser's RSS over its baseline is 238 MB against 506 MB on `idb://` in Chromium and 319 MB against 696 MB in Firefox (Linux). WebKit's RSS from `ps` is not usable (negative deltas; see the notes under the table). The wasm memory, 198 MB, is the same for both and is the floor. **Whether an iPhone survives that floor stays open.** The simulator cannot answer it: runningboardd gives its WebContent processes no memory limit (`Memory Limits: active 0 inactive 0`, `tasklimit=0`, read from the simulator's log). The physical device runs below answer it, and they are owner-only.

The cost is the bridge round trip. Reads are cheap: a cold full scan after a reopen is faster on demand than on `idb://` in every engine. Writes are the weak spot, because this spike writes through the bridge one request at a time (see Costs).

## What was built

| File | Role |
|---|---|
| `fs.ts` | `OnDemandFs extends BaseFilesystem`, in the PG worker. The directory tree and each file's block list live in memory (251,518 bytes of JSON for the 100 MB database). The bytes live in one OPFS container of 8 KB blocks. Every `read()` and `write()` crosses the bridge synchronously, one request per run of contiguous blocks (at most 256 KB each). Holes read as zeros. The tree is saved to `tree.json` in `syncToFs`, and data is flushed there too. A freed block is reused only after a tree save that no longer points at it. |
| `bridge.ts` | The `SharedArrayBuffer` layout: an `Int32Array` header (state, op, length, offset, result) and a 256 KB data area. The PG worker fills the header, rings the IO worker's `MessagePort` and blocks in `Atomics.wait`, with a 60 s timeout that turns into `EIO`. The IO worker answers, stores the result and calls `Atomics.notify`. |
| `io-worker.ts` | Holds a database's only two sync access handles, `data.bin` and `tree.json`. With `aes`, every request also makes one `crypto.subtle` AES-256-GCM call per 8 KB record (decrypt for a read, encrypt for a write) before it answers. That prices the cipher; the bytes on disk stay plaintext. |
| `pg-worker.ts`, `part.ts` | The bench page parts (`bench/bench.ts`, `bench/index.html`): `ondemand`, `ondemand-aes`, `ondemand-idb` and `ondemand-handles`. `&odmb=` sets the database size (default 100). |
| `run.mjs` | The desktop driver: Playwright with a persistent profile (WebKit refuses OPFS in an ephemeral one), and the RSS of the browser's processes at each probe, measured as in `bench/opfs-memory.mjs`. |

Not built: a page cache, write buffering, crash safety (the tree is rewritten in place, and a crash between a data write and the next tree save can lose or corrupt the database), the sealed format, and more than one tab (a `readwrite` handle locks its file).

## Method

The database is the one from the research (section 1.2): `t(id int primary key, payload text)`, 100,000 rows of 960 hex characters. `pg_database_size` is 112,287,867 bytes and the data directory 245,235,907 bytes; on demand, `data.bin` is 245,334,024 bytes. Each part, with every step in fresh workers:

1. build the database, `checkpoint`, close;
2. take the baseline (on desktop: RSS 3 s later);
3. open (`PGlite.create`, `select 1`), record the wasm memory and MEMFS bytes, take the RSS probe;
4. run a point query by primary key twice (cold, then warm), then the first full scan (`count(*)`, `sum(length(payload))`), take the RSS probe, close;
5. reopen, run the scan again (the cold scan), close, delete the database.

Each query's time includes PGlite's `syncToFs`. On `idb://` that is the IDBFS sync, which is why even a warm point query there takes 19 to 145 ms. Desktop numbers are from one run per engine (the second; the first, without the reopen, gave figures within the ranges quoted in the text). MB = 10^6 bytes.

## Results

| Engine, host | FS | Build (s) | Open (ms) | MEMFS (MB) | RSS over baseline, after open / after the first scan (MB) | Point query, cold / warm (ms) | First scan (ms) | Reopen (ms) | Cold scan (ms) | Scans match the build |
|---|---|---|---|---|---|---|---|---|---|---|
| Chromium 158, Linux (mini PC) | on demand | 9.1 | 353 | 6.2 | 238 / 253 | 3 / 1 | 1,176 | 300 | 402 | yes |
| Chromium 158, Linux (mini PC) | on demand + AES | 7.7 | 329 | 6.2 | 256 / 253 | 5 / 1 | 1,515 | 292 | 656 | yes |
| Chromium 158, Linux (mini PC) | `idb://` | 7.0 | 809 | 251 | 506 / 501 | 60 / 32 | 880 | 1,704 | 849 | yes |
| Firefox 159, Linux (mini PC) | on demand | 11.8 | 347 | 6.2 | 319 / 309 | 6 / 1 | 3,358 | 358 | 856 | yes |
| Firefox 159, Linux (mini PC) | on demand + AES | 14.1 | 366 | 6.2 | 300 / 334 | 15 / 2 | 4,008 | 387 | 1,142 | yes |
| Firefox 159, Linux (mini PC) | `idb://` | 10.8 | 1,457 | 251 | 696 / 786 | 21 / 19 | 1,513 | 3,185 | 1,446 | yes |
| WebKit (Safari 27.2), macOS 27 | on demand | 7.6 | 270 | 6.2 | n/m | 6 / 2 | 1,759 | 234 | 332 | yes |
| WebKit (Safari 27.2), macOS 27 | on demand + AES | 8.1 | 240 | 6.2 | n/m | 1,027 / 3 | 2,006 | 268 | 381 | yes |
| WebKit (Safari 27.2), macOS 27 | `idb://` | 11.1 | 975 | 251 | n/m | 191 / 145 | 983 | 2,224 | 868 | yes |
| iOS 27.0 Simulator (iPhone 17e), Mobile Safari 27.0 | on demand | 14.4 | 291 | 6.2 | none | 5 / 1 | 2,089 | 282 | 342 | yes |
| iOS 27.0 Simulator (iPhone 17e), Mobile Safari 27.0 | on demand + AES | 10.1 | 366 | 6.2 | none | 7 / 2 | 4,548 | 303 | 426 | yes |
| iOS 27.0 Simulator (iPhone 17e), Mobile Safari 27.0 | `idb://` | 20.9 | 1,927 | 251 | none | 171 / 158 | 1,932 | 3,132 | 1,797 | yes |

n/m: not meaningful. WebKit's deltas over baseline came out negative in two of three runs (for example -64 and -130 MB). The research saw the same: `ps` misses WebKit processes, or macOS compresses idle pages **[unverified]**. In the simulator the page has no driver, so there is no RSS at all. The wasm memory was 197,918,720 bytes after each first open in every engine (`HEAPU8.byteLength`); `shared_buffers` is 128 MB.

What crossed the bridge, from `fs.ts`'s counters (the time is wall time inside `read()` or `write()`, round trips included):

| Engine | FS | Build: writes / ms | First scan: reads / ms | First scan: writes / ms | Cold scan: reads / ms / mean ms per read | Cold point query: reads / mean ms |
|---|---|---|---|---|---|---|
| Chromium 158, Linux | on demand | 34,908 / 2,917 | 796 / 83 | 11,808 / 651 | 936 / 102 / 0.109 | 17 / 0.044 |
| Chromium 158, Linux | on demand + AES | 34,908 / 3,607 | 796 / 228 | 11,808 / 884 | 936 / 357 / 0.381 | 17 / 0.162 |
| Firefox 159, Linux | on demand | 34,908 / 6,907 | 796 / 191 | 11,808 / 2,334 | 936 / 327 / 0.349 | 17 / 0.229 |
| Firefox 159, Linux | on demand + AES | 34,908 / 9,265 | 796 / 375 | 11,808 / 2,843 | 936 / 591 / 0.631 | 17 / 0.691 |
| WebKit (Safari 27.2), macOS 27 | on demand | 34,908 / 4,467 | 796 / 141 | 11,808 / 1,269 | 936 / 144 / 0.154 | 17 / 0.145 |
| WebKit (Safari 27.2), macOS 27 | on demand + AES | 34,908 / 5,452 | 796 / 177 | 11,808 / 1,478 | 936 / 184 / 0.196 | 17 / 59.701 |
| iOS 27.0 Simulator | on demand | 34,908 / 8,795 | 796 / 156 | 11,808 / 1,568 | 936 / 146 / 0.156 | 17 / 0.156 |
| iOS 27.0 Simulator | on demand + AES | 34,908 / 7,003 | 796 / 407 | 11,808 / 3,656 | 936 / 232 / 0.248 | 17 / 0.244 |

The counts are the same in every engine: the build writes 460 MB in 34,908 writes, and the open reads 1.7 MB in 161 reads. The first scan reads 102.5 MB in 796 reads and writes 96.7 MB. The cold scan reads 102.6 MB in 936 reads (1,200 round trips) and writes nothing. The first scan's reads average 129 KB and the cold scan's 110 KB, so Postgres combines adjacent pages into one read **[unverified: presumably PostgreSQL 17's read streams, `io_combine_limit` = 128 kB]**.

## Costs

- **Opens are faster, because nothing is loaded.** Plain on demand, an open takes 233 to 447 ms on desktop (both runs) and 291 ms in the simulator, against 809 to 1,690 ms and 1,927 ms on `idb://`. A reopen after the first scan takes 234 to 387 ms (simulator 282 to 303) against 1,704 to 3,185 ms (simulator 3,132).
- **Reads are cheap.** A cold scan of the 112 MB table takes 332 to 856 ms on demand on desktop and 342 ms in the simulator, against 849 to 1,446 ms and 1,797 ms on `idb://`. Its read time totals 102 ms (Chromium), 327 ms (Firefox), 144 ms (WebKit) and 146 ms (simulator). A cold point query makes 17 reads and takes 3 to 6 ms (20 ms in Firefox's first run).
- **Writes are the cost: every write is a synchronous round trip.** The first scan after the bulk load writes back nearly what it reads (11,808 writes, 96.7 MB), and the cold scan after the reopen writes nothing. So these are hint-bit writes **[inference]**. They make the first scan slower than on `idb://`: 1,176 against 880 ms (Chromium), 3,358 against 1,513 ms (Firefox), 1,759 against 983 ms (WebKit) and 2,089 against 1,932 ms (simulator), where 0.65 s, 2.3 s, 1.3 s and 1.6 s of it is write time. Firefox's writes cost 0.2 to 0.43 ms each in its two runs. Design A as the research describes it keeps dirty pages in memory and seals them in `syncToFs`. That batches these round trips, but it is not built here.
- **AES-GCM in the IO worker.** The cold scan costs +254 ms (Chromium), +286 ms (Firefox), +49 ms (WebKit) and +84 ms (simulator), 0.04 to 0.28 ms per 110 KB read, which makes about 14 decrypts. The first scan costs +339, +650, +247 and +2,459 ms, and the build +0.7, +2.4 and +1.0 s of write time on desktop. In the simulator, the AES build's write time came out lower than plain (7.0 against 8.8 s), so a single simulator run cannot price the cipher's write cost. The pricing makes one AES-GCM call per 8 KB record, as an 8 KB sealed-block format would; `FORMAT.md`'s 64 KB blocks would make 8 times fewer calls **[inference]**.
- **Open question: WebKit's AES point query after an idle.** In all three desktop WebKit runs, the first point query after the open took about 1 s: 1,059 and 1,027 ms in the two saved here, 17 reads at about 60 ms each. Plain on demand took 5 to 6 ms, and the warm repeat 3 ms. The driver waits 3 s before that query (its RSS probe). In the simulator, which has no probe and so no idle, the same query took 7 ms. That suggests WebKit throttles an idle worker's `crypto.subtle` completions **[unverified cause]**. It matters on a phone, where most reads come after an idle. The device runs below do not test it, because the page has no idle there either.
- **Disk.** On demand, OPFS holds the 245 MB container plus the tree; `navigator.storage.estimate()` reported 246 to 271 MB on desktop. The simulator's figure is not comparable, because the origin still held the stopped first run's `idb://` database (see the tooling note).

## Owner-only device runs

They need the paired devices, so the owner runs them and nobody waits for them. Run them in this order: the on-demand parts first, then `idb://` (which crashed the iPhone at 100 MB, #42), and the handle probe last:

```sh
scripts/harness/remote.sh mac bash bench/device/mac.sh iphone-15 ondemand,ondemand-aes,ondemand-handles,ondemand-idb 1
scripts/harness/remote.sh mac bash bench/device/mac.sh ipad-air-m3 ondemand,ondemand-aes,ondemand-handles,ondemand-idb 1
```

Each part is posted as soon as it finishes, into `bench/results/<target>.json`. If the tab dies during a part, the earlier parts are kept. The questions they answer: does the iPhone 15 (iOS 18.7) keep the tab alive after `ondemand` opens and scans 100 MB, and how many handles does iOS 18.7 allow?

**Tooling note.** In the first simulator run, a stale client loaded an old URL (`parts=gates100,extras&post=ios-sim`) against the collector halfway through and stalled our tab; its user agent had no `Safari/` token. That run was stopped and its `idb://` part is missing, and the rerun is the one reported here. Before an unattended device run, make sure no old bench tab is open on the device.

## For the owner's decision (STOP)

The spike shows that design A works without changing PGlite. On WebKit as well, it opens a 100 MB database with two handles, moves the data directory out of memory, and reads cheaply. Building it in `src/` needs, at least:

1. **Crash safety on OPFS (format work).** The tree save has to be atomic: two slots with a generation counter, or a log. `FORMAT.md`'s protocol has to move from IndexedDB transactions to OPFS files and their `flush()`.
2. **The sealed format and write buffering.** Dirty pages stay in memory and are sealed in `syncToFs`, so the first-scan and bulk-load write costs above do not pay one round trip per write.
3. **COOP/COEP in the Tauri shells**, without which there is no `SharedArrayBuffer` (question 1 for the shell **[unverified]**).
4. **The device answer to question 3**: the iPhone 15 runs above.
