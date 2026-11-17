# Benchmark

A browser benchmark for `pglite-cipher`. It builds the same database on plain PGlite `idb://`
(`IdbFs`) and on `EncryptedFs` over `IndexedDbBackend` (64 KB blocks), runs the same workload on
both, and judges the result against a set of gates, G1 to G9, below. It also measures the key
operations (`changeKey`, `verify()`, `rotateDataKey`), AES-GCM throughput and the cost of a year of
use. The measurements are in `bench/measure.ts`; the same code runs at 10 MB as ratios in
`test/perf/gates.browser.test.ts` on every pull request.

It runs in a browser page, because it needs IndexedDB and a DOM. Node only drives the browsers.

## Build, serve and run

```sh
npm ci
npm run bench:build   # writes bench/dist/ (static; base './')
npm run bench:serve   # http://127.0.0.1:47900, with COOP/COEP headers (cross-origin isolated)
```

**In a page.** Open the URL, tick the parts, press **Run**, then **Copy results** (one JSON object,
also printed in the page). The `?auto=1&parts=gates10,extras&runs=20` form starts without clicking.
The page sets `window.__benchResult` when it finishes (`window.__benchError` if it failed).

**Headless.** `bench/run.mjs` runs each part in a fresh page in Playwright's browsers and merges
the results into `bench/results/<browser>.json`:

```sh
npx playwright install chromium firefox webkit
node bench/run.mjs chromium firefox --parts gates10,extras --runs 20
node bench/gates.ts --factor 1 --require gates10,extras bench/results/chromium.json
```

`run.mjs` builds `bench/dist` first if it is missing, so rebuild after changing the code. Without a
browser name it runs Chromium, Firefox and WebKit. Options:

| Option | Effect |
| --- | --- |
| `--parts a,b` | the parts to run (default `gates10,gates100,extras,year`) |
| `--runs N` | runs per measurement (default 20) |
| `--throttle N` | Chromium only: slows the page's CPU N times through CDP; saves to `<browser>-throttle<N>.json` |
| `--block N` | builds the encrypted store with N-byte blocks (8192, 32768 or 65536); saves to `<browser>-block<N>.json` |
| `--pack N` | N blocks per IndexedDB record (1, 4, 8 or 16); needs `patches/pack.patch`; saves to `<browser>-pack<N>.json` |

The same settings are page parameters: `&runs=`, `&block=`, `&pack=`, `&sessions=` (the year part),
`&levers=` (some of the levers), `&opfsmb=` (the OPFS size).

### Parts

| Part | What | Time (desktop Chromium) |
| --- | --- | --- |
| `gates10`, `gates100` | G1, G1b, G2, G3, G4, G9 at 10 MB or 100 MB, plain and encrypted; `changeKey`, `verify()`, `rotateDataKey` and the open after the rotation | a few minutes; the 100 MB part is long, run it alone |
| `enc10`, `enc100` | the gates part without the plain build and opens; the ratio gates read "no plain baseline" | about half of the gates part |
| `levers10`, `levers100` | the gates pair, once per Postgres setting that cuts memory: default, small WAL, `shared_buffers` 32 and 16 MB, both. Adds the data directory per subdirectory before and after the build's `CHECKPOINT` and after the last open, and the wasm memory | about 3 min at 10 MB |
| `extras` | G6 support, G8 `deriveKey` (median of 1,000), AES-GCM over 100 MB at 8, 32 and 64 KB, crypto overhead (one record and 100 sealed and opened, 8 and 64 KB) | under a minute |
| `year` | G8: 365 open/edit/checkpoint/close sessions, then the number of session salts an open derives | several minutes |
| `ops` | startup (fresh init, reopen) and operations (inserts, bulk insert, large text, selects, aggregate, a CRUD cycle), plain and encrypted | a few minutes |
| `opfsread` | OPFS alone: 300 MB of 65,580 B records (the size of a sealed 64 KB block) read back as one file per record, as 255-record segment files in 1 MiB slices, and as the same segments through a `FileSystemSyncAccessHandle` in a worker; MB/s and ms, and `unavailable: <reason>` for a layout the browser lacks | about 2 min at `--runs 3` |

## The gates

