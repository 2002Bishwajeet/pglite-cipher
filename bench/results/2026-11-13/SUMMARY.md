# Benchmark results, 2026-11-13

Final benchmark on `main` at `2efe68f`, run as documented in `bench/README.md`: the benchmark page
(`bench/`) in headless Playwright through `spike/run.mjs`, parts `gates10,extras,gates100,year`,
20 runs per measure, p50 / p95. Raw JSON beside this file: `chromium.json`, `firefox.json`,
`webkit.json`.

**What was measured.** The page benchmarks the issue #2 prototype filesystem (`spike/protoFs.ts`)
against plain `idb://`, at 8, 32 and 64 KB units. It does not exercise the shipped `src/`
(`EncryptedFs`); `bench/README.md` documents no benchmark of `src/`. So these numbers re-check the
spike verdict on current dependencies and browsers; they are not a measurement of the released code.

**Node.** The page needs IndexedDB and a DOM, so it cannot run in Node. Node (v26.13.0) is only the
host that drives Playwright and Vite; no Node row exists.

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
other sessions share: timings are noisy (see "Noise" in `spike/RESULTS.md`), and a few cells moved
between this run and 2026-11-12 (for example Chromium G3 plain at 10 MB, 565 MB here against
315 MB). Chromium's G3 reads `performance.memory` (launched with `--enable-precise-memory-info`);
`measureUserAgentSpecificMemory` does not exist headless. Firefox and WebKit have no memory API
the page can use, so G3 is n/a there.

## Gates

Targets are `docs/plan/03-spike-prototype-benchmarks.md`, as restated by the owner on #3: G2 at
10 MB is "no worse than 2x plain `idb://`" only. "10 MB" and "100 MB" are the blob payload; the
data directory is 64.7 MiB and 254.2 MiB. Gates are judged on p50. The G1 and G1b cells use the
recommended unit of that engine's G5 at 100 MB; the G2, G3, G4 and G9 cells list every unit (8 / 32 /
64 KB). The per-unit tables below show every verdict.

Verdict by engine (recommended unit = G5 at 100 MB): Chromium passes G1, G1b, G2 (64 KB only),
G4, G6, G8, G9 and fails G3 at every unit. Firefox passes G1, G1b, G2 (32 and 64 KB), G6, G8, G9,
G4 at 32 and 64 KB (8 KB fails). WebKit passes every gate it can measure at every unit; G3 is
not measurable there. G7 is owner-only.

