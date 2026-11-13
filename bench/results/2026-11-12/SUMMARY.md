# Benchmark results, 2026-11-12

Final benchmark on `main` at `c5ea74b`, run as documented in `bench/README.md`: the benchmark page
(`bench/`) in headless Playwright through `spike/run.mjs`, parts `gates10,extras,gates100,year`,
20 runs per measure, p50 / p95. Raw JSON beside this file: `chromium.json`, `firefox.json`,
`webkit.json`.

**What was measured.** The page benchmarks the issue #2 prototype filesystem (`spike/protoFs.ts`)
against plain `idb://`, at 8, 32 and 64 KB units. It does not exercise the shipped `src/`
(`EncryptedFs`); `bench/README.md` documents no benchmark of `src/`, and the CI benchmark gates of
`docs/plan/11-bench-fuzz-ci-gates.md` are not on `main`. So these numbers re-check the spike
verdict on current dependencies and browsers; they are not a measurement of the released code.

**Node.** The page needs IndexedDB and a DOM, so it cannot run in Node. Node is the host that
drives Playwright and Vite (v26.13.0); no Node row exists.

## Environment

| | Chromium, Firefox | WebKit |
| --- | --- | --- |
| Machine | ROG G14 (host `CachyOs-G14`), shared with other harness jobs, heavy lock held | MacBook Pro, run through `scripts/harness/webkit.sh` (the Mac path; the podman fallback was not used) |
| CPU | AMD Ryzen 5 4600HS (12 threads) | Apple M1 Pro |
| RAM | 15 GiB | 16 GiB |
| OS | CachyOS Linux, kernel 7.3.0-4-cachyos | macOS 27.0.1 |
| Browser | Chromium 158.0.8127.18 (headless), Firefox 159.0 (Playwright build, headless) | Playwright WebKit, `Version/27.2 Safari/605.1.15`, headless. Not Safari, not WKWebView |
| Playwright | 1.65.0 | 1.65.0 |
| PGlite | 0.5.10 | 0.5.10 |

WebKit ran on different, faster hardware than the other two. Compare plain against encrypted
within one engine, never absolute times across engines. Chromium and Firefox ran on a machine that
other sessions share: timings are noisy (see "Noise" in `spike/RESULTS.md`); relative numbers
within one engine's run are stable. Chromium's G3 reads `performance.memory` (launched with
`--enable-precise-memory-info`); `measureUserAgentSpecificMemory` does not exist headless.

## Gates

Targets are `docs/plan/03-spike-prototype-benchmarks.md`, as restated by the owner on #3: G2 at
10 MB is "no worse than 2x plain `idb://`" only. "10 MB" and "100 MB" are the blob payload; the
data directory is 64.7 MiB and 254.2 MiB. Gates are judged on p50. Pass is for the recommended
unit of that run's G5, which the pass/fail column of the per-unit tables below shows for every
unit.