Each gate compares the encrypted store with plain `idb://` in the same run, or with an absolute
budget. The budgets are for a desktop browser; `bench/judge.ts` holds them, and `node bench/gates.ts
--factor F` multiplies the absolute ones by F (the ratios are never relaxed). All times are the p50
over `--runs` runs (the JSON also has p95 and max). A gate that cannot be measured in a browser
reads "not measurable" and is not a failure.

| Gate | What it measures | Limit | Limits of the measure |
| --- | --- | --- | --- |
| G1 sync | the sync after a one-row `UPDATE`, in a database of 10 or 100 MB | encrypted p50 <= 2x plain | the plain sync rewrites whole files, so the encrypted one is usually far under 1x |
| G1b sync | the sync after one 4 KB insert | ratio <= 2 and at most 1 table block written | not in the judge; read it from the JSON (`g1b`, `ratios`) |
| G2 open | time from the start of the sync from IndexedDB to Postgres ready; plain and encrypted opens interleaved, each after an untimed open of the same variant | ratio <= 2; at 100 MB also <= 1,500 ms | it is the one cost that scales with the database: every record is read and decrypted before Postgres starts. Phones are slower than the budget |
| G3 memory | memory after the open | database + 64 MB | needs `measureUserAgentSpecificMemory` (headed, cross-origin isolated Chromium). Headless, the page has only `performance.memory` plus the wasm heap, which includes the browser's baseline, so it is "not measurable" |
| G4 segment switch | the sync when Postgres starts a new 16 MB WAL segment | <= 500 ms and <= 10x a normal plain sync | one workload, one segment size |
| G5 unit size | G1, G2 and G4 at 8, 32 and 64 KB blocks | the smallest size that passes G2 | run once per size with `--block`; `src/` has one default, 64 KB |
| G6 support | AES-GCM, HKDF `deriveKey` to AES-GCM, `unwrapKey` into an HKDF key, IndexedDB `durability: "strict"` and `"relaxed"`, number and string keys in one store (numbers first), key-range `getAll` over string keys | all present | `extras.g6`; it reports the engine it runs in, not every webview |
| G7 Rust store throughput | a native store behind the same interface | recorded only | not in this page (it needs a native shell) |
| G8 subkeys | session salts alive after 365 sessions of edits and checkpoints, times the `deriveKey` p50 | <= 10 % of the open budget (150 ms) | the product of two numbers; in engines with coarse timers the `deriveKey` p50 can read 0.06 ms |
| G9 file table | the open's file-table phase (`g2.tableMs`: root, table blocks fetched, decrypted, assembled); and the table blocks a sync writes | open phase <= 5 % of the open budget (75 ms at 100 MB; 5 % of the measured open at 10 MB). The G1 sync writes no table block, no sync that changed no file writes one, and a changed file costs at most 1 | the table blocks are counted by the store's `stats()`, not read from IndexedDB |

Not every row means the same thing in every browser: Playwright's WebKit is not Safari, and
headless Chromium and Firefox on a shared machine vary from run to run. Compare plain against
encrypted inside one engine and one run, not across engines or machines.

## Reading the JSON

`run.mjs` writes `{ browser, userAgent, parts: { <part>: { ..., measuredAt, runs } } }`. The page's
**Copy results** has the same parts directly on the top level, beside `userAgent`, `runs`,
`crossOriginIsolated`, `hardwareConcurrency` and `deviceMemory`; `gates.ts` reads the `run.mjs`
form.

A gates part (`gates10`, `gates100`) holds `sizeMB`, `blockSize`, `pack`, then `plain` and
`encrypted`, `ratios` and `gates`. A statistic is `{ p50, p95, max, n }`, in ms unless it says
otherwise.

- `plain`, `encrypted` (same shape, the encrypted one has more): `buildMs`, `dataDir`,
  `g1`, `g1b`, `g4` (sync times), `g2` (open times), `g3` (memory and its `source`).
- `encrypted` only: `g1.lastSync` (the `stats().lastSync` breakdown per run: blocks, bytes, deletes,
  encrypt and commit ms), `g1.fileChanges` and `g1.tableBlocksWithoutFileChange` (G9), `g2.tableMs`,
  `g2.blocksMs`, `g2.readMs` and `g2.decryptMs` (the open's wall time with an IndexedDB page read
  in flight and with a decrypt in flight), `g9` (table blocks per sync over the whole workload),
  `store` (IndexedDB records and blocks after the build), `readsOnly` (the records read as the open
  reads them, nothing decrypted: beside `g2.readMs` it shows what the decrypts add) and `keys`
  (`changeKeyMs`, `verifyMs`, `rotateDataKeyMs`, `openAfterRotation`).
