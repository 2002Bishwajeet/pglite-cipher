# On-demand encrypted storage for PGlite (opfs-ahp, JSPI)

Research for issue #43. Date: 2026-11-13. Nothing in `src/` changed. PGlite is the version we depend on, `@electric-sql/pglite` 0.5.10; its TypeScript sources were read from the source maps shipped in `node_modules/@electric-sql/pglite/dist` (`src/fs/opfs-ahp.ts`, `src/fs/base.ts`, `src/fs/idbfs.ts`, `src/pglite.ts`) and its wasm imports were listed with `WebAssembly.Module.imports`.

**How claims were checked.** A claim with a file, a measurement or a linked primary source next to it was checked against that. **[unverified]** marks everything else: search snippets, secondary sites, derived ("mirror") compatibility data, and my own inferences that no measurement covers.

The measurements come from `node bench/opfs-memory.mjs` (with `bench/opfs-memory.html`, `.ts` and `-worker.ts`); the JSON is in `bench/results/opfs-memory/`.

## Answers in short

1. **`opfs-ahp://` reads on demand.** Each Postgres read goes straight from an OPFS sync access handle into the wasm heap; nothing holds the data directory. Take a 112 MB database with a 245 MB data directory. The bytes Emscripten's MEMFS holds drop from 251 MB on `idb://` to 6 MB, the PGlite runtime bundle. The browser's resident memory after the open is 218 to 252 MB lower (Chromium on Linux and macOS, Firefox on Linux). The wasm memory, 198 MB, is the same for both and becomes the floor. **In WebKit `opfs-ahp` does not open at all.** WebKit allows 251 sync access handles, PGlite's `opfs-ahp` asks for over 1,000, and PGlite's pool code then hangs instead of failing (section 1.3).
2. **Engines:** OPFS sync access handles exist in Chromium 102+, Firefox 111+, Safari and iOS Safari 15.2+, Android WebView and WKWebView (by derivation from Chrome Android and iOS Safari). PGlite's `opfs-ahp` works in Chromium and Firefox and **not in WebKit** (Safari, iOS Safari, WKWebView), because of the handle limit.
3. **Encryption under it with WebCrypto only is possible** without changing PGlite: the synchronous `read()` blocks in `Atomics.wait` while a second worker reads the sealed page and opens it with `crypto.subtle`. Measured cost per 8 KB page that misses the cache (mean): 0.02 to 0.07 ms in Chromium, 0.13 ms in WebKit, 0.36 ms in Firefox. Because the crypto worker can pack pages into a few files, the bridge also avoids WebKit's handle limit. JSPI is the cleaner design but needs a rebuilt PGlite and iOS 27. Asyncify needs the same rebuild and costs about 50 % in speed and size. A decrypt-ahead cache cannot work alone, and a synchronous cipher is forbidden here.
4. **Recommendation: worth building as the Atomics bridge, gated on a one-day spike in the iOS shell.** That spike must show three things in WKWebView: cross-origin isolation (the bridge needs `SharedArrayBuffer`), OPFS sync access handles, and that an iPhone 15 survives the remaining floor (300 to 365 MB of RSS on desktop). Do not wait for JSPI. Separately, two cheap changes shrink today's `idb://` footprint: smaller WAL settings and a smaller `shared_buffers` and initial wasm memory (section 4).

## 1. Does `opfs-ahp://` keep the data directory in memory?

### 1.1 What the code does