| Gate | Target | Chromium | Firefox | WebKit |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE, 100 MB | encrypted p50 <= 2x plain | 0.72 ms vs 71.9 ms: pass | 1.58 ms vs 150 ms: pass | 0.44 ms vs 157 ms: pass |
| G1b sync, one 4 KB insert, 1 table block, 100 MB | <= 2x plain, <= 1 table block | 1.63 ms vs 586 ms: pass | 3.34 ms vs 748 ms: pass | 1.02 ms vs 269 ms: pass |
| G2 open, 10 MB | <= 2x plain | 414 vs 357 ms: pass (64 KB); 8 KB FAIL (967) | 592 vs 639 ms: pass (all units) | 139 vs 279 ms: pass (all units) |
| G2 open, 100 MB | <= 2x plain and <= 1,500 ms | 849 vs 663 ms: pass (64 KB only) | 1,144 vs 1,317 ms: pass (32 and 64 KB) | 238 vs 392 ms: pass (all units) |
| G3 memory | open <= database + 64 MB | FAIL: 683 MB at 100 MB, 518 MB at 10 MB (plain idb: 477 and 315 MB) | not available | not available |
| G4 segment switch | <= 500 ms | 80.3 ms (100 MB): pass, all units | 279 ms: pass at 32 and 64 KB; 8 KB FAIL (613, 566) | 32.0 ms: pass, all units |
| G5 unit size | smallest unit passing G2 | 64 KB (32 KB at 10 MB) | 32 KB (8 KB at 10 MB) | 8 KB |
| G6 support | all present | pass | pass | pass |
| G7 Rust store throughput | recorded only | owner (Tauri only) | owner | owner |
| G8 subkeys | live salts x deriveKey <= 150 ms | 366 x 0.01 ms = 3.7 ms: pass | 366 x 0.04 ms = 14.6 ms: pass | 366 x 0.06 ms = 22.0 ms: pass |
| G9 file table | file-map phase <= 5 % of the G2 budget (20 ms at 10 MB, 75 ms at 100 MB); G1 sync p50 writes no table block | pass at every unit (13.0 ms at 64 KB, 100 MB; 1 table block in at most 2 G1 syncs) | pass at every unit | pass at every unit |

Differences from the spike write-up (`spike/RESULTS.md`): this run's WebKit was the Mac's, not the
Linux container, so plain `idb://` is much faster there and WebKit now passes G2 at 8 KB. G3 fails
as before, and plain `idb://` also uses 315-477 MB in Chromium. G4 at 8 KB fails in Firefox as before.

## Per engine, every unit

p50 / p95 ms unless noted. The mark beside each encrypted cell is the page's own verdict for that
unit (`gates` in the JSON). The page's strict G9 flag (`G9`) also requires that no G1 sync wrote a
table block; in 1 to 2 of 20 syncs a file grew (a GIN pending-list or free-space-map page) and one
table block was written. The table shows the file-map and G1 p50 halves of it, which pass; no sync
that changed no file wrote a table block (`tableBlocksWithoutFileChange`).

### chromium

User agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.8127.18 Safari/537.36`

| Measure (p50 / p95 ms unless noted) | plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|
| data directory at 10 MB | | 64.7 MB | | |
| G1 sync, one-row UPDATE, 10 MB | 68.8 / 126 | 0.56 / 0.92 pass | 0.79 / 2.46 pass | 0.69 / 1.45 pass |
| G1b sync, one 4 KB insert, 10 MB | 111 / 134 | 0.92 / 1.20 pass | 1.34 / 1.89 pass | 2.08 / 3.03 pass |
| G2 open, 10 MB | 357 / 448 | 967 / 1,008 FAIL | 654 / 709 pass | 414 / 468 pass |
| G4 segment switch, 10 MB | 128 / 156 | 176 / 196 pass | 105 / 112 pass | 81.3 / 96.0 pass |
| G9 file-map phase of the open p50, 10 MB (budget 20 ms) |  | 15.8 pass | 15.0 pass | 13.4 pass |
| G9 table blocks written by the G1 sync, 10 MB (p50 / max; p50 must be 0) |  | 0 / 1 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 10 MB (budget: data + 64 MB) |  | 415 MB FAIL | 452 MB FAIL | 518 MB FAIL |
| data directory at 100 MB | | 254.2 MB | | |
| G1 sync, one-row UPDATE, 100 MB | 71.9 / 94.3 | 0.90 / 3.06 pass | 0.86 / 2.63 pass | 0.72 / 2.34 pass |
| G1b sync, one 4 KB insert, 100 MB | 586 / 613 | 0.95 / 1.65 pass | 1.55 / 2.02 pass | 1.63 / 2.63 pass |
| G2 open, 100 MB | 663 / 749 | 2,860 / 2,959 FAIL | 1,602 / 1,768 FAIL | 849 / 869 pass |
| G4 segment switch, 100 MB | 569 / 682 | 184 / 200 pass | 104 / 118 pass | 80.3 / 93.3 pass |
| G9 file-map phase of the open p50, 100 MB (budget 75 ms) |  | 29.1 pass | 14.7 pass | 13.0 pass |
| G9 table blocks written by the G1 sync, 100 MB (p50 / max; p50 must be 0) |  | 0 / 2 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 100 MB (budget: data + 64 MB) |  | 640 MB FAIL | 689 MB FAIL | 683 MB FAIL |

G5 unit size (smallest passing G2): 10 MB run 32768, 100 MB run 65536.

G6: pass (aesGcm=True, hkdfDeriveKeyToAesGcm=True, unwrapKeyRawIntoHkdf=True, idbDurability_strict=strict, idbDurability_relaxed=relaxed, idbNumberKeysOrderedFirst=True, idbStringKeyRangeGetAll=True; 2,048 puts 136.89 ms, 2,048 deletes 112.06 ms).

G8: 366 live salts after 365 sessions x deriveKey p50 0.01 ms = 3.66 ms (budget 150 ms): pass.

AES-GCM over 100 MB, MB/s encrypt / decrypt: 8k: 599 / 656, 32k: 979 / 936, 64k: 1127 / 938.

### firefox

User agent: `Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0`

| Measure (p50 / p95 ms unless noted) | plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|
| data directory at 10 MB | | 64.7 MB | | |
| G1 sync, one-row UPDATE, 10 MB | 155 / 171 | 1.30 / 2.86 pass | 1.46 / 3.92 pass | 2.06 / 2.66 pass |
| G1b sync, one 4 KB insert, 10 MB | 184 / 221 | 2.06 / 2.54 pass | 2.90 / 3.86 pass | 3.78 / 6.56 pass |
| G2 open, 10 MB | 639 / 692 | 737 / 819 pass | 578 / 609 pass | 592 / 665 pass |
| G4 segment switch, 10 MB | 251 / 299 | 566 / 612 FAIL | 318 / 357 pass | 263 / 297 pass |
| G9 file-map phase of the open p50, 10 MB (budget 20 ms) |  | 14.9 pass | 7.94 pass | 7.00 pass |
| G9 table blocks written by the G1 sync, 10 MB (p50 / max; p50 must be 0) |  | 0 / 1 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 10 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |
| data directory at 100 MB | | 254.2 MB | | |
| G1 sync, one-row UPDATE, 100 MB | 150 / 183 | 1.56 / 3.10 pass | 1.74 / 5.08 pass | 1.58 / 8.36 pass |
| G1b sync, one 4 KB insert, 100 MB | 748 / 788 | 2.36 / 3.12 pass | 12.4 / 30.9 pass | 3.34 / 4.80 pass |
| G2 open, 100 MB | 1,317 / 1,405 | 2,054 / 2,124 FAIL | 1,225 / 1,528 pass | 1,144 / 1,239 pass |
| G4 segment switch, 100 MB | 799 / 839 | 613 / 645 FAIL | 343 / 398 pass | 279 / 339 pass |
| G9 file-map phase of the open p50, 100 MB (budget 75 ms) |  | 43.1 pass | 13.8 pass | 9.98 pass |
| G9 table blocks written by the G1 sync, 100 MB (p50 / max; p50 must be 0) |  | 0 / 2 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 100 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |

G5 unit size (smallest passing G2): 10 MB run 8192, 100 MB run 32768.

G6: pass (aesGcm=True, hkdfDeriveKeyToAesGcm=True, unwrapKeyRawIntoHkdf=True, idbDurability_strict=strict, idbDurability_relaxed=relaxed, idbNumberKeysOrderedFirst=True, idbStringKeyRangeGetAll=True; 2,048 puts 318.06 ms, 2,048 deletes 155.96 ms).

G8: 366 live salts after 365 sessions x deriveKey p50 0.04 ms = 14.64 ms (budget 150 ms): pass.

AES-GCM over 100 MB, MB/s encrypt / decrypt: 8k: 201 / 277, 32k: 647 / 707, 64k: 1153 / 1257.

### webkit

User agent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15`

