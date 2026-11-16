# Benchmark results, 2026-11-16 (final re-run, on `main` at `f0f47c8`)

Re-run of the earlier 2026-11-16 results (`150e3a3`, `main` at `f649f3d`) after the later merges (`bench/` changes and docs only; `src/` unchanged). Run as `bench/README.md` documents: `npm run bench:build`, then `node bench/run.mjs <browser> --parts gates10,extras,gates100,year` (20 runs per measure, p50 / p95; the `ops` part is not in the default parts and was not run). Raw JSON beside this file: `chromium.json`, `firefox.json`, `webkit.json`. The page benchmarks the shipped `src/` (`EncryptedFs` over `IndexedDbBackend.pair`, 64 KB blocks) against plain `idb://` on the same data: 10 MB and 100 MB payloads (67.8 MB and 266.6 MB data directories, 1,016 and 1,023 files). Gates are judged by `bench/judge.ts` (`node bench/gates.ts --factor 1`, absolute budgets not relaxed): every judged row passes in all three engines except G3, which cannot be measured (exit 0).

**Node.** The page needs IndexedDB and a DOM, so it cannot run in Node. Node v26.13.0 only drives Playwright and Vite; there is no Node benchmark row. Node behaviour is covered by the test suite.

## Environment

| | Chromium, Firefox | WebKit |
| --- | --- | --- |
| Machine | ROG G14, shared with other harness sessions (heavy lock held for each run) | MacBook Pro (M1 Pro), reached through `scripts/harness/webkit.sh` -> `remote.sh mac` |
| CPU | AMD Ryzen 5 4600HS, 12 threads | Apple M1 Pro |
| RAM | 15 GiB | 16 GiB |
| OS | CachyOS Linux, kernel 7.3.0-4-cachyos | macOS 27.0.1 |
| Browser | Chromium 158.0.8127.18 (headless), Firefox 159.0 (Playwright build, headless) | Playwright WebKit for macOS, headless; its user agent reads `Macintosh ... Version/27.2 Safari/605.1.15`. Not Safari, not WKWebView |
| Playwright / PGlite / Node | 1.65.0 / 0.5.10 / v26.13.0 | same lockfile; Node v26.13.0 |

WebKit absolute times are from a different, faster machine than Chromium and Firefox: compare plain against encrypted within one engine, not across columns.

## Gate table G1 to G9

Target = `docs/plan/01-sqlcipher-comparison.md` 3.3 with the desktop budgets of #3. "Ratio" is encrypted p50 divided by plain p50 in the same run (values in parentheses: encrypted vs plain). All rows pass in every engine except G3, which cannot be measured.

