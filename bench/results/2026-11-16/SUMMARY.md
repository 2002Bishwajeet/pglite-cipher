# Benchmark results, 2026-11-16 (final, on `main` at `f649f3d`)

Run as `bench/README.md` documents: `npm run bench:build`, then `node bench/run.mjs <browser> --parts gates10,extras,gates100,year` (20 runs per measure, p50 / p95; the `ops` part is not in the default parts and was not run). Raw JSON beside this file: `chromium.json`, `firefox.json`, `webkit.json`. The page benchmarks the shipped `src/` (`EncryptedFs` over `IndexedDbBackend.pair`, 64 KB blocks) against plain `idb://` on the same data: 10 MB and 100 MB payloads (67.8 MB and 266.6 MB data directories, 1,020 files). Gates are judged by `bench/judge.ts` (`node bench/gates.ts --factor 1`, absolute budgets not relaxed): every judged row passes except G3, which cannot be measured (exit 0).

**Node.** The page needs IndexedDB and a DOM, so it cannot run in Node. Node v26.13.0 only drives Playwright and Vite; there is no Node benchmark row. Node behaviour is covered by the test suite.

## Environment

| | Chromium, Firefox | WebKit |
| --- | --- | --- |
| Machine | ROG G14, shared with other harness sessions (heavy lock held for each run) | MacBook Pro (M1 Pro), reached through `scripts/harness/webkit.sh` -> `remote.sh mac` (the Mac was reachable this time; the 2026-11-15 WebKit column ran in a Linux container) |
| CPU | AMD Ryzen 5 4600HS, 12 threads | Apple M1 Pro |
| RAM | 15 GiB | 16 GiB |
| OS | CachyOS Linux, kernel 7.3.0-4-cachyos | macOS 27.0.1 |
| Browser | Chromium 158.0.8127.18 (headless), Firefox 159.0 (Playwright build, headless) | Playwright WebKit for macOS, headless; its user agent reads `Macintosh ... Version/27.2 Safari/605.1.15`. Not Safari, not WKWebView |
| Playwright / PGlite / Node | 1.65.0 / 0.5.10 / v26.13.0 | same lockfile; Node as installed on the Mac |

WebKit absolute times are from a different, faster machine than Chromium and Firefox: compare plain against encrypted within one engine, and do not compare WebKit here with the 2026-11-15 container column. The WebKit year part ran after the other WebKit parts on the Mac, outside any contention from this host.

## Gate table G1 to G9

Target = `docs/plan/01-sqlcipher-comparison.md` 3.3 with the desktop budgets of #3. "Ratio" is encrypted p50 divided by plain p50 in the same run (values in parentheses: encrypted vs plain). All rows pass in every engine except G3, which cannot be measured.

