# Benchmark results, 2026-11-13 (re-run)

Final benchmark on `main` at `78e5851`, run as documented in `bench/README.md`: the benchmark page (`bench/`) in headless Playwright through `spike/run.mjs`, parts `gates10,extras,gates100,year`, 20 runs per measure, p50 / p95. Raw JSON beside this file: `chromium.json`, `firefox.json`, `webkit.json`. This replaces the earlier 2026-11-13 run (commit 5dccf50, on `2efe68f`) in the same directory.

**What was measured.** The page benchmarks the issue #2 prototype filesystem (`spike/protoFs.ts`) against plain `idb://`, at 8, 32 and 64 KB units. It does not exercise the shipped `src/` (`EncryptedFs`); `bench/README.md` documents no benchmark of `src/`. These numbers re-check the spike verdict on current dependencies and browsers; they are not a measurement of the released code.

**Node.** The page needs IndexedDB and a DOM, so it cannot run in Node. Node (v26.13.0) is only the host that drives Playwright and Vite; no Node row exists.

## Environment

| | Chromium, Firefox | WebKit |
| --- | --- | --- |
| Machine | ROG G14 (host `CachyOs-G14`), shared with other harness jobs, heavy lock held | MacBook Pro, through `scripts/harness/webkit.sh` (the Mac path; the podman fallback was not used) |
| CPU | AMD Ryzen 5 4600HS (12 threads) | Apple M1 Pro |
| RAM | 15 GiB | 16 GiB |
| OS | CachyOS Linux, kernel 7.3.0-4-cachyos | macOS 27.0.1 |
| Browser | Chromium 158.0.8127.18 (headless), Firefox 159.0 (Playwright build, headless) | Playwright WebKit, `Version/27.2 Safari/605.1.15`, headless. Not Safari, not WKWebView |
| Playwright | 1.65.0 | 1.65.0 |
| PGlite | 0.5.10 | 0.5.10 |

WebKit ran on different, faster hardware than the other two. Compare plain against encrypted within one engine, never absolute times across engines. Chromium and Firefox ran on a machine other sessions share, so timings are noisy (see "Noise" in `spike/RESULTS.md`). Chromium's G3 reads `performance.memory` (launched with `--enable-precise-memory-info`); `measureUserAgentSpecificMemory` does not exist headless. Firefox and WebKit have no memory API the page can use, so G3 is n/a there.

## Gates

Targets are `docs/plan/03-spike-prototype-benchmarks.md`, as restated by the owner on #3: G2 at 10 MB is "no worse than 2x plain `idb://`" only. "10 MB" and "100 MB" are the blob payload. Gates are judged on p50, by the flags the page computes. G9 passes when both `G9_fileMap` and `G9_g1p50` are true (file-map phase within 5 % of the G2 budget, and the G1 sync p50 writes no table block). The page's stricter `G9` flag, which also requires that no G1 sync ever wrote a table block, is false at every unit in every engine (as in the earlier run). Cells list 8 / 32 / 64 KB.

Verdict by engine (recommended unit = G5 at 100 MB): Chromium passes G1, G1b, G2 (64 KB at 100 MB; 32 and 64 KB at 10 MB), G4, G6, G8, G9 and fails G3 at every unit. Firefox passes G1, G1b, G2 (32 and 64 KB at 100 MB; every unit at 10 MB), G6, G8, G9, and G4 at 32 and 64 KB (8 KB fails). WebKit passes every gate it can measure at every unit; G3 is not measurable there. G7 is owner-only. The verdict matches the earlier run on `2efe68f`.