| Gate | Target | Chromium | Firefox | WebKit (Mac, Playwright build) |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE, 10 MB | ratio <= 2 | 0.07 (4.78 vs 67.3 ms): pass | 0.04 (6.42 vs 161 ms): pass | 0.02 (2.34 vs 98.7 ms): pass |
| G1 sync, one-row UPDATE, 100 MB | ratio <= 2 | 0.07 (4.70 vs 70.1 ms): pass | 0.05 (8.48 vs 166 ms): pass | 0.01 (2.26 vs 167 ms): pass |
| G1b sync, one 4 KB insert, 10 MB | ratio <= 2; <= 1 table block | 0.05 (6.23 vs 116 ms); table blocks p50 1, max 1: pass | 0.04 (7.64 vs 188 ms); 1 / 1: pass | 0.03 (3.16 vs 107 ms); 1 / 1: pass |
| G1b sync, one 4 KB insert, 100 MB | ratio <= 2; <= 1 table block | 0.01 (6.70 vs 607 ms); 1 / 2: pass on p50 | 0.01 (9.70 vs 755 ms); 1 / 2: pass on p50 | 0.01 (3.84 vs 270 ms); 1 / 2: pass on p50 |
| G2 open, 10 MB | ratio <= 2 | 1.23 (470 vs 381 ms): pass | 1.09 (687 vs 631 ms): pass | 0.54 (156 vs 286 ms): pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.24 (956 ms): pass | 1.06 (1,319 ms): pass | 0.76 (329 ms): pass |
| G3 memory after the open | database + 64 MB | not measurable: 514 MB (10 MB db), 860 MB (100 MB db), whole renderer heap incl. baseline | not measurable (no memory API) | not measurable (no memory API) |
| G4 segment switch, 10 MB | <= 500 ms; <= 10x a normal plain sync | 91.5 ms (1.36x): pass | 271 ms (1.68x): pass | 29.5 ms (0.30x): pass |
| G4 segment switch, 100 MB | <= 500 ms; <= 10x a normal plain sync | 90.9 ms (1.30x): pass | 282 ms (1.70x): pass | 30.2 ms (0.18x): pass |
| G5 unit size | smallest of 8/32/64 KB passing G2 | n/a: `src/` has one default unit, 64 KB; G2 passes at it | n/a: same | n/a: same |
| G6 support | all present | all present: pass | all present: pass | all present: pass |
| G7 Rust store throughput | recorded only | owner (Tauri only) | owner (Tauri only) | owner (Tauri only) |
| G8 subkeys after a year (365 sessions) | live salts x deriveKey <= 150 ms | 263 salts, 1,507 records: 1.32 ms: pass | 10.5 ms: pass | 15.8 ms: pass |
| G9 file-table phase of the open, 10 MB | <= 5 % of the G2 budget (limit 7.8 to 34.4 ms, by the run's G2) | 8.95 ms (limit 23.5): pass | 10.7 ms (limit 34.4): pass | 4.54 ms (limit 7.8): pass |
| G9 file-table phase of the open, 100 MB | <= 75 ms | 10.8 ms: pass | 20.9 ms: pass | 5.42 ms: pass |
| G9 the G1 sync writes no table block | p50 0; none on a sync that changed no file; <= 1 per changed file | p50 0, none without a file change, at most 1 per changed file: pass | same: pass | same: pass |

The judge does not cover G1b; that row is computed from the JSON.

Verdict: no gate fails in any engine. Least headroom: G2 at 100 MB in Firefox (1,319 of 1,500 ms) and the Chromium G2 ratio (1.23 and 1.24 of 2; ratio noise on the shared host).

## Other measurements

| Measure | Chromium | Firefox | WebKit (Mac) |
| --- | --- | --- | --- |
| `changeKey`, 10 MB / 100 MB | 13.7 / 14.9 ms | 22.0 / 16.8 ms | 8.8 / 9.1 ms |
| `verify()`, 10 MB / 100 MB | 370 / 842 ms | 642 / 1,513 ms | 111 / 241 ms |
| `rotateDataKey`, 10 MB / 100 MB | 1,052 / 2,336 ms | 2,259 / 5,011 ms | 290 / 699 ms |
| Open after the rotation, 10 MB / 100 MB (p50) | 458 / 927 ms | 655 / 1,270 ms | 145 / 299 ms |
| Open at 100 MB: wall time with a page read in flight / with a decrypt in flight (p50) | 723 / 238 ms | 1,022 / 458 ms | 234 / 211 ms |
| AES-GCM over 100 MB, MB/s encrypt / decrypt at 8 / 32 / 64 KB | 602/661, 942/938, 1151/865 | 198/215, 629/573, 1186/1070 | 478/2176, 1005/4525, 1544/4721 |
| `deriveKey` median of 1,000 | 0.01 ms | 0.04 ms | 0.04 ms |
| Year simulation duration | 204 s | 285 s | 77 s |

## Not measured here: what only the owner can measure

- **G7, Rust store throughput.** Only inside a Tauri shell built with `encfs-bench` (needs the `journal/02` bench endpoints).
- **Tauri webviews.** WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux), each with the page as the shell frontend (`bench/README.md`, "Inside the Tauri shells").
- **iPhone and iPad** (Safari and the Tauri iOS shell): memory limits and IndexedDB behaviour on a device, G2 and G4 on the slowest phone, and G3.
- **Android** (Chrome and Android System WebView on the Redmi): G2 at 100 MB against the 3 s slowest-target budget, G3.
- **Real Safari on macOS and Windows** (this run's WebKit was Playwright's macOS build, not Safari or WKWebView).
- **G3** in every engine: needs a device or a headed run with a memory API.