| Gate | Target | Chromium | Firefox | WebKit (Mac, Playwright build) |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE, 10 MB | ratio <= 2 | 0.05 (3.97 vs 80.9 ms): pass | 0.05 (7.26 vs 139.8 ms): pass | 0.03 (2.88 vs 99.8 ms): pass |
| G1 sync, one-row UPDATE, 100 MB | ratio <= 2 | 0.07 (4.78 vs 69.2 ms): pass | 0.05 (7.22 vs 148.6 ms): pass | 0.01 (2.28 vs 171.9 ms): pass |
| G1b sync, one 4 KB insert, 10 MB | ratio <= 2; <= 1 table block | 0.05 (5.67 vs 112 ms); table blocks p50 1, max 1: pass | 0.05 (9.70 vs 205 ms); 1 / 1: pass | 0.03 (3.46 vs 106 ms); 1 / 1: pass |
| G1b sync, one 4 KB insert, 100 MB | ratio <= 2; <= 1 table block | 0.01 (6.91 vs 636 ms); 1 / 2: pass on p50 | 0.01 (10.2 vs 749 ms); 1 / 2: pass on p50 | 0.02 (4.20 vs 280 ms); 1 / 2: pass on p50 |
| G2 open, 10 MB | ratio <= 2 | 1.17 (470 vs 403 ms): pass | 1.12 (704 vs 630 ms): pass | 0.57 (162 vs 281 ms): pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.37 (945 ms): pass | 1.02 (1,342 ms): pass | 0.80 (339 ms): pass |
| G3 memory after the open | database + 64 MB | not measurable: 487 MB (10 MB db), 449 MB (100 MB db), whole renderer heap incl. baseline | not measurable (no memory API) | not measurable (no memory API) |
| G4 segment switch, 10 MB | <= 500 ms; <= 10x a normal plain sync | 89.6 ms (1.11x): pass | 266 ms (1.90x): pass | 34.5 ms (0.35x): pass |
| G4 segment switch, 100 MB | <= 500 ms; <= 10x a normal plain sync | 98.9 ms (1.43x): pass | 282 ms (1.90x): pass | 33.0 ms (0.19x): pass |
| G5 unit size | smallest of 8/32/64 KB passing G2 | n/a: `src/` has one default unit, 64 KB; G2 passes at it | n/a: same | n/a: same |
| G6 support | all present | all present: pass | all present: pass | all present: pass |
| G7 Rust store throughput | recorded only | owner (Tauri only) | owner (Tauri only) | owner (Tauri only) |
| G8 subkeys after a year (365 sessions) | live salts x deriveKey <= 150 ms | 263 salts, 1,507 records: 2.63 ms: pass | 10.5 ms: pass | 15.8 ms: pass |
| G9 file-table phase of the open, 10 MB | <= 5 % of the G2 budget (limit 8.1 to 35.2 ms, by the run's G2) | 9.66 ms (limit 23.5): pass | 10.9 ms (limit 35.2): pass | 4.76 ms (limit 8.1): pass |
| G9 file-table phase of the open, 100 MB | <= 75 ms | 12.2 ms: pass | 15.7 ms: pass | 5.72 ms: pass |
| G9 the G1 sync writes no table block | p50 0; none on a sync that changed no file; <= 1 per changed file | p50 0, none without a file change, at most 1 per changed file: pass | same: pass | same: pass |

The judge does not cover G1b; that row is computed from the JSON.

Verdict: no gate fails in any engine. Least headroom: G2 at 100 MB in Firefox (1,342 of 1,500 ms) and the Chromium G2 ratio at 100 MB (1.37 of 2; 1.50 on 2026-11-15, 1.34 on 2026-11-13: ratio noise on the shared host).

## Other measurements

| Measure | Chromium | Firefox | WebKit (Mac) |
| --- | --- | --- | --- |
| `changeKey`, 10 MB / 100 MB | 6.5 / 24.1 ms | 25.0 / 28.9 ms | 6.4 / 6.7 ms |
| `verify()`, 10 MB / 100 MB | 393 / 838 ms | 684 / 1,474 ms | 105 / 262 ms |
| `rotateDataKey`, 10 MB / 100 MB | 1,057 / 2,392 ms | 1,983 / 5,078 ms | 303 / 739 ms |
| Open after the rotation, 10 MB / 100 MB (p50) | 474 / 970 ms | 658 / 1,326 ms | 153 / 306 ms |
| Open at 100 MB: wall time with a page read in flight / with a decrypt in flight (p50) | 725 / 240 ms | 1,038 / 506 ms | 244 / 203 ms |
| AES-GCM over 100 MB, MB/s encrypt / decrypt at 8 / 32 / 64 KB | 588/635, 946/929, 1151/894 | 202/207, 641/585, 1160/1082 | 388/2044, 928/3779, 1515/5133 |
| `deriveKey` median of 1,000 | 0.01 ms | 0.06 ms | 0.04 ms |
| Year simulation duration | 231 s | 290 s | 76 s |

## Not measured here: what only the owner can measure

- **G7, Rust store throughput.** Only inside a Tauri shell built with `encfs-bench` (needs the `journal/02` bench endpoints).
- **Tauri webviews.** WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux), each with the page as the shell frontend (`bench/README.md`, "Inside the Tauri shells").
- **iPhone and iPad** (Safari and the Tauri iOS shell): memory limits and IndexedDB behaviour on a device, G2 and G4 on the slowest phone, and G3.
- **Android** (Chrome and Android System WebView on the Redmi): G2 at 100 MB against the 3 s slowest-target budget, G3.
- **Real Safari on macOS and Windows** (this run's WebKit was Playwright's macOS build, not Safari or WKWebView).
- **G3** in every engine: needs a device or a headed run with a memory API.
