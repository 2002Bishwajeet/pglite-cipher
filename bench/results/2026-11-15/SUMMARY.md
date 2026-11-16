# Benchmark results, 2026-11-15 (final, on `main` at `1896ea8`)

Run as `bench/README.md` documents: `npm run bench:build`, then `node bench/run.mjs <browser> --parts gates10,gates100,extras,year` (20 runs per measure, p50 / p95; the `ops` part is not in the default parts and was not run). Raw JSON beside this file: `chromium.json`, `firefox.json`, `webkit.json`. The page benchmarks the shipped `src/` (`EncryptedFs` over `IndexedDbBackend.pair`, 64 KB blocks) against plain `idb://` on the same data: 10 MB and 100 MB payloads (67.8 MB and 266.6 MB data directories, 1,020 files). Gates are judged by `bench/judge.ts` (`node bench/gates.ts --factor 1`, absolute budgets not relaxed); it lists every judged row as pass (G3 "not measurable") and exits 0.

**Node.** The page needs IndexedDB and a DOM, so it cannot run in Node. Node v26.13.0 only drives Playwright and Vite; there is no Node benchmark row. Node behaviour is covered by the test suite.

## Environment

| | Chromium, Firefox | WebKit |
| --- | --- | --- |
| Machine | ROG G14, shared with other harness sessions (heavy lock held for each run) | Same host: the Mac was unreachable, so `scripts/harness/webkit.sh` fell back to Playwright's Linux container (`mcr.microsoft.com/playwright:v1.65.0-noble`, podman, capped at 4 GB) |
| CPU | AMD Ryzen 5 4600HS, 12 threads | same |
| RAM | 15 GiB | same (container cap 4 GB) |
| OS | CachyOS Linux, kernel 7.3.0-4-cachyos | Ubuntu noble container on the same kernel |
| Browser | Chromium 158.0.8127.18 (headless), Firefox 159.0 (Playwright build, headless) | Playwright WebKit (Linux build, headless); its user agent reads `Macintosh ... Version/27.2 Safari/605.1.15`. Not Safari, not WKWebView |
| Playwright / PGlite / Node | 1.65.0 / 0.5.10 / v26.13.0 | same |

Unlike 2026-11-13, WebKit did not run on the Mac (M1 Pro): its absolute times are not comparable with the earlier WebKit column or with the other two engines here. Compare plain against encrypted within one engine. `/tmp` on this host is a 7.6 GB tmpfs holding the browser profiles.

## Gate table G1 to G9

Target = `docs/plan/01-sqlcipher-comparison.md` 3.3 with the desktop budgets of #3. "Ratio" is encrypted p50 divided by plain p50 in the same run. Every row passes in every engine except G3, which cannot be measured.