| Gate | Target | Chromium | Firefox | WebKit |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE | enc p50 <= 2x plain | 100 MB: plain 83.0 ms; 0.70 pass, 0.83 pass, 0.80 pass | 100 MB: plain 159 ms; 1.70 pass, 1.62 pass, 1.64 pass | 100 MB: plain 160 ms; 0.38 pass, 0.44 pass, 0.44 pass |
| G1b sync, one 4 KB insert | <= 2x plain, <= 1 table block | 100 MB: plain 589 ms; 1.08 pass, 1.18 pass, 1.56 pass | 100 MB: plain 746 ms; 2.30 pass, 2.40 pass, 3.86 pass | 100 MB: plain 273 ms; 0.66 pass, 0.92 pass, 1.02 pass |
| G2 open, 10 MB (p50 ms) | <= 2x plain | plain 370; 970 FAIL, 648 pass, 429 pass | plain 640; 741 pass, 576 pass, 598 pass | plain 284; 145 pass, 117 pass, 137 pass |
| G2 open, 100 MB (p50 ms) | <= 2x plain and <= 1,500 ms | plain 715; 2,918 FAIL, 1,661 FAIL, 853 pass | plain 1,286; 2,044 FAIL, 1,285 pass, 1,187 pass | plain 418; 367 pass, 257 pass, 244 pass |
| G3 memory | open <= database + 64 MB | 100 MB: 737 MB FAIL, 721 MB FAIL, 672 MB FAIL (plain idb 721 MB); 10 MB: 510 MB FAIL, 374 MB FAIL, 375 MB FAIL (plain idb 398 MB) | not available (no memory API) | not available (no memory API) |
| G4 segment switch | <= 500 ms | 100 MB: 191 pass, 106 pass, 81.7 pass; 10 MB: 178 pass, 108 pass, 82.3 pass | 100 MB: 618 FAIL, 328 pass, 273 pass; 10 MB: 560 FAIL, 317 pass, 272 pass | 100 MB: 114 pass, 58.2 pass, 31.7 pass; 10 MB: 116 pass, 47.6 pass, 29.2 pass |
| G5 unit size | smallest unit passing G2 | 10 MB: 32 KB; 100 MB: 64 KB | 10 MB: 8 KB; 100 MB: 32 KB | 10 MB: 8 KB; 100 MB: 8 KB |
| G6 support | all present | all present: pass | all present: pass | all present: pass |
| G7 Rust store throughput | recorded only | owner (Tauri only) | owner (Tauri only) | owner (Tauri only) |
| G8 subkeys | live salts x deriveKey <= 150 ms | 366 live salts x 0.01 ms = 3.66 ms: pass | 366 live salts x 0.1 ms = 36.6 ms: pass | 366 live salts x 0.06 ms = 21.96 ms: pass |
| G9 file table | file-map <= 5 % of G2 budget; G1 sync p50 writes no table block | file-map 100 MB 28.7 / 7.69 / 16.9 ms (budget 75), 10 MB 17.9 / 9.44 / 6.12 ms (budget 20); pass, pass, pass at 100 MB, pass, pass, pass at 10 MB | file-map 100 MB 42.3 / 13.7 / 10.4 ms (budget 75), 10 MB 15.3 / 7.96 / 6.84 ms (budget 20); pass, pass, pass at 100 MB, pass, pass, pass at 10 MB | file-map 100 MB 24.5 / 12.5 / 9.92 ms (budget 75), 10 MB 15.5 / 9.96 / 10.2 ms (budget 20); pass, pass, pass at 100 MB, pass, pass, pass at 10 MB |

## Per engine, every unit

### chromium

User agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.8127.18 Safari/537.36`

| Measure (p50 / p95 ms unless noted) | plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|
| data directory at 10 MB | | 64.7 MiB | | |
| G1 sync, one-row UPDATE, 10 MB | 86.2 / 111 | 0.68 / 1.16 pass | 0.69 / 1.92 pass | 0.80 / 2.51 pass |
| G1b sync, one 4 KB insert, 10 MB | 115 / 130 | 0.92 / 1.38 pass | 1.42 / 1.98 pass | 2.01 / 2.95 pass |
| G2 open, 10 MB | 370 / 431 | 970 / 1,031 FAIL | 648 / 768 pass | 429 / 469 pass |
| G4 segment switch, 10 MB | 125 / 139 | 178 / 192 pass | 108 / 120 pass | 82.3 / 93.0 pass |
| G9 file-map phase of the open p50, 10 MB (budget 20 ms) | | 17.9 pass | 9.44 pass | 6.12 pass |
| G9 table blocks written by the G1 sync, 10 MB (p50 / max; p50 must be 0) | | 0 / 1 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 10 MB (budget: data + 64 MB) | 398 MB | 510 MB FAIL | 374 MB FAIL | 375 MB FAIL |
| data directory at 100 MB | | 254.2 MiB | | |
| G1 sync, one-row UPDATE, 100 MB | 83.0 / 92.2 | 0.70 / 2.25 pass | 0.83 / 2.99 pass | 0.80 / 11.8 pass |
| G1b sync, one 4 KB insert, 100 MB | 589 / 613 | 1.08 / 2.30 pass | 1.18 / 1.94 pass | 1.56 / 2.12 pass |
| G2 open, 100 MB | 715 / 831 | 2,918 / 3,113 FAIL | 1,661 / 1,816 FAIL | 853 / 907 pass |
| G4 segment switch, 100 MB | 566 / 671 | 191 / 322 pass | 106 / 124 pass | 81.7 / 96.0 pass |
| G9 file-map phase of the open p50, 100 MB (budget 75 ms) | | 28.7 pass | 7.69 pass | 16.9 pass |
| G9 table blocks written by the G1 sync, 100 MB (p50 / max; p50 must be 0) | | 0 / 2 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 100 MB (budget: data + 64 MB) | 721 MB | 737 MB FAIL | 721 MB FAIL | 672 MB FAIL |

G5 unit size (smallest passing G2): 10 MB run 32768, 100 MB run 65536.

G6: aesGcm:true, hkdfDeriveKeyToAesGcm:true, unwrapKeyRawIntoHkdf:true, idbDurability_strict:strict, idbDurability_relaxed:relaxed, idbNumberKeysOrderedFirst:true, idbStringKeyRangeGetAll:true, idb2048PutsThen2048DeletesMs:puts:150.47,deletes:111.75.

G8: 366 live salts after 365 sessions x deriveKey p50 0.01 ms = 3.66 ms (budget 150 ms): pass. The year run took 324 s; 7252 live records. deriveKey x1000 p50 0.02 ms.

AES-GCM over 100 MB, MB/s encrypt / decrypt: 8k: 604 / 673, 32k: 937 / 909, 64k: 1144 / 854.

### firefox

User agent: `Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0`

| Measure (p50 / p95 ms unless noted) | plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|
| data directory at 10 MB | | 64.7 MiB | | |
| G1 sync, one-row UPDATE, 10 MB | 156 / 178 | 0.98 / 2.16 pass | 1.54 / 3.60 pass | 1.62 / 3.40 pass |
| G1b sync, one 4 KB insert, 10 MB | 207 / 248 | 1.76 / 2.50 pass | 3.28 / 4.12 pass | 3.64 / 4.96 pass |
| G2 open, 10 MB | 640 / 699 | 741 / 790 pass | 576 / 607 pass | 598 / 635 pass |
| G4 segment switch, 10 MB | 273 / 328 | 560 / 599 FAIL | 317 / 347 pass | 272 / 302 pass |
| G9 file-map phase of the open p50, 10 MB (budget 20 ms) | | 15.3 pass | 7.96 pass | 6.84 pass |
| G9 table blocks written by the G1 sync, 10 MB (p50 / max; p50 must be 0) | | 0 / 1 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 10 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |
| data directory at 100 MB | | 254.2 MiB | | |
| G1 sync, one-row UPDATE, 100 MB | 159 / 177 | 1.70 / 5.00 pass | 1.62 / 3.82 pass | 1.64 / 9.80 pass |
| G1b sync, one 4 KB insert, 100 MB | 746 / 790 | 2.30 / 3.18 pass | 2.40 / 3.52 pass | 3.86 / 5.36 pass |
| G2 open, 100 MB | 1,286 / 1,366 | 2,044 / 2,107 FAIL | 1,285 / 1,348 pass | 1,187 / 1,250 pass |
| G4 segment switch, 100 MB | 809 / 850 | 618 / 645 FAIL | 328 / 369 pass | 273 / 312 pass |
| G9 file-map phase of the open p50, 100 MB (budget 75 ms) | | 42.3 pass | 13.7 pass | 10.4 pass |
| G9 table blocks written by the G1 sync, 100 MB (p50 / max; p50 must be 0) | | 0 / 2 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 100 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |

G5 unit size (smallest passing G2): 10 MB run 8192, 100 MB run 32768.

G6: aesGcm:true, hkdfDeriveKeyToAesGcm:true, unwrapKeyRawIntoHkdf:true, idbDurability_strict:strict, idbDurability_relaxed:relaxed, idbNumberKeysOrderedFirst:true, idbStringKeyRangeGetAll:true, idb2048PutsThen2048DeletesMs:puts:330.16,deletes:153.98.

G8: 366 live salts after 365 sessions x deriveKey p50 0.1 ms = 36.6 ms (budget 150 ms): pass. The year run took 268 s; 7252 live records. deriveKey x1000 p50 0.06 ms.

AES-GCM over 100 MB, MB/s encrypt / decrypt: 8k: 202 / 274, 32k: 642 / 720, 64k: 1189 / 1348.

### webkit

User agent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15`