- **`idb://` is MEMFS plus a copy.** `IdbFs` mounts Emscripten's `IDBFS` at `/pglite/<dataDir>` and symlinks `PGDATA` to it (`src/fs/idbfs.ts`). `initialSyncFs` calls `FS.syncfs(true)`, which loads every file into MEMFS, and every query ends with `syncToFs`, which calls `FS.syncfs(false)` and writes changed files back. MEMFS keeps each file in a JS `Uint8Array` (`node.contents` in the Emscripten glue), so the whole data directory lives in the worker's JS heap. PGlite's docs say the same: IdbFs "loads all files for the database into memory on start" ([PGlite filesystems](https://pglite.dev/docs/filesystems)). Our `EncryptedFs` extends `MemoryFS` and keeps the plaintext data directory in MEMFS as well (`src/encryptedFs.ts`, line 1 and `class EncryptedFs extends MemoryFS`).
- **`opfs-ahp://` is a custom filesystem over sync access handles.** `OpfsAhpFS extends BaseFilesystem` (`src/fs/opfs-ahp.ts`). `BaseFilesystem.init` mounts it at `PGDATA` through `createEmscriptenFS`, whose `stream_ops.read` calls `baseFS.read(...)` synchronously (`src/fs/base.ts`). `OpfsAhpFS.read` resolves the path in its in-memory tree and returns `sh.read(new Uint8Array(buffer.buffer, offset, length), { at: position })`. It reads straight into the wasm heap, with no cache of its own; `write` likewise calls `sh.write` at the position. What it keeps in memory is the directory tree (`state.txt`, a JSON base state plus a JSON-lines log of operations, checkpointed every minute) and one open `FileSystemSyncAccessHandle` per file.
- **Handle count.** `#init` opens a sync access handle for every file in the tree and for every file in the spare pool. A new data directory gets a pool of `initialPoolSize = 1000` files; later opens keep `maintainedPoolSize = 100` spare. A fresh database therefore holds over 1,000 handles, and a reopened one holds the number of files plus 100.
- **Both keep the wasm memory.** `pglite.ts` creates `new WebAssembly.Memory({ initial: 2048, maximum: 32768 })` pages: 128 MB at the start, with a 2 GB ceiling. Postgres's `shared_buffers` (128 MB, measured with `current_setting`) and everything else live inside it. The runtime bundle `pglite.data` (6,248,214 bytes: `share/`, timezone data) is unpacked into MEMFS for either filesystem.
- **Works only in a dedicated worker.** `createSyncAccessHandle` is "only available in Dedicated Web Workers" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)), and PGlite's docs say `opfs-ahp` "is only available when PGlite is run in a Web Worker".

### 1.2 Measurement

**Method.** The script runs headless Playwright 1.65.0 with a persistent profile and serves the page cross-origin isolated (COOP/COEP from `bench/vite.config.ts`). PGlite runs in a dedicated worker. The database is one table `t(id int primary key, payload text)` of 100,000 rows. Each row holds 960 distinct hex characters, which is under the TOAST threshold, so the rows are stored uncompressed. `pg_database_size` is 112,287,867 bytes. The data directory, as the sum of file sizes under `/pglite/data`, is 245,235,907 bytes. The build ran on the same filesystem, then the worker was terminated. For each filesystem:

- the baseline is taken 3 s after that, with a blank page and no worker;
- a new worker opens the database and runs `select 1`;
- after 3 s the worker records the wasm memory (`HEAPU8.byteLength`) and the bytes MEMFS holds (the sum of `node.contents.byteLength` over the whole Emscripten tree), and the runner records the RSS of the browser's processes minus the baseline;
- the same is recorded after a point query by primary key and after a full scan (`count(*)`, `sum(length(payload))`).

`performance.memory` does not exist in a worker, so there is no JS heap figure (the column is null in the JSON). The MEMFS figure is exact, and the RSS includes every allocation.

| Engine, host | FS | Open (ms) | wasm memory | MEMFS bytes | RSS over baseline after open | after full scan | Point query (ms) | Full scan (ms) |
|---|---|---|---|---|---|---|---|---|
| Chromium 158, Linux (mini PC) | `idb://` | 1,020 | 198 MB | 251.5 MB | 523 MB | 523 MB | 36 | 968 |
| Chromium 158, Linux (mini PC) | `opfs-ahp://` | 430 | 198 MB | 6.2 MB | **305 MB** | 306 MB | 2 | 578 |
| Firefox 159, Linux (mini PC) | `idb://` | 1,764 | 198 MB | 251.5 MB | 610 MB | 622 MB | 47 | 1,455 |
| Firefox 159, Linux (mini PC) | `opfs-ahp://` | 1,001 | 198 MB | 6.2 MB | **365 MB** | 284 MB | 10 | 3,826 |
| Chromium 158, macOS 27 (MacBook Pro) | `idb://` | 422 | 198 MB | 251.5 MB | 571 MB | 572 MB | 21 | 624 |
| Chromium 158, macOS 27 (MacBook Pro) | `opfs-ahp://` | 236 | 198 MB | 6.2 MB | **319 MB** | 320 MB | 1 | 432 |
| WebKit (Playwright, Safari 27.2), macOS 27 | `idb://` | 949 | 198 MB | 251.5 MB | 319 MB | 303 MB | 199 | 1,075 |
| WebKit (Playwright, Safari 27.2), macOS 27 | `opfs-ahp://` | never opened: `PGlite.create` hung (section 1.3) | | | | | | |