| Measure (p50 / p95 ms unless noted) | plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|
| data directory at 10 MB | | 64.7 MB | | |
| G1 sync, one-row UPDATE, 10 MB | 103 / 111 | 0.38 / 0.88 pass | 0.40 / 1.46 pass | 0.44 / 1.28 pass |
| G1b sync, one 4 KB insert, 10 MB | 105 / 110 | 0.72 / 0.94 pass | 0.86 / 0.96 pass | 1.14 / 1.30 pass |
| G2 open, 10 MB | 279 / 294 | 144 / 162 pass | 120 / 131 pass | 139 / 155 pass |
| G4 segment switch, 10 MB | 116 / 120 | 110 / 152 pass | 42.6 / 50.5 pass | 29.2 / 37.6 pass |
| G9 file-map phase of the open p50, 10 MB (budget 20 ms) |  | 14.8 pass | 12.3 pass | 13.5 pass |
| G9 table blocks written by the G1 sync, 10 MB (p50 / max; p50 must be 0) |  | 0 / 1 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 10 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |
| data directory at 100 MB | | 254.2 MB | | |
| G1 sync, one-row UPDATE, 100 MB | 157 / 172 | 0.34 / 1.04 pass | 0.36 / 1.48 pass | 0.44 / 3.04 pass |
| G1b sync, one 4 KB insert, 100 MB | 269 / 322 | 0.64 / 0.96 pass | 0.82 / 1.08 pass | 1.02 / 1.26 pass |
| G2 open, 100 MB | 392 / 416 | 349 / 385 pass | 247 / 354 pass | 238 / 311 pass |
| G4 segment switch, 100 MB | 266 / 308 | 115 / 127 pass | 53.1 / 76.6 pass | 32.0 / 37.6 pass |
| G9 file-map phase of the open p50, 100 MB (budget 75 ms) |  | 28.4 pass | 13.8 pass | 9.66 pass |
| G9 table blocks written by the G1 sync, 100 MB (p50 / max; p50 must be 0) |  | 0 / 2 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 100 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |

G5 unit size (smallest passing G2): 10 MB run 8192, 100 MB run 8192.

G6: pass (aesGcm=True, hkdfDeriveKeyToAesGcm=True, unwrapKeyRawIntoHkdf=True, idbDurability_strict=strict, idbDurability_relaxed=relaxed, idbNumberKeysOrderedFirst=True, idbStringKeyRangeGetAll=True; 2,048 puts 64.36 ms, 2,048 deletes 44.32 ms).

G8: 366 live salts after 365 sessions x deriveKey p50 0.06 ms = 21.96 ms (budget 150 ms): pass.

AES-GCM over 100 MB, MB/s encrypt / decrypt: 8k: 474 / 2432, 32k: 1004 / 4409, 64k: 1494 / 4840.


## Year simulation (G8)

365 open/edit/checkpoint/close sessions on the prototype at 8 KB: 366 distinct live session
salts and 7,252 live records at the end in every engine. Chromium took 315 s, in the log.

## What only the owner can measure

- **G7, Rust store throughput.** Only inside a Tauri shell built with `encfs-bench` (needs the
  `journal/02` bench endpoints). Not measured on any target.
- **Tauri webviews.** WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux), each with the page
  as the shell frontend. The Mac's Playwright WebKit and the WKWebView host runs from issue #11 are
  in `spike/results/` but are not part of this run.
- **iPhone and iPad** (Safari and the Tauri iOS shell): memory limits and IndexedDB behaviour on a
  device, G2 and G4 on the slowest phone.
- **Android** (Chrome and Android System WebView on the Redmi and other phones): G2 at 100 MB
  against the 3 s slowest-target budget, G3.
- **Real Safari** (not Playwright's build) and Windows.
- The shipped `src/` filesystem: no benchmark of it exists yet (see "What was measured").