- `ratios`: encrypted over plain for G1, G2, G4 and G9's open share.
- `gates`: the judged rows, `{ gate, value, limit, pass }`; `pass` is `true`, `false` or
  `"not measurable"`.

`extras` has `g6`, `g8DeriveKeyMs`, `aesGcm` and `cryptoOverhead`. `year` has `liveSalts`,
`records`, `deriveKeyP50Ms`, `totalMs` and its `gates`. A part that failed holds `{ error }`; `run.mjs`
then exits 1, and so does `gates.ts`.

`node bench/gates.ts --factor 1 --require gates100,extras,year bench/results/chromium.json` prints
the gate tables as Markdown and exits 1 if a gate fails, a part errored, or a required part is
missing.

## Reference results

- `results/2026-11-17/`: the latest full run, Chromium, Firefox (Linux desktop) and Playwright's
  WebKit (macOS), parts `gates10,extras,gates100,year`, 20 runs. `SUMMARY.md` has the environment,
  the gate table for every engine and what was not measured; `chromium.json`, `firefox.json` and
  `webkit.json` are the raw results.
- `results/2026-11-16-redmi-76/`: Chrome 157 on an Android phone (Redmi Note 5 Pro), `gates100`
  with 5 runs: `base.json` (stock layout), `pack4.json` and `pack8.json` (`patches/pack.patch`),
  `workers2.json` and `workers4.json` (`patches/workers.patch`), and `opfsread.json`. The encrypted
  100 MB open took 8.6 s against 2.5 s plain in the base run; see
  [the known limit](../docs/design/performance.md#known-limit-slow-encrypted-open-on-android-chrome).
- `results/2026-11-13/memory-levers.md`: what the Postgres settings of the `levers` parts save in
  memory, in Chromium and Firefox.

`bench/results/<browser>.json`, which `run.mjs` writes without `--block`, `--pack` or `--throttle`
suffixes, is where a new run goes; the nightly workflow (`.github/workflows/nightly.yml`) runs
`gates100,extras,year` in the three engines this way and checks them with `gates.ts`.

## Patches

Two experiments are kept as patches and are not part of `src/`. Apply one with `git apply` from the
repository root and rebuild `bench/dist`. They change the same file in `src/backend/indexeddb.ts`,
so apply one at a time.

- `patches/pack.patch` stores up to N sealed blocks per IndexedDB record, without padding: a
  record holds blocks whose ids are consecutive in key order, under the smallest id, so it may mix
  files. `EncryptedFs` and the format are unchanged. `&pack=N` or `--pack N` sets N for the
  `gates` and `enc` parts, and fails them without the patch; 1 is the unpatched layout. With the
  patch, `VITE_CIPHER_PACK=N npm test` runs the test suites at N. The encrypted variant's `store`
  reports records and blocks: blocks divided by records is the fill.
- `patches/workers.patch` splits the open's blocks phase into W key ranges on the first hex digit
  of the ids, each read with `readRange` and decrypted in its own dedicated worker with the data
  key posted by structured clone. WebKit cannot clone a `CryptoKey` to a worker, so there the open
  falls back to the single-thread loader of `src/` and measures nothing new. `&workers=2` or `4`
  picks W; with W > 1, `g2.readMs` and `decryptMs` are the slowest range's. Run it without
  `--throttle`: Chromium's CDP does not throttle workers, so a throttled run would flatter W > 1.

## Other browsers and devices

The page needs a secure context and, for G3 and the wasm memory figures, cross-origin isolation, so
serve `bench/dist` over HTTPS or from `localhost` with the headers of `vite.config.ts`
(`npm run bench:serve` does). For a phone, forward the port, for example `adb reverse tcp:47900
tcp:47900` for Chrome on Android, open `http://localhost:47900/`, tick the parts and copy the
result. To run it inside an app webview (WKWebView, WebView2, Android WebView), serve the built
`bench/dist` as that app's frontend from a `localhost` origin.

On a phone, run `gates10` first. When the 100 MB plain build runs the tab out of memory, run
`enc100` alone for the encrypted numbers: the page returns the whole result only at the end, so
a part that crashes the tab loses everything of that run.