(MB = 2^20 bytes. Each row is one run, so the numbers are indicative, not medians. The point query is the first query after the open, so on `idb://` it includes the first `syncToFs`.)

**Reading it.**

- **The data directory leaves memory.** On `opfs-ahp://` MEMFS holds only the 6.2 MB runtime bundle; on `idb://` it holds that plus the 245 MB data directory. RSS falls by 218 MB (Chromium, Linux), 252 MB (Chromium, macOS) and 245 MB (Firefox), close to the data directory's size. A full scan does not bring it back: Postgres reads a large table through a small ring of buffers, and `opfs-ahp` keeps no cache.
- **What stays is the floor:** the 198 MB of wasm memory (128 MB of it is the initial allocation, which holds `shared_buffers`) plus the engine's per-worker cost: 305 to 365 MB of RSS in all on desktop.
- **The data directory is 2.2 times the database.** The other ~133 MB is the two template databases, `global`, and mostly `pg_wal` **[unverified: breakdown not measured]**. On `idb://` all of it sits in memory, so on a phone "a 100 MB database" can cost 250 MB of MEMFS before the wasm memory.
- **Speed.** The `opfs-ahp` open is faster, because it reads no file contents. Its full scan is faster in Chromium (one 8 KB `read` took 0.001 to 0.003 ms, section 3.2) and 2.6 times slower in Firefox (0.04 ms).
- **Ephemeral profiles.** A first run in Playwright's default ephemeral context was discarded. Chromium took 57 s to build and 13.6 s to scan on `opfs-ahp` there. That suggests it keeps an ephemeral profile's OPFS in memory **[unverified cause]**. WebKit refused OPFS outright in that context (`UnknownError: The operation failed for an unknown transient reason`). That fits WebKit's statement that OPFS is "unavailable for Safari windows in Private Browsing mode" ([WebKit blog](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/)). Journal's shells use a persistent store, so this does not affect them **[unverified for WKWebView's default data store]**.

### 1.3 WebKit (Mac)

- **The limit, measured.** In a fresh worker the probe opened 251 sync access handles. The 252nd threw `UnknownError: Invalid platform file handle` (`webkit-darwin.json`, `handles`). PGlite's docs give 252.
- **`PGlite.create` hangs; it does not throw.** A new `opfs-ahp` data directory asks for `initialPoolSize = 1000` pool handles. `maintainPool` creates each one inside `new Promise<void>(async (resolve) => { … createSyncAccessHandle() … resolve() })`. When `createSyncAccessHandle` throws, the async executor's own promise rejects, nobody observes that, and the promise `Promise.all` waits on never settles (`src/fs/opfs-ahp.ts`, `maintainPool`). The build step sat for the full 15 minutes at 0 % CPU. A smaller `initialPoolSize` does not save it: a Postgres data directory alone has "over 300 files" (PGlite docs), and `#init` opens one handle per file.
- **So there is no WebKit `opfs-ahp` row to measure.** The MEMFS figure does not depend on the engine (251.5 MB on `idb://` in all four runs), so the expected WebKit win is the same data directory, about 245 MB **[inference, not measured in WebKit]**.
- **WebKit's RSS numbers are low.** WebKit's `idb://` RSS over baseline (319 MB) is 252 MB below Chromium's on the same Mac (571 MB), with the same wasm and MEMFS sizes. Two explanations are possible: macOS compression hides idle pages from RSS, or the runner misses one of WebKit's XPC processes **[unverified]**. Read the WebKit RSS column as a lower bound. On iOS what counts is the jetsam footprint, which this run does not measure.

## 2. Which engines support it

| Engine | OPFS `createSyncAccessHandle` | `opfs-ahp` measured here | JSPI | `SharedArrayBuffer` (needs cross-origin isolation) |
|---|---|---|---|---|
| Chromium / Chrome desktop | 102 ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/FileSystemFileHandle.json)) | works (Chromium 158, Linux and macOS) | 137 ([BCD](https://github.com/mdn/browser-compat-data/blob/main/webassembly/jspi.json)); detected in 158 | yes, isolated in the run |
| Firefox | 111 (BCD) | works (Firefox 159, Linux) | 153 (BCD); detected in 159 | yes, isolated in the run |
| Safari / WebKit macOS | 15.2 (BCD; [WebKit blog](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/)) | **does not open**: 251-handle limit (measured), PGlite hangs (section 1.3) | 27 (BCD; [caniuse](https://caniuse.com/wf-wasm-jspi)); detected in Playwright's WebKit (Safari 27.2) | yes, isolated in the run |
| iOS Safari | 15.2 (BCD mirror) | not measured (needs the device) | 27 (BCD, caniuse lists iOS 27.0) | 15.2+ when isolated **[unverified]** |
| WKWebView (iOS, macOS) | 15.2 by BCD mirror **[unverified]**; WebKit's API tests enable OPFS in WKWebView through a private preference (`_storageAPIEnabled`), so the default for an app may differ **[unverified]** | not measured | 27 by BCD mirror **[unverified]** | needs COOP/COEP on the shell's responses **[unverified for Tauri]** |
| Android WebView | 109 by BCD mirror of Chrome Android **[unverified]** | not measured | 137 by mirror **[unverified]** | as Chrome Android **[unverified]** |

Notes:

- **The Safari handle limit.** PGlite's docs say "Safari appears to have a limit of 252 open sync access handles", which "prevents this VFS from working", since a standard Postgres install has "over 300 files" ([PGlite filesystems](https://pglite.dev/docs/filesystems)). `opfs-ahp` opens one handle per file plus a pool of 1,000 on a new data directory (section 1.1), so the limit matters to it. Measured: Chromium and Firefox opened 1,100 handles, and WebKit opened 251 (section 1.3).
- **The concurrency modes do not help.** The `mode` option of `createSyncAccessHandle` (`read-only`, `readwrite-unsafe`) is Chromium 121+ only; Firefox and Safari: `false` (BCD). A `readwrite` handle locks its file exclusively, so a second tab cannot open the same database.
- **The device in #42 runs iOS 18.7.** iOS 18 has OPFS sync access handles but no JSPI.

## 3. How encryption could sit under it with WebCrypto only

### 3.1 The constraint

Postgres's reads are synchronous all the way down. A wasm import (`fd_pread`, `fd_read`, … – 55 `fd_*`/`__syscall_*` imports in `pglite.wasm`) calls the Emscripten FS in JS. That calls `stream_ops.read` (`src/fs/base.ts`), which calls `BaseFilesystem.read`, which must return a byte count. `crypto.subtle.decrypt` returns a promise. The 0.5.10 build has neither escape hatch: the glue contains no Asyncify runtime, and its `dynCall(…, promising = false)` ignores the flag. Its setjmp/longjmp goes through 56 `invoke_*` JS trampolines (`WebAssembly.Module.imports` of `pglite.wasm`), and Postgres's error handling uses that on almost every path.

### 3.2 Options

| # | Design | What it needs | Measured / known cost | Blocker |
|---|---|---|---|---|
| A | **Atomics bridge.** Our own `BaseFilesystem` (the shape of `OpfsAhpFS`); its `read` posts the page number to a crypto worker and blocks in `Atomics.wait`. The crypto worker reads the sealed page from its own OPFS sync access handle, opens it with `crypto.subtle` (AES-256-GCM), copies the plaintext into a `SharedArrayBuffer` and calls `Atomics.notify`. Writes are kept as dirty plaintext pages and sealed in `syncToFs`, which is async. A small decrypted-page cache sits in front. | No PGlite change. `SharedArrayBuffer`, so cross-origin isolation (COOP/COEP); PGlite in a dedicated worker (already required for OPFS) | Per 8 KB miss, mean round trip: 0.024 ms (Chromium, macOS), 0.066 ms (Chromium, Linux), 0.13 ms (WebKit), 0.36 ms (Firefox); table below | Cross-origin isolation in the Tauri shells, WKWebView above all, is **[unverified]**. Each cache miss pays a cross-worker hop. Dirty pages wait in memory until the sync (bounded by the transaction). The crash-safety protocol of `FORMAT.md` has to move from IndexedDB transactions to OPFS files (new format work) |
| B | **JSPI.** Wrap the `fd_*` imports in `WebAssembly.Suspending` and the entry exports in `WebAssembly.promising`. The FS calls `await crypto.subtle.decrypt` inline. | **A rebuilt PGlite**: Emscripten `-sJSPI` with `JSPI_IMPORTS`/`JSPI_EXPORTS` ([Emscripten](https://emscripten.org/docs/porting/asyncify.html)), an async FS glue, and setjmp/longjmp that does not go through JS. JSPI traps when JS frames sit between the `promising` export and the suspending import ([JSPI overview](https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md)), and the 56 `invoke_*` trampolines are JS frames. Wasm-native longjmp (`-sSUPPORT_LONGJMP=wasm`) is the likely route **[unverified]** | Code size unchanged (Emscripten docs). Per-suspension cost not measured | Engines: Chrome 137, Firefox 153, Safari / iOS 27 only (BCD), so not iOS 18. It means a PGlite fork or upstream work; no upstream plan found **[unverified: the GitHub issue search could not run]** |
| C | **Asyncify.** The same, with Emscripten's code transform instead of engine stack switching | The same rebuild, `-sASYNCIFY` with `ASYNCIFY_IMPORTS` | "something like 50% or so" in speed and code size, "much larger" wasm (Emscripten docs); the wasm is 10.5 MB today | Fork plus a permanent slowdown on every path that can reach a read, which is nearly all of Postgres. Its only gain over B is engine coverage (iOS < 27), and A covers that without the fork |
| D | **Decrypt-ahead cache alone.** Before each query, decrypt the pages it will need, asynchronously | Knowing those pages in advance | — | Not knowable: index lookups, catalogs, TOAST and visibility checks pick pages while the query runs. A miss inside the synchronous `read` has no way to wait. "Restart on miss" (fail the read with `EIO`, decrypt, run the statement again) makes Postgres raise an ERROR that aborts the transaction, which is unsafe for writes and multi-statement transactions. Useful only as the cache in front of A or B |
| E | **Synchronous cipher** (AES in JS or wasm) | — | — | Hand-written or third-party cryptography: forbidden by `CLAUDE.md` |
| F | **Native store.** A worker's synchronous XHR to a shell endpoint that seals in Rust | Tauri custom protocol **[unverified]** | — | The cryptography is not WebCrypto, and it serves only the native shells |
| G | **Plaintext OPFS** and OS file protection only | — | — | Fails threat A1 (a copy of the data folder or a backup, `docs/plan/00-overview.md` 2.1) |

**STOP check:** A is WebCrypto-only, so the condition "the only workable design needs non-WebCrypto cryptography" does not apply.

**The bridge measurement.** The crypto worker seals 1,024 random-IV AES-256-GCM pages of 8 KB in an OPFS file. The PG worker then makes 2,000 synchronous reads in a strided order and checks that each page carries its own number (0 mismatches in every run). The baseline is the same 2,000 reads of plaintext from a sync access handle in the PG worker, which is what `opfs-ahp` does today. "Crypto worker" is the read plus decrypt inside the crypto worker.

| Engine, host | Bridge round trip p50 / mean / p95 (ms) | Plain `sh.read` 8 KB mean (ms) | Crypto worker read + decrypt mean (ms) |
|---|---|---|---|
| Chromium 158, Linux | 0.055 / 0.066 / 0.095 | 0.003 | 0.028 |
| Firefox 159, Linux | 0.20 / 0.36 / 1.3 | 0.04 | 0.18 |
| Chromium 158, macOS 27 | 0.02 / 0.024 / 0.04 | 0.001 | 0.012 |
| WebKit (Safari 27.2), macOS 27 | 0.12 / 0.127 / 0.18 | 0.001 | 0.032 |

What that means for a query: a cold full scan of the 112 MB table reads about 13,700 pages. At the measured means that adds about 0.3 s (Chromium, macOS), 0.9 s (Chromium, Linux), 1.7 s (WebKit) and 5 s (Firefox) over plain `opfs-ahp` **[inference from the per-page means, not a measured scan]**. Postgres's own `shared_buffers` and a page cache in front of the bridge absorb repeated reads, and an open no longer reads the data directory at all. The 64 KB blocks of `FORMAT.md` would cut the hops for sequential reads by 8 and make random reads read more **[inference]**.

## 4. Recommendation

**Worth building, as design A (the Atomics bridge), after a one-day spike in the iOS shell.** Do not wait for JSPI. B would be the cleaner design, but it needs a PGlite rebuild and iOS 27. A needs neither, and its measured cost per page is a fraction of a millisecond on desktop.

**The expected memory win** is the data directory, measured at 218 to 252 MB of RSS for a 112 MB database (245 MB data directory) in desktop Chromium and Firefox. For WebKit, where `opfs-ahp` cannot open, it is the same 245 MB by inference. Today the data directory sits in MEMFS on `idb://` and in our `EncryptedFs`. With A it would sit in OPFS. What remains in memory is the wasm memory (198 MB), the 6 MB runtime bundle and a page cache of whatever size we choose. On desktop that is 305 to 365 MB of RSS in all.

**The spike must answer, on the iPhone 15 (iOS 18.7) inside the Journal shell:**

1. Is the shell cross-origin isolated, so that `SharedArrayBuffer` exists? Tauri on iOS serves the frontend itself **[unverified: whether COOP/COEP can be set on it]**.
2. Does `createSyncAccessHandle` work in WKWebView, and how many handles can be open? A needs only a few container files, but the limit decides the file layout.
3. Does a 100 MB database opened on demand survive where `idb://` crashed (#42)? PGlite's `opfs-ahp` cannot answer this on iOS (section 1.3). The spike needs a minimal plain on-demand filesystem over a few OPFS files, the bridge without the cipher. If the tab still dies at the floor, on-demand storage alone is not enough, and the wasm memory is the next ceiling.

**Cheap, independent of A** (each needs its own measurement before it is adopted):

- **Smaller WAL settings.** Lower `max_wal_size`/`min_wal_size` and checkpoint after bulk work. This may shrink the 245 MB data directory towards the 112 MB database, and on `idb://` and `EncryptedFs` that is memory **[unverified: the WAL share of the 245 MB was not measured]**.
- **Smaller wasm memory.** PGlite's `initialMemory` option and `shared_buffers` (128 MB) set most of the floor, and wasm memory never shrinks once grown.

The owner decides whether to build it (the issue's STOP condition).

## Sources

- PGlite 0.5.10 sources, from `node_modules/@electric-sql/pglite/dist/*.js.map`: `src/fs/opfs-ahp.ts`, `src/fs/base.ts`, `src/fs/idbfs.ts`, `src/fs/index.ts`, `src/pglite.ts`; `dist/pglite.wasm` imports; `release/pglite.js` (Emscripten glue).
- [PGlite docs: filesystems](https://pglite.dev/docs/filesystems)
- [MDN: `createSyncAccessHandle()`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle); [MDN browser-compat-data: `FileSystemFileHandle.json`](https://github.com/mdn/browser-compat-data/blob/main/api/FileSystemFileHandle.json), [`webassembly/jspi.json`](https://github.com/mdn/browser-compat-data/blob/main/webassembly/jspi.json)
- [caniuse: JSPI](https://caniuse.com/wf-wasm-jspi)
- [JSPI proposal overview](https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md)
- [Emscripten: Asyncify and JSPI](https://emscripten.org/docs/porting/asyncify.html)
- [WebKit blog: the File System API with OPFS](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/); [WebKit: Announcing Interop 2026](https://webkit.org/blog/17818/announcing-interop-2026) (JSPI is an Interop 2026 focus area)
- WebKit's WKWebView OPFS API test, `Tools/TestWebKitAPI/Tests/WebKitCocoa/FileSystemAccess.mm` (search result, not read) **[unverified]**
- Measurements: `bench/opfs-memory.mjs`, `bench/results/opfs-memory/*.json`; issue #42 for the iPhone crash