| Gate | Target | Chromium | Firefox | WebKit |
| --- | --- | --- | --- | --- |
| G1 sync, one-row UPDATE, 100 MB | enc p50 <= 2x plain | 0.98 ms vs 80.1 ms (64 KB): pass | 1.42 ms vs 149 ms (32 KB): pass | 0.42 ms vs 160 ms (8 KB): pass |
| G1b sync, one 4 KB insert, 100 MB | <= 2x plain, <= 1 table block | 1.65 ms vs 584 ms (64 KB); table blocks max 1: pass | 2.84 ms vs 752 ms (32 KB); table blocks max 1: pass | 0.70 ms vs 264 ms (8 KB); table blocks max 1: pass |
| G2 open, 10 MB (p50 ms) | <= 2x plain | plain 368 ms; 8 KB 980 FAIL, 32 KB 676 pass, 64 KB 461 pass | plain 640 ms; 8 KB 744 pass, 32 KB 586 pass, 64 KB 587 pass | plain 283 ms; 8 KB 144 pass, 32 KB 120 pass, 64 KB 142 pass |
| G2 open, 100 MB (p50 ms) | <= 2x plain and <= 1,500 ms | plain 707 ms; 8 KB 2,948 FAIL, 32 KB 1,646 FAIL, 64 KB 865 pass | plain 1,305 ms; 8 KB 2,033 FAIL, 32 KB 1,293 pass, 64 KB 1,188 pass | plain 416 ms; 8 KB 353 pass, 32 KB 236 pass, 64 KB 247 pass |
| G3 memory | open <= database + 64 MB | 100 MB: 8 KB 746 MB FAIL, 32 KB 702 MB FAIL, 64 KB 672 MB FAIL (plain idb 478 MB); 10 MB: 8 KB 443 MB FAIL, 32 KB 441 MB FAIL, 64 KB 560 MB FAIL (plain idb 565 MB) | not available (no memory API) | not available (no memory API) |
| G4 segment switch | <= 500 ms | 100 MB: 8 KB 180 ms pass, 32 KB 109 ms pass, 64 KB 80.4 ms pass; 10 MB: 186 pass, 106 pass, 80.7 pass (8/32/64 KB) | 100 MB: 8 KB 609 ms FAIL, 32 KB 335 ms pass, 64 KB 262 ms pass; 10 MB: 551 FAIL, 318 pass, 266 pass (8/32/64 KB) | 100 MB: 8 KB 117 ms pass, 32 KB 47.5 ms pass, 64 KB 36.1 ms pass; 10 MB: 103 pass, 41.8 pass, 29.0 pass (8/32/64 KB) |
| G5 unit size | smallest unit passing G2 | 10 MB: 32 KB; 100 MB: 64 KB | 10 MB: 8 KB; 100 MB: 32 KB | 10 MB: 8 KB; 100 MB: 8 KB |
| G6 support | all present | all present: pass | all present: pass | all present: pass |
| G7 Rust store throughput | recorded only | owner (Tauri only) | owner (Tauri only) | owner (Tauri only) |
| G8 subkeys | live salts x deriveKey <= 150 ms | 366 live salts x 0.01 ms = 3.66 ms: pass | 366 live salts x 0.12 ms = 43.9 ms: pass | 366 live salts x 0.04 ms = 14.6 ms: pass |
| G9 file table | file-map <= 5 % of G2 budget; G1 sync p50 writes no table block | file-map 26.3 / 15.8 / 9.29 ms at 100 MB (budget 75), 17.7 / 11.3 / 4.83 ms at 10 MB (budget 20); G1 sync table-block p50 0/0/0: pass | file-map 45.8 / 13.7 / 10.5 ms at 100 MB (budget 75), 16.2 / 7.24 / 7.24 ms at 10 MB (budget 20); G1 sync table-block p50 0/0/0: pass | file-map 25.1 / 12.7 / 9.72 ms at 100 MB (budget 75), 14.8 / 14.3 / 11.0 ms at 10 MB (budget 20); G1 sync table-block p50 0/0/0: pass |

## Per engine, every unit

### chromium

User agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.8127.18 Safari/537.36`

| Measure (p50 / p95 ms unless noted) | plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|
| data directory at 10 MB | | 64.7 MB | | |
| G1 sync, one-row UPDATE, 10 MB | 76.2 / 88.2 | 0.71 / 1.22 pass | 0.78 / 4.29 pass | 0.74 / 2.01 pass |
| G1b sync, one 4 KB insert, 10 MB | 122 / 133 | 0.81 / 1.21 pass | 1.42 / 1.86 pass | 2.00 / 2.52 pass |
| G2 open, 10 MB | 368 / 568 | 980 / 1,060 FAIL | 676 / 798 pass | 461 / 483 pass |
| G4 segment switch, 10 MB | 126 / 149 | 186 / 215 pass | 106 / 115 pass | 80.7 / 88.9 pass |
| G9 file-map phase of the open p50, 10 MB (budget 20 ms) |  | 17.7 pass | 11.3 pass | 4.83 pass |
| G9 table blocks written by the G1 sync, 10 MB (p50 / max; p50 must be 0) |  | 0 / 1 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 10 MB (budget: data + 64 MB) |  | 443 MB FAIL | 441 MB FAIL | 560 MB FAIL |
| data directory at 100 MB | | 254.2 MB | | |
| G1 sync, one-row UPDATE, 100 MB | 80.1 / 93.4 | 0.61 / 1.78 pass | 0.76 / 2.19 pass | 0.98 / 6.03 pass |
| G1b sync, one 4 KB insert, 100 MB | 584 / 619 | 0.93 / 1.28 pass | 1.39 / 2.12 pass | 1.65 / 2.33 pass |
| G2 open, 100 MB | 707 / 798 | 2,948 / 3,018 FAIL | 1,646 / 1,779 FAIL | 865 / 905 pass |
| G4 segment switch, 100 MB | 564 / 613 | 180 / 198 pass | 109 / 123 pass | 80.4 / 94.4 pass |
| G9 file-map phase of the open p50, 100 MB (budget 75 ms) |  | 26.3 pass | 15.8 pass | 9.29 pass |
| G9 table blocks written by the G1 sync, 100 MB (p50 / max; p50 must be 0) |  | 0 / 2 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 100 MB (budget: data + 64 MB) |  | 746 MB FAIL | 702 MB FAIL | 672 MB FAIL |

G5 unit size (smallest passing G2): 10 MB run 32768, 100 MB run 65536.

The page's strict G9 flag (`G9`, which also requires that no G1 sync wrote a table block at all): 8 KB: 10 MB FAIL, 100 MB FAIL; 32 KB: 10 MB FAIL, 100 MB FAIL; 64 KB: 10 MB FAIL, 100 MB FAIL.

G6: aesGcm:true, hkdfDeriveKeyToAesGcm:true, unwrapKeyRawIntoHkdf:true, idbDurability_strict:strict, idbDurability_relaxed:relaxed, idbNumberKeysOrderedFirst:true, idbStringKeyRangeGetAll:true, idb2048PutsThen2048DeletesMs:puts:129, deletes:120.49.

G8: 366 live salts after 365 sessions x deriveKey p50 0.01 ms = 3.66 ms (budget 150 ms): pass. The year run took 324 s; 7252 live records.

AES-GCM over 100 MB, MB/s encrypt / decrypt: 8k: 590 / 651, 32k: 1021 / 901, 64k: 1111 / 848.

### firefox

User agent: `Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0`

| Measure (p50 / p95 ms unless noted) | plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|
| data directory at 10 MB | | 64.7 MB | | |
| G1 sync, one-row UPDATE, 10 MB | 143 / 173 | 1.32 / 2.76 pass | 1.00 / 2.68 pass | 1.56 / 5.30 pass |
| G1b sync, one 4 KB insert, 10 MB | 191 / 232 | 1.96 / 2.52 pass | 2.28 / 3.48 pass | 3.30 / 5.36 pass |
| G2 open, 10 MB | 640 / 675 | 744 / 797 pass | 586 / 629 pass | 587 / 647 pass |
| G4 segment switch, 10 MB | 267 / 312 | 551 / 588 FAIL | 318 / 358 pass | 266 / 303 pass |
| G9 file-map phase of the open p50, 10 MB (budget 20 ms) |  | 16.2 pass | 7.24 pass | 7.24 pass |
| G9 table blocks written by the G1 sync, 10 MB (p50 / max; p50 must be 0) |  | 0 / 1 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 10 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |
| data directory at 100 MB | | 254.2 MB | | |
| G1 sync, one-row UPDATE, 100 MB | 149 / 174 | 1.56 / 3.50 pass | 1.42 / 6.00 pass | 2.50 / 8.14 pass |
| G1b sync, one 4 KB insert, 100 MB | 752 / 788 | 2.28 / 3.72 pass | 2.84 / 3.52 pass | 4.24 / 6.16 pass |
| G2 open, 100 MB | 1,305 / 1,362 | 2,033 / 2,108 FAIL | 1,293 / 1,347 pass | 1,188 / 1,272 pass |
| G4 segment switch, 100 MB | 782 / 851 | 609 / 636 FAIL | 335 / 376 pass | 262 / 315 pass |
| G9 file-map phase of the open p50, 100 MB (budget 75 ms) |  | 45.8 pass | 13.7 pass | 10.5 pass |
| G9 table blocks written by the G1 sync, 100 MB (p50 / max; p50 must be 0) |  | 0 / 2 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 100 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |

G5 unit size (smallest passing G2): 10 MB run 8192, 100 MB run 32768.

The page's strict G9 flag (`G9`, which also requires that no G1 sync wrote a table block at all): 8 KB: 10 MB FAIL, 100 MB FAIL; 32 KB: 10 MB FAIL, 100 MB FAIL; 64 KB: 10 MB FAIL, 100 MB FAIL.

G6: aesGcm:true, hkdfDeriveKeyToAesGcm:true, unwrapKeyRawIntoHkdf:true, idbDurability_strict:strict, idbDurability_relaxed:relaxed, idbNumberKeysOrderedFirst:true, idbStringKeyRangeGetAll:true, idb2048PutsThen2048DeletesMs:puts:316.6, deletes:164.8.

G8: 366 live salts after 365 sessions x deriveKey p50 0.12 ms = 43.92 ms (budget 150 ms): pass. The year run took 268 s; 7252 live records.

AES-GCM over 100 MB, MB/s encrypt / decrypt: 8k: 202 / 274, 32k: 640 / 693, 64k: 1156 / 1205.

### webkit

User agent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15`