| Measure (p50 / p95 ms unless noted) | plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|
| data directory at 10 MB | | 64.7 MiB | | |
| G1 sync, one-row UPDATE, 10 MB | 109 / 123 | 0.40 / 0.98 pass | 0.40 / 1.62 pass | 0.58 / 1.48 pass |
| G1b sync, one 4 KB insert, 10 MB | 108 / 122 | 0.66 / 0.78 pass | 0.86 / 1.04 pass | 1.26 / 1.40 pass |
| G2 open, 10 MB | 284 / 309 | 145 / 172 pass | 117 / 147 pass | 137 / 163 pass |
| G4 segment switch, 10 MB | 119 / 129 | 116 / 129 pass | 47.6 / 68.3 pass | 29.2 / 32.5 pass |
| G9 file-map phase of the open p50, 10 MB (budget 20 ms) | | 15.5 pass | 9.96 pass | 10.2 pass |
| G9 table blocks written by the G1 sync, 10 MB (p50 / max; p50 must be 0) | | 0 / 1 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 10 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |
| data directory at 100 MB | | 254.2 MiB | | |
| G1 sync, one-row UPDATE, 100 MB | 160 / 173 | 0.38 / 1.70 pass | 0.44 / 1.70 pass | 0.44 / 4.70 pass |
| G1b sync, one 4 KB insert, 100 MB | 273 / 412 | 0.66 / 1.00 pass | 0.92 / 1.22 pass | 1.02 / 1.28 pass |
| G2 open, 100 MB | 418 / 575 | 367 / 415 pass | 257 / 382 pass | 244 / 327 pass |
| G4 segment switch, 100 MB | 276 / 331 | 114 / 132 pass | 58.2 / 66.7 pass | 31.7 / 47.3 pass |
| G9 file-map phase of the open p50, 100 MB (budget 75 ms) | | 24.5 pass | 12.5 pass | 9.92 pass |
| G9 table blocks written by the G1 sync, 100 MB (p50 / max; p50 must be 0) | | 0 / 2 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 100 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |

G5 unit size (smallest passing G2): 10 MB run 8192, 100 MB run 8192.

G6: aesGcm:true, hkdfDeriveKeyToAesGcm:true, unwrapKeyRawIntoHkdf:true, idbDurability_strict:strict, idbDurability_relaxed:relaxed, idbNumberKeysOrderedFirst:true, idbStringKeyRangeGetAll:true, idb2048PutsThen2048DeletesMs:puts:61.56,deletes:43.9.

G8: 366 live salts after 365 sessions x deriveKey p50 0.06 ms = 21.96 ms (budget 150 ms): pass. The year run took 62 s; 7252 live records. deriveKey x1000 p50 0.04 ms.

AES-GCM over 100 MB, MB/s encrypt / decrypt: 8k: 476 / 2366, 32k: 963 / 4248, 64k: 1453 / 4726.

## Year simulation (G8)

365 open/edit/checkpoint/close sessions on the prototype at 8 KB: 366 live salts and 7,252 records in chromium (324 s); 366 live salts and 7,252 records in firefox (268 s); 366 live salts and 7,252 records in webkit (62 s).

## What only the owner can measure

- **G7, Rust store throughput.** Only inside a Tauri shell built with `encfs-bench` (needs the `journal/02` bench endpoints). Not measured on any target.
- **Tauri webviews.** WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux), each with the page as the shell frontend. Earlier Mac WebKit and WKWebView host runs from issue #11 are in `spike/results/` but are not part of this run.
- **iPhone and iPad** (Safari and the Tauri iOS shell): memory limits and IndexedDB behaviour on a device, G2 and G4 on the slowest phone.
- **Android** (Chrome and Android System WebView on the Redmi and other phones): G2 at 100 MB against the 3 s slowest-target budget, G3.
- **Real Safari** (not Playwright's build) and Windows.
- The shipped `src/` filesystem: no benchmark of it exists yet (see "What was measured").
