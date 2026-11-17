# Benchmark results, 2026-11-17 (final benchmark, on `main` at `bb11824`)

Run as `bench/README.md` documents: `npm run bench:build`, then `node bench/run.mjs <browser> --parts gates10,extras,gates100,year` (20 runs per measure, p50 / p95; the `ops` part is not in the default parts and was not run). Raw JSON beside this file: `chromium.json`, `firefox.json`, `webkit.json`. The page benchmarks the shipped `src/` (`EncryptedFs` over `IndexedDbBackend.pair`, 64 KB blocks) against plain `idb://` on the same data: 10 MB and 100 MB payloads (67.8 MB and 266.6 MB data directories, 1,016 and 1,023 files). Gates are judged by `bench/judge.ts` (`node bench/gates.ts --factor 1 --require gates10,gates100,extras,year`, absolute budgets not relaxed): exit 0, every judged row passes in all three engines except G3, which cannot be measured.

**Node.** The page needs IndexedDB and a DOM, so it cannot run in Node. Node v26.13.0 only drives Playwright and Vite; there is no Node benchmark row. Node behaviour is covered by the test suite.

## Environment

| | Chromium, Firefox | WebKit |
| --- | --- | --- |
| Machine | ROG G14, shared with other jobs | MacBook Pro (M1 Pro) |
| CPU | AMD Ryzen 5 4600HS, 12 threads | Apple M1 Pro |
| RAM | 15 GiB | 16 GiB |
| OS | CachyOS Linux, kernel 7.3.0-4-cachyos | macOS 27.0.1 |
| Browser | Chromium 158.0.8127.18 (headless), Firefox 159.0 (Playwright build, headless) | Playwright WebKit for macOS, headless; its user agent reads `Macintosh ... Version/27.2 Safari/605.1.15`. Not Safari, not WKWebView |
| Playwright / PGlite / Node | 1.65.0 / 0.5.10 / v26.13.0 | same lockfile; Node v26.13.0 |

WebKit absolute times are from a different, faster machine than Chromium and Firefox: compare plain against encrypted within one engine, not across columns.

## Gate table G1 to G9

Target = the gate definitions in `bench/README.md`, with the desktop budgets. "Ratio" is encrypted p50 divided by plain p50 in the same run (values in parentheses: encrypted vs plain, ms). All rows pass in every engine except G3, which cannot be measured.

