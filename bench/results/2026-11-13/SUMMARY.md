# Benchmark results, 2026-11-13 (final, on `main` at `ae2b2f6`)

Run as `bench/README.md` documents: the benchmark page (`bench/`) built with `npm run bench:build` and driven headless by `node bench/run.mjs <browser> --parts ...`, 20 runs per measure, p50 / p95. Parts: `gates10`, `gates100`, `extras`, `year`, `ops`. Raw JSON beside this file: `chromium.json`, `firefox.json`, `webkit.json`. This replaces the earlier 2026-11-13 run (commit `95fb8b8`, on `78e5851`) in the same directory. The code under test changed since then (#10: the next page is read while one decrypts; #36: `changeKey`).

**What was measured.** The page benchmarks the shipped `src/` (`EncryptedFs` over `IndexedDbBackend.pair`, 64 KB blocks, the format default) against plain `idb://` (`IdbFs`) on the same data: 10 MB and 100 MB blob payloads, 67.8 MB and 266.6 MB data directories, about 1,020 files. Gates are judged by `bench/judge.ts` (`node bench/gates.ts --factor 1`, absolute budgets not relaxed).

**Node.** The page needs IndexedDB and a DOM, so it cannot run in Node. Node (v26.13.0) is only the host that drives Playwright and Vite; no Node benchmark row exists. Node behaviour is covered by the test suite, not by this benchmark.

## Environment

| | Chromium, Firefox | WebKit |
| --- | --- | --- |
| Machine | ROG G14, shared with other harness sessions (heavy lock held for each run) | MacBook Pro, through `scripts/harness/webkit.sh` (the Mac path) |
| CPU | AMD Ryzen 5 4600HS, 12 threads | Apple M1 Pro |
| RAM | 15 GiB | 16 GiB |
| OS | CachyOS Linux, kernel 7.3.0-4-cachyos | macOS 27.0.1 |
| Browser | Chromium 158.0.8127.18 (headless), Firefox 159.0 (Playwright build, headless) | Playwright WebKit, `Version/27.2 Safari/605.1.15`, headless. Not Safari, not WKWebView |
| Playwright | 1.65.0 | 1.65.0 |
| PGlite | 0.5.10 | 0.5.10 |

WebKit ran on different, faster hardware. Compare plain against encrypted within one engine, never absolute times across engines. Chromium and Firefox ran on a machine other sessions share, so absolute timings are noisy. `/tmp` on this host is a 7.6 GB tmpfs, which is where the browsers' profiles live (see `ops` below).

## Gate table G1 to G9

Target = `docs/plan/01-sqlcipher-comparison.md` 3.3 with the desktop budgets of #3. "Ratio" is encrypted p50 divided by plain p50 in the same run.

| Gate | Target | Chromium | Firefox | WebKit |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE, 10 MB | ratio <= 2 | 0.05 (4.36 vs 79.8 ms): pass | 0.04 (6.26 vs 146 ms): pass | 0.05 (6.38 vs 133 ms): pass |
| G1 sync, one-row UPDATE, 100 MB | ratio <= 2 | 0.06 (4.85 vs 82.3 ms): pass | 0.05 (7.00 vs 144 ms): pass | 0.03 (5.40 vs 206 ms): pass |
| G1b sync, one 4 KB insert, 10 MB | ratio <= 2; <= 1 table block | 0.05 (5.73 vs 110 ms); table blocks p50 1, max 1: pass | 0.04 (7.70 vs 185 ms); 1 / 1: pass | 0.04 (5.78 vs 135 ms); 1 / 1: pass |
| G1b sync, one 4 KB insert, 100 MB | ratio <= 2; <= 1 table block | 0.01 (7.06 vs 595 ms); table blocks p50 1, max 2: pass on p50 | 0.01 (10.4 vs 724 ms); 1 / 2: pass on p50 | 0.01 (5.78 vs 479 ms); 1 / 2: pass on p50 |
| G2 open, 10 MB | ratio <= 2 | 1.07 (460 vs 431 ms): pass | 1.10 (676 vs 615 ms): pass | 0.65 (233 vs 357 ms): pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.34 (860 ms): pass | 0.96 (1,269 ms): pass | 0.92 (696 ms): pass |
| G3 memory after the open | database + 64 MB | not measurable: 632 MB (10 MB db), 1,000 MB (100 MB db), the whole renderer heap including baseline; plain idb 479 / 1,183 MB | not measurable (no memory API) | not measurable (no memory API) |
| G4 segment switch, 10 MB | <= 500 ms; <= 10x a normal plain sync | 92.2 ms (1.16x): pass | 258 ms (1.76x): pass | 63.2 ms (0.48x): pass |
| G4 segment switch, 100 MB | <= 500 ms; <= 10x a normal plain sync | 87.3 ms (1.06x): pass | 278 ms (1.93x): pass | 58.8 ms (0.28x): pass |
| G5 unit size | smallest of 8/32/64 KB passing G2 | n/a: `src/` has one default unit, 64 KB; G2 passes at it | n/a: same | n/a: same |
| G6 support | all present | all present: pass | all present: pass | all present: pass |
| G7 Rust store throughput | recorded only | owner (Tauri only) | owner (Tauri only) | owner (Tauri only) |
| G8 subkeys after a year (365 sessions) | live salts x deriveKey <= 150 ms | 263 salts, 1,507 records, 1.3 ms: pass | 21.0 ms: pass | 21.0 ms: pass |
| G9 file-table phase of the open, 10 MB | <= 5 % of the G2 budget (about 20 ms) | 9.88 ms: pass | 11.0 ms: pass | 4.62 ms: pass |
| G9 file-table phase of the open, 100 MB | <= 75 ms | 12.9 ms: pass | 19.0 ms: pass | 8.22 ms: pass |
| G9 the G1 sync writes no table block | p50 0; none on a sync that changed no file | p50 0, no table block on a sync without a file change, at most 1 per changed file: pass | same: pass | same: pass |

`node bench/gates.ts --factor 1` on the three JSON files lists every judged row above as pass (G3 "not measurable") and exits 1 only because of the `ops` part (next section). The judge does not cover G1b; that row is computed from the JSON. The Chromium G8 figure is 263 salts x 0.005 ms; Firefox and WebKit derive in 0.08 ms.

Verdict: no gate fails in any engine. G3 cannot be measured headless (Chromium has no `measureUserAgentSpecificMemory` there; Firefox and WebKit have no API), so it stays open for the devices. G2 at 100 MB in Firefox has the least headroom (1,269 of 1,500 ms).

## Other measurements

| Measure | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| `changeKey`, 10 MB / 100 MB | 3.5 / 6.9 ms | 6.8 / 25.0 ms | 7.3 / 8.0 ms |
| `verify()`, 10 MB / 100 MB | 361 / 865 ms | 580 / 1,519 ms | 301 / 427 ms |
| `rotateDataKey`, 10 MB / 100 MB | 1,150 / 2,282 ms | 2,176 / 5,122 ms | 1,036 / 932 ms |
| Open after the rotation, 100 MB (p50) | 867 ms | 1,260 ms | 376 ms |
| Open at 100 MB: wall time with a page read in flight / with a decrypt in flight (p50) | 683 / 223 ms | 971 / 435 ms | 281 / 90 ms |
| AES-GCM over 100 MB, MB/s encrypt / decrypt at 8 / 32 / 64 KB | 596/650, 970/952, 1144/791 | 201/210, 641/598, 1206/1097 | 243/1174, 537/2716, 739/2107 |
| `deriveKey` median of 1,000 | 0.01 ms | 0.06 ms | 0.04 ms |
| Year simulation duration | 182 s | 259 s | 74 s |

**`ops` part (startup and operations, plain vs encrypted): errored in Chromium and Firefox.** Both engines threw `QuotaExceededError` during the operations step (Chromium: empty message; Firefox: "The current transaction exceeded its quota limitations"); it reproduced on a second Chromium run. WebKit, on the Mac, completed it (numbers in `webkit.json`). A likely cause is the headless profile quota on this host's shared 7.6 GB tmpfs `/tmp`, but that is not verified. `ops` is not a gate and is not in the default parts of `bench/run.mjs`; treat it as unmeasured on Linux until rerun with the profile on a disk. No other part errored.

## Not measured here: what only the owner can measure

- **G7, Rust store throughput.** Only inside a Tauri shell built with `encfs-bench` (needs the `journal/02` bench endpoints).
- **Tauri webviews.** WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux), each with the page as the shell frontend (`bench/README.md`, "Inside the Tauri shells").
- **iPhone and iPad** (Safari and the Tauri iOS shell): memory limits and IndexedDB behaviour on a device, G2 and G4 on the slowest phone, and G3.
- **Android** (Chrome and Android System WebView on the Redmi and other phones): G2 at 100 MB against the 3 s slowest-target budget, G3.
- **Real Safari** (not Playwright's WebKit build) and Windows.
- **G3** in every engine: needs a device or a headed run with a memory API.