| Gate | Target | Chromium | Firefox | WebKit (Linux container) |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE, 10 MB | ratio <= 2 | 0.05 (4.11 vs 84.3 ms): pass | 0.04 (6.42 vs 158 ms): pass | 0.02 (5.08 vs 275 ms): pass |
| G1 sync, one-row UPDATE, 100 MB | ratio <= 2 | 0.07 (4.70 vs 67.2 ms): pass | 0.05 (8.12 vs 159 ms): pass | 0.01 (5.32 vs 731 ms): pass |
| G1b sync, one 4 KB insert, 10 MB | ratio <= 2; <= 1 table block | 0.05 (5.69 vs 110 ms); table blocks p50 1, max 1: pass | 0.04 (7.82 vs 213 ms); 1 / 1: pass | 0.02 (5.78 vs 297 ms); 1 / 1: pass |
| G1b sync, one 4 KB insert, 100 MB | ratio <= 2; <= 1 table block | 0.01 (6.75 vs 504 ms); 1 / 2: pass on p50 | 0.01 (10.8 vs 753 ms); 1 / 2: pass on p50 | 0.01 (8.58 vs 1,469 ms); 1 / 2: pass on p50 |
| G2 open, 10 MB | ratio <= 2 | 1.28 (428 vs 335 ms): pass | 1.06 (679 vs 638 ms): pass | 0.68 (511 vs 750 ms): pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.50 (910 ms): pass | 1.03 (1,294 ms): pass | 0.54 (913 ms): pass |
| G3 memory after the open | database + 64 MB | not measurable: 486 MB (10 MB db), 449 MB (100 MB db), whole renderer heap incl. baseline; plain idb 402 / 727 MB | not measurable (no memory API) | not measurable (no memory API) |
| G4 segment switch, 10 MB | <= 500 ms; <= 10x a normal plain sync | 90.6 ms (1.08x): pass | 266 ms (1.68x): pass | 64.0 ms (0.23x): pass |
| G4 segment switch, 100 MB | <= 500 ms; <= 10x a normal plain sync | 91.0 ms (1.36x): pass | 285 ms (1.79x): pass | 65.9 ms (0.09x): pass |
| G5 unit size | smallest of 8/32/64 KB passing G2 | n/a: `src/` has one default unit, 64 KB; G2 passes at it | n/a: same | n/a: same |
| G6 support | all present | all present: pass | all present: pass | all present: pass |
| G7 Rust store throughput | recorded only | owner (Tauri only) | owner (Tauri only) | owner (Tauri only) |
| G8 subkeys after a year (365 sessions) | live salts x deriveKey <= 150 ms | 263 salts, 1,507 records, 1.3 ms: pass | 10.5 ms: pass | 10.5 ms: pass |
| G9 file-table phase of the open, 10 MB | <= 5 % of the G2 budget (limit 21.4 to 33.9 ms, by the run's G2) | 8.84 ms: pass | 10.7 ms: pass | 7.56 ms: pass |
| G9 file-table phase of the open, 100 MB | <= 75 ms | 10.9 ms: pass | 20.9 ms: pass | 10.6 ms: pass |
| G9 the G1 sync writes no table block | p50 0; none on a sync that changed no file; <= 1 per changed file | p50 0, none without a file change, at most 1 per changed file: pass | same: pass | same: pass |

The judge does not cover G1b; that row is computed from the JSON. Chromium G8 is 263 salts x 0.005 ms; Firefox and WebKit derive in 0.04 to 0.06 ms.

Verdict: no gate fails in any engine. Least headroom: G2 at 100 MB in Firefox (1,294 of 1,500 ms) and the Chromium G2 ratio at 100 MB (1.50 of 2; it was 1.34 on 2026-11-13, with the plain open at 606 ms here, so ratio noise on the shared host is plausible, not verified).

## Other measurements

| Measure | Chromium | Firefox | WebKit (container) |
| --- | --- | --- | --- |
| `changeKey`, 10 MB / 100 MB | 3.8 / 6.0 ms | 14.1 / 16.6 ms | 34.5 / 14.4 ms |
| `verify()`, 10 MB / 100 MB | 406 / 874 ms | 625 / 1,643 ms | 427 / 981 ms |
| `rotateDataKey`, 10 MB / 100 MB | 1,021 / 2,395 ms | 2,052 / 4,851 ms | 1,001 / 1,950 ms |
| Open after the rotation, 100 MB (p50) | 910 ms | 1,234 ms | 878 ms |
| Open at 100 MB: wall time with a page read in flight / with a decrypt in flight (p50) | 715 / 238 ms | 992 / 483 ms | 737 / 218 ms |
| AES-GCM over 100 MB, MB/s encrypt / decrypt at 8 / 32 / 64 KB | 584/623, 947/922, 1154/823 | 192/206, 569/556, 1122/1047 | 756/994, 1276/1448, 1561/1546 |
| `deriveKey` median of 1,000 | 0.01 ms | 0.06 ms | 0.04 ms |
| Year simulation duration | 191 s | 280 s | 224 s |

## Not measured here: what only the owner can measure

- **G7, Rust store throughput.** Only inside a Tauri shell built with `encfs-bench` (needs the `journal/02` bench endpoints).
- **Tauri webviews.** WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux), each with the page as the shell frontend (`bench/README.md`, "Inside the Tauri shells").
- **iPhone and iPad** (Safari and the Tauri iOS shell): memory limits and IndexedDB behaviour on a device, G2 and G4 on the slowest phone, and G3.
- **Android** (Chrome and Android System WebView on the Redmi and other phones): G2 at 100 MB against the 3 s slowest-target budget, G3.
- **Real Safari on macOS** (this run's WebKit was Playwright's Linux build in a container, not Safari and not the Mac build) and Windows.
- **G3** in every engine: needs a device or a headed run with a memory API.