| Gate | Target | Chromium | Firefox | WebKit (Mac, Playwright build) |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE, 10 MB | ratio <= 2 | 0.06 (4.3 vs 72.9): pass | 0.04 (6.14 vs 138): pass | 0.03 (2.66 vs 98.8): pass |
| G1 sync, one-row UPDATE, 100 MB | ratio <= 2 | 0.07 (4.83 vs 68.1): pass | 0.05 (6.96 vs 154): pass | 0.01 (2.24 vs 156): pass |
| G1b sync, one 4 KB insert, 10 MB | ratio <= 2; <= 1 table block | 0.06 (6.12 vs 110); table blocks p50 1, max 1: pass | 0.04 (8.86 vs 199); 1 / 1: pass | 0.03 (3.06 vs 106); 1 / 1: pass |
| G1b sync, one 4 KB insert, 100 MB | ratio <= 2; <= 1 table block | 0.01 (7.11 vs 551); 1 / 2: pass on p50 | 0.01 (9.5 vs 754); 1 / 2: pass on p50 | 0.01 (3.88 vs 265); 1 / 2: pass on p50 |
| G2 open, 10 MB | ratio <= 2 | 1.31 (440 vs 336 ms): pass | 1.11 (682 vs 613 ms): pass | 0.57 (163 vs 285 ms): pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.60 (923 vs 577 ms): pass | 0.96 (1,265 vs 1,315 ms): pass | 0.78 (323 vs 416 ms): pass |
| G3 memory after the open | database + 64 MB | not measurable: 486 MB (10 MB db), 449 MB (100 MB db), whole renderer heap incl. baseline | not measurable (no memory API) | not measurable (no memory API) |
| G4 segment switch, 10 MB | <= 500 ms; <= 10x a normal plain sync | 85.1 ms (1.17x): pass | 272 ms (1.97x): pass | 28.6 ms (0.29x): pass |
| G4 segment switch, 100 MB | <= 500 ms; <= 10x a normal plain sync | 89.3 ms (1.31x): pass | 277 ms (1.79x): pass | 29.8 ms (0.19x): pass |
| G5 unit size | smallest of 8/32/64 KB passing G2 | n/a: `src/` has one default unit, 64 KB; G2 passes at it | n/a: same | n/a: same |
| G6 support | all present | all present: pass | all present: pass | all present: pass |
| G7 Rust store throughput | recorded only | not run | not run | not run |
| G8 subkeys after a year (365 sessions) | live salts x deriveKey <= 150 ms | 263 salts, 1,507 records: 1.32 ms: pass | 15.8 ms: pass | 15.8 ms: pass |
| G9 file-table phase of the open, 10 MB | <= 5 % of the G2 budget (limit 8.2 to 34.1 ms, by the run's G2) | 8.91 ms (limit 22): pass | 8.06 ms (limit 34.1): pass | 4.5 ms (limit 8.2): pass |
| G9 file-table phase of the open, 100 MB | <= 75 ms | 11.0 ms: pass | 19.6 ms: pass | 5.52 ms: pass |
| G9 the G1 sync writes no table block | p50 0; none on a sync that changed no file; <= 1 per changed file | p50 0, none without a file change, at most 1 per changed file: pass | same: pass | same: pass |

The judge does not cover G1b; that row is computed from the JSON. Firefox and WebKit G8 read the same 15.78 ms because both report the `deriveKey` p50 as 0.06 ms (timer resolution), times 263 salts.

Verdict: no gate fails in any engine. Least headroom: G2 at 100 MB in Firefox (1,265 of 1,500 ms) and the Chromium G2 ratio at 100 MB (1.60 of 2, against 1.24 on 2026-11-16: the plain open took 577 ms this time, the encrypted open 923 ms, so the ratio moved with the plain baseline on the shared host; the absolute open is faster than before, 956 ms then).

## Other measurements

| Measure | Chromium | Firefox | WebKit (Mac) |
| --- | --- | --- | --- |
| `changeKey`, 10 MB / 100 MB | 3.7 / 7.2 ms | 26.6 / 22.6 ms | 11.2 / 9.9 ms |
| `verify()`, 10 MB / 100 MB | 374 / 861 ms | 593 / 1,611 ms | 106 / 271 ms |
| `rotateDataKey`, 10 MB / 100 MB | 1,064 / 2,516 ms | 2,169 / 4,982 ms | 299 / 754 ms |
| Open after the rotation, 10 MB / 100 MB (p50) | 447 / 922 ms | 686 / 1,271 ms | 148 / 293 ms |
| Open at 10 MB: wall time with a page read in flight / with a decrypt in flight (p50) | 308 / 92 ms | 436 / 194 ms | 92 / 57 ms |
| Open at 100 MB: same | 718 / 239 ms | 1,000 / 492 ms | 228 / 200 ms |
| AES-GCM over 100 MB, MB/s encrypt / decrypt at 8 / 32 / 64 KB | 591/653, 946/947, 1147/784 | 200/212, 642/600, 1170/1077 | 469/2415, 1007/4600, 1556/5005 |
| `deriveKey` median of 1,000 | 0.01 ms | 0.08 ms | 0.04 ms |
| Year simulation duration | 197 s | 285 s | 74 s |

## Not measured here

- **G7, Rust store throughput.** The page no longer has a G7 part; it needs a native shell with a Rust store.
- **App webviews.** WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux), each with the page as the frontend (`bench/README.md`, "Other browsers and devices").
- **iPhone and iPad** (Safari and an app webview): memory limits and IndexedDB behaviour on a device, G2 and G4 on the slowest phone, and G3.
- **Android** (Chrome and Android System WebView): G2 at 100 MB against the 3 s slowest-target budget, G3.
- **Real Safari on macOS and Windows** (this run's WebKit was Playwright's macOS build, not Safari or WKWebView).
- **G3** in every engine: needs a device or a headed run with a memory API.
