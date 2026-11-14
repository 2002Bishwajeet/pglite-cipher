# Benchmark page: run sheet

The page builds a database with plain `idb://` (`IdbFs`) and with the real implementation
(`EncryptedFs` over `IndexedDbBackend.pair`, 64 KB blocks) and measures the gates of
`docs/plan/01-sqlcipher-comparison.md` 3.3, the key operations, and rows ported from
davidmuggleton/pglite-encrypted-fs's bench (`THIRD_PARTY.md`). `bench/measure.ts` holds the
measurements, which `test/perf/gates.browser.test.ts` also runs on every PR at 10 MB, as ratios.
The prototype's results are in `SPIKE-RESULTS.md`.

## Build and serve

```sh
npm run bench:build   # writes bench/dist/ (static; base './')
npm run bench:serve   # http://127.0.0.1:47900, with COOP/COEP headers
```

Open the page, tick the parts, press **Run**, then **Copy results** (one JSON object; it is also
printed in the `<pre>`). Parts:

| Part | What | Time (desktop Chromium) |
| --- | --- | --- |
| gates, 10 MB | G1, G1b, G2, G3, G4, G9; `changeKey`, `verify()`, `rotateDataKey` and the open after the rotation | a few minutes |
| gates, 100 MB | the same at 100 MB | long; run it alone |
| encrypted only, 10/100 MB (`enc10`, `enc100`) | the gates part without the plain build and opens; the ratio gates read "no plain baseline" | as the gates part, about half |
| memory levers, 10/100 MB (`levers10`, `levers100`) | the gates pair (without the key operations) once per Postgres setting of #48: default, small WAL, `shared_buffers` 32 and 16 MB, both; `&levers=wal,sb16` picks some. Adds the data directory per subdirectory before and after the build's `CHECKPOINT` and after the last open, and the wasm memory | about 3 min at 10 MB in Chromium |
| extras | G6 support, G8 `deriveKey` (median of 1,000), AES-GCM 100 MB at 8/32/64 KB, crypto overhead (one record and 100 sealed and opened, 8 and 64 KB) | under a minute |
| year | G8: 365 open/edit/checkpoint/close sessions, then the number of session salts an open derives | several minutes |
| ops | startup (fresh init, reopen) and operations (inserts, bulk insert, large text, selects, aggregate, a CRUD cycle), plain and encrypted | a few minutes |
| G7 | Rust store throughput; only inside a Tauri shell built with `encfs-bench` | about a minute |
| idbread (spike #58) | IndexedDB alone: 100 MB of random records (32 KiB to 1 MiB) read back with `getAll` pages of 64, 512, 2048 and all, 2 and 4 parallel streams, a page split into 2 and 4 parallel parts, and a cursor; MB/s per cell, median of `runs`. `&idbmb=` sets the size | about 3 min desktop, 6 min on the Redmi |

What each gates part reports, per variant (`plain`, `encrypted`):

- `g1`, `g1b`, `g4`: sync time per run (p50, p95, max); encrypted also the `stats().lastSync`
  breakdown summed per run (table and data blocks, bytes, deletes, encrypt and commit ms, repacks),
  and `fileChanges` / `tableBlocksWithoutFileChange` (G9: runs that changed no file must write no
  table block, the owner's rule on #2).
- `g2`: the open from `initialSyncFs` to Postgres ready, plain and encrypted opens interleaved,
  each timed open after an untimed open of the same variant, never right after the other's (#41: on
  the iPad a plain open just before an encrypted one made that open 8× slower); encrypted also `lastOpen.tableMs` (G9) and `lastOpen.blocksMs`, `readMs` and `decryptMs` (the
  open's wall time with an IndexedDB page read in flight and with a decrypt in flight), the table
  blocks and `table.fill`, data blocks, files and subkeys.
- `g9` (encrypted): over every sync of the workload, p50/p95 of `lastSync.tableBlocks` and of
  `tableBlocks / dataBlocks`, and how many syncs repacked the table.
- `keys` (encrypted): `changeKeyMs`, `verifyMs`, `rotateDataKeyMs`, and `openAfterRotation` (the
  same data, its table now densely packed) beside `g2`. `openBeforeRotation` is the same series on
  the store as G2 opened it, without a plain open in between, as after the rotation: its `readMs`
  against `openAfterRotation.readMs` is what the rewrite alone changes (#41).
- `ratios` and `gates`: the gate table, judged with the desktop budgets of #3 (`bench/judge.ts`).

`importPlainDataDir` has no row: the package does not have it yet.

URL parameters run it without clicking: `?auto=1&parts=gates10,extras&runs=20` (and `&sessions=365`
for the year). The page sets `window.__benchResult` when it finishes; `node bench/run.mjs` uses that
to run the page headless in Playwright's browsers and save `bench/results/<browser>.json`.
`--throttle 4` slows Chromium's CPU 4x through CDP and saves `bench/results/chromium-throttle4.json`.
`&post=<target>` also sends the progress and the result to the device collector
(`bench/device/serve.mjs`, issue #11), which saves `bench/results/<target>.json`.

## Nightly gates

`.github/workflows/nightly.yml` runs `gates100`, `extras` and `year` in Chromium, Firefox and WebKit
and checks them with `node bench/gates.ts --factor <CI factor>`: the ratios against plain `idb://`
as they are, the absolute budgets (open 100 MB in 1,500 ms, a segment switch in 500 ms, G8 and G9
from them) times the CI factor the workflow states. The gate table goes to the job summary and the
JSON is an artifact.

## Inside the Tauri shells (G7, WKWebView, WebView2, Android WebView, iOS)

You need a Journal checkout with `src-tauri` (branch `feat/97-tauri-shell`, or `main` once it has
landed) and the bench endpoints of 2002Bishwajeet/journal plan file `journal/02` (cargo feature
`encfs-bench`). The page must be the shell's frontend, so that it is served from the app's own
`http://localhost:47821`: a secure context on every platform, which a LAN dev URL on a phone is not.

1. In this repository: `npm ci && npm run bench:build`.
2. In the Journal checkout, desktop (macOS WKWebView, Windows WebView2, Linux WebKitGTK):

   ```sh
   npx tauri build --features encfs-bench --config '{"build":{"frontendDist":"<path to pglite-cipher>/bench/dist","beforeBuildCommand":""}}'
   ```

3. iOS and Android, the same configuration:

   ```sh
   npx tauri ios build --features encfs-bench --config '{"build":{"frontendDist":"<path to pglite-cipher>/bench/dist","beforeBuildCommand":""}}'
   npx tauri android build --features encfs-bench --config '{"build":{"frontendDist":"<path to pglite-cipher>/bench/dist","beforeBuildCommand":""}}'
   ```

4. Launch the app, tick every part (100 MB alone if the device is slow), **Run**, **Copy results**.
   Never ship a build with `encfs-bench`.

G7 assumes `bench_blob_get(index, len)` reads `len` bytes at offset `index * len`, and that
`bench_token()` returns the token for the `X-Journal-Bench` header. If the shell lacks the commands,
the G7 part reports `available: false` and the reason; that is itself a result (journal/02's STOP).
`ipc.oneMbPutGetMs` times a 1 MB put and get through the commands: Tauri's `fetch`-based IPC takes a
few milliseconds, the `postMessage` fallback an order of magnitude more (`ipcGuess` uses 50 ms).

## Device runs

`bench/device/serve.mjs` serves `bench/dist` and collects results into `bench/results/<target>.json`
(`--self-test` checks it). With `&post=<target>` the page posts each part's result as soon as that
part finishes, and the whole result at the end, so a later part that crashes the tab (iPhone, 100 MB)
loses nothing already measured. When the plain 100 MB build crashes a phone first, run `enc100` (or
`enc10`) alone to get the encrypted numbers. The Redmi is attached to the Mac:

```sh
scripts/harness/remote.sh mac bash bench/device/redmi.sh gates10,enc100 1
```

`redmi.sh` rebuilds `bench/dist` on the Mac first (remote.sh does not sync `dist`), then takes `adb`
from `$ADB`, else `~/.local/bin/adb`, else `PATH`; exit 5 means no device.

## Where the results go

Paste each JSON object as a comment on issue #3 (the owner gate), one comment per device, with the
device name and OS version in the first line.