| Measure (p50 / p95 ms unless noted) | plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|
| data directory at 10 MB | | 64.7 MB | | |
| G1 sync, one-row UPDATE, 10 MB | 101 / 110 | 0.36 / 0.88 pass | 0.38 / 1.54 pass | 0.52 / 1.32 pass |
| G1b sync, one 4 KB insert, 10 MB | 107 / 112 | 0.64 / 0.82 pass | 0.88 / 1.02 pass | 1.24 / 1.46 pass |
| G2 open, 10 MB | 283 / 329 | 144 / 152 pass | 120 / 123 pass | 142 / 179 pass |
| G4 segment switch, 10 MB | 116 / 122 | 103 / 108 pass | 41.8 / 46.8 pass | 29.0 / 39.1 pass |
| G9 file-map phase of the open p50, 10 MB (budget 20 ms) |  | 14.8 pass | 14.3 pass | 11.0 pass |
| G9 table blocks written by the G1 sync, 10 MB (p50 / max; p50 must be 0) |  | 0 / 1 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 10 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |
| data directory at 100 MB | | 254.2 MB | | |
| G1 sync, one-row UPDATE, 100 MB | 160 / 168 | 0.42 / 1.50 pass | 0.36 / 1.50 pass | 0.42 / 3.04 pass |
| G1b sync, one 4 KB insert, 100 MB | 264 / 322 | 0.70 / 1.08 pass | 0.80 / 0.98 pass | 0.96 / 1.34 pass |
| G2 open, 100 MB | 416 / 456 | 353 / 417 pass | 236 / 286 pass | 247 / 304 pass |
| G4 segment switch, 100 MB | 274 / 288 | 117 / 131 pass | 47.5 / 62.2 pass | 36.1 / 46.1 pass |
| G9 file-map phase of the open p50, 100 MB (budget 75 ms) |  | 25.1 pass | 12.7 pass | 9.72 pass |
| G9 table blocks written by the G1 sync, 100 MB (p50 / max; p50 must be 0) |  | 0 / 2 pass | 0 / 1 pass | 0 / 1 pass |
| G3 peak memory, 100 MB (budget: data + 64 MB) |  | n/a not available | n/a not available | n/a not available |

G5 unit size (smallest passing G2): 10 MB run 8192, 100 MB run 8192.

The page's strict G9 flag (`G9`, which also requires that no G1 sync wrote a table block at all): 8 KB: 10 MB FAIL, 100 MB FAIL; 32 KB: 10 MB FAIL, 100 MB FAIL; 64 KB: 10 MB FAIL, 100 MB FAIL.

G6: aesGcm:true, hkdfDeriveKeyToAesGcm:true, unwrapKeyRawIntoHkdf:true, idbDurability_strict:strict, idbDurability_relaxed:relaxed, idbNumberKeysOrderedFirst:true, idbStringKeyRangeGetAll:true, idb2048PutsThen2048DeletesMs:puts:63.2, deletes:45.

G8: 366 live salts after 365 sessions x deriveKey p50 0.04 ms = 14.64 ms (budget 150 ms): pass. The year run took 64 s; 7252 live records.

AES-GCM over 100 MB, MB/s encrypt / decrypt: 8k: 491 / 2523, 32k: 995 / 4371, 64k: 1518 / 4840.


## Year simulation (G8)

365 open/edit/checkpoint/close sessions on the prototype at 8 KB: 366 distinct live session
salts and 7,252 live records at the end in every engine. Chromium took 324 s, Firefox 268 s,
WebKit 64 s.

## What only the owner can measure

- **G7, Rust store throughput.** Only inside a Tauri shell built with `encfs-bench` (needs the
  `journal/02` bench endpoints). Not measured on any target.
- **Tauri webviews.** WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux), each with the page
  as the shell frontend. Earlier Mac WebKit and WKWebView host runs from issue #11 are in
  `spike/results/` but are not part of this run.
- **iPhone and iPad** (Safari and the Tauri iOS shell): memory limits and IndexedDB behaviour on a
  device, G2 and G4 on the slowest phone.
- **Android** (Chrome and Android System WebView on the Redmi and other phones): G2 at 100 MB
  against the 3 s slowest-target budget, G3.
- **Real Safari** (not Playwright's build) and Windows.
- The shipped `src/` filesystem: no benchmark of it exists yet (see "What was measured").
