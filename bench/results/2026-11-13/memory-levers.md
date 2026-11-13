# Memory levers: WAL size, `shared_buffers`, `initialMemory` (issue #48)

Measured on 2026-11-13 with the bench page's `levers10` and `levers100` parts (`bench/bench.ts`, `bench/measure.ts`): `node bench/run.mjs chromium firefox --parts levers10,levers100 --runs 10`, then `node bench/run.mjs chromium --parts levers100 --runs 20` as a repeat. The page builds the gates database (10 MB or 100 MB of 1 MB blobs, then a `CHECKPOINT`) on plain `idb://` and on `EncryptedFs` and runs G1, G1b, G2 and G4 the way the gates part does, once per lever. Raw JSON beside this file: `memory-levers-chromium.json`, `memory-levers-firefox.json`, `memory-levers-chromium-100mb-runs20.json`.

**Machine:** yantra-box mini PC, Intel Core i5-9500T (6 threads), 14 GiB, Debian (kernel 7.2.11), Chromium 158.0.8127.18 and Firefox 159.0 headless (Playwright 1.65.0), PGlite 0.5.10. It is slower than the machine in `SUMMARY.md`, so compare levers with each other here, not with that file. WebKit was not run (Linux host); the sizes below do not depend on the engine (they are identical in Chromium and Firefox).

**What is measured.** The data directory is the sum of file sizes under `/pglite/data`, per top-level directory: right before the build's `CHECKPOINT`, right after it, and after the last of the G2 opens (after the G1, G1b and G4 workload). On `idb://` and on `EncryptedFs` that whole directory sits in memory (MEMFS; `docs/research/opfs-on-demand.md` 1.1). The wasm memory is `HEAPU8.byteLength`: for an empty in-memory instance, after the build, and after the last open. It is the reserved linear memory, not resident memory: pages Postgres never touches may not count against RSS or the iOS footprint **[unverified: RSS not measured here]**. MB = 2^20 bytes.

## The levers

| Lever | Postgres settings (`startParams`, read back with `current_setting`) |
|---|---|
| `default` | `shared_buffers` 128 MB, `min_wal_size` 80 MB, `max_wal_size` 1 GB, segments 16 MB |
| `wal` | `min_wal_size=32MB`, `max_wal_size=32MB` (the least allowed: two 16 MB segments) |
| `sb32` | `shared_buffers=32MB` |
| `sb16` | `shared_buffers=16MB` |
| `wal+sb16` | both |

**`initialMemory` cannot go lower.** PGlite 0.5.10's wasm module declares 2048 pages (128 MB) as its initial memory. With `initialMemory: 32 * 1024 * 1024` instantiation fails ("memory import has 512 pages which is smaller than the declared initial of 2048") and `PGlite.create` never settles; it does not reject. 128 MB, the default, is therefore the floor, and with `shared_buffers` at 32 MB or less this workload never grows past it.

## Sizes (the same in both engines and every run)

| Size | Lever | Data directory before `CHECKPOINT` (pg_wal) | after (pg_wal) | after the last open (pg_wal) | base | wasm memory: empty / after build / after open |
|---|---|---|---|---|---|---|
| 10 MB | default | 64.7 (32.0) | 64.7 (32.0) | 64.8 (32.0) | 32.1 | 188.8 / 226.5 / 188.8 |
| 10 MB | wal | 64.7 (32.0) | 64.7 (32.0) | 64.8 (32.0) | 32.1 | 188.8 / 226.5 / 188.8 |
| 10 MB | sb32, sb16 | 64.7 (32.0) | 64.7 (32.0) | 64.8 (32.0) | 32.1 | 128.0 / 128.0 / 128.0 |
| 10 MB | wal+sb16 | 64.7 (32.0) | 64.7 (32.0) | 64.8 (32.0) | 32.1 | 128.0 / 128.0 / 128.0 |
| 100 MB | default | 254.2 (128.0) | 254.2 (128.0) | 206.4 to 238.3 (80 to 112) | 125.6 | 188.8 / 226.5 / 188.8 |
| 100 MB | wal | 254.2 (128.0) | **158.2 (32.0)** | 158.3 (32.0) | 125.6 | 188.8 / 226.5 / 188.8 |
| 100 MB | sb32, sb16 | 254.2 (128.0) | 254.2 (128.0) | 206.4 to 238.3 (80 to 112) | 125.6 | **128.0 / 128.0 / 128.0** |
| 100 MB | wal+sb16 | 254.2 (128.0) | **158.2 (32.0)** | 158.3 (32.0) | 125.6 | **128.0 / 128.0 / 128.0** |

Plain and encrypted have the same sizes (they hold the same Postgres files). Everything besides `base` and `pg_wal` is about 0.6 MB (`global`, `pg_xact`, ...). After the last open the default's `pg_wal` depends on how many segments the G4 checkpoints removed (112 MB in the 10-run pass, 80 MB in the 20-run repeat).

## Gates (p50 ms; ratios as the perf gates compute them)

| Engine, size | Lever | G1 plain / enc | G2 plain / enc | G4 enc | G1 ratio (≤ 2) | G2 ratio (≤ 2) | G4 ratio (≤ 10) |
|---|---|---|---|---|---|---|---|
| Chromium, 10 MB | default | 55.6 / 4.80 | 312 / 481 | 95.6 | 0.09 | 1.54 | 1.72 |
| Chromium, 10 MB | wal | 56.1 / 4.72 | 316 / 469 | 98.5 | 0.08 | 1.48 | 1.76 |
| Chromium, 10 MB | sb32 | 56.6 / 4.69 | 303 / 469 | 98.2 | 0.08 | 1.55 | 1.74 |
| Chromium, 10 MB | sb16 | 55.9 / 4.62 | 297 / 468 | 98.7 | 0.08 | 1.58 | 1.77 |
| Chromium, 10 MB | wal+sb16 | 59.0 / 4.66 | 291 / 454 | 94.6 | 0.08 | 1.56 | 1.60 |
| Chromium, 100 MB | default | 56.1 / 4.92 | 574 / 1,030 | 96.6 | 0.09 | 1.79 | 1.72 |
| Chromium, 100 MB | wal | 55.6 / 5.06 | 457 / 822 | 101 | 0.09 | 1.80 | 1.82 |
| Chromium, 100 MB | sb32 | 54.5 / 5.10 | 516 / 1,099 | 98.0 | 0.09 | **2.13** | 1.80 |
| Chromium, 100 MB | sb16 | 56.5 / 5.16 | 508 / 1,047 | 102 | 0.09 | **2.06** | 1.81 |
| Chromium, 100 MB | wal+sb16 | 56.7 / 5.03 | 450 / 794 | 104 | 0.09 | 1.76 | 1.83 |
| Chromium, 100 MB, 20 runs | default | 78.7 / 6.86 | 744 / 1,066 | 136 | 0.09 | 1.43 | 1.73 |
| Chromium, 100 MB, 20 runs | wal | 55.8 / 4.78 | 458 / 825 | 107 | 0.09 | 1.80 | 1.93 |
| Chromium, 100 MB, 20 runs | sb32 | 55.3 / 5.07 | 489 / 949 | 102 | 0.09 | 1.94 | 1.85 |
| Chromium, 100 MB, 20 runs | sb16 | 55.5 / 4.88 | 481 / 939 | 103 | 0.09 | 1.95 | 1.85 |
| Chromium, 100 MB, 20 runs | wal+sb16 | 54.7 / 4.69 | 449 / 805 | 105 | 0.09 | 1.79 | 1.92 |
| Firefox, 10 MB | default | 91.7 / 5.74 | 441 / 483 | 269 | 0.06 | 1.09 | 2.93 |
| Firefox, 10 MB | wal | 89.8 / 5.62 | 440 / 495 | 268 | 0.06 | 1.12 | 2.98 |
| Firefox, 10 MB | sb32 | 89.6 / 6.04 | 424 / 485 | 265 | 0.07 | 1.14 | 2.95 |
| Firefox, 10 MB | sb16 | 90.1 / 5.82 | 422 / 478 | 266 | 0.06 | 1.13 | 2.95 |
| Firefox, 10 MB | wal+sb16 | 97.1 / 5.66 | 421 / 471 | 272 | 0.06 | 1.12 | 2.81 |
| Firefox, 100 MB | default | 113 / 9.64 | 1,600 / 1,659 | 438 | 0.09 | 1.04 | 3.87 |
| Firefox, 100 MB | wal | 113 / 8.26 | 1,091 / 1,234 | 427 | 0.07 | 1.13 | 3.79 |
| Firefox, 100 MB | sb32 | 124 / 13.8 | 1,337 / 1,421 | 403 | 0.11 | 1.06 | 3.26 |
| Firefox, 100 MB | sb16 | 106 / 10.6 | 1,398 / 1,329 | 354 | 0.10 | 0.95 | 3.35 |
| Firefox, 100 MB | wal+sb16 | 109 / 10.1 | 1,098 / 1,030 | 380 | 0.09 | 0.94 | 3.48 |

The default 100 MB row of the 20-run repeat is slower across the board, plain and encrypted alike (the machine was busier at its start); its ratios are not comparable to the others. Build times did not change with any lever (Chromium 100 MB: 22.4 to 23.3 s encrypted in the 10-run pass).

## What each lever saves and costs

- **WAL: lower `min_wal_size`/`max_wal_size` and `CHECKPOINT` after bulk work.** At 100 MB it takes `pg_wal` from 128 MB to 32 MB after the checkpoint, and the data directory from 254.2 MB to 158.2 MB: **96 MB less in memory** (38 %). The open is faster too, since there is less to load and decrypt: encrypted G2 1,030 to 822 ms (Chromium), 1,659 to 1,234 ms (Firefox). G1 and G4 do not change. At 10 MB nothing changes: `pg_wal` already holds only two segments. Both halves are needed:
  - The settings alone do nothing until a checkpoint. Before the build's `CHECKPOINT`, `pg_wal` is 128 MB with every lever: in PGlite's single-user mode `max_wal_size` did not trigger a checkpoint during the 100 MB build.
  - The `CHECKPOINT` alone does nothing with the default settings (128 MB before and after): Postgres recycles the old segments instead of removing them.
- **`shared_buffers` 32 MB or 16 MB.** The wasm memory stays at its 128 MB floor: **61 MB less after an open** (188.8 to 128.0 MB) and 98 MB less after the build (226.5 to 128.0 MB); wasm memory never shrinks while the instance lives. The data directory does not change. G1 and G4 do not change, and the encrypted open stays about the same (Chromium 939 to 1,099 ms against 1,030 to 1,066 ms; Firefox 1,329 to 1,421 ms against 1,659 ms). But the plain open gets faster, so in Chromium at 100 MB the G2 **ratio** came out at 2.13 (sb32) and 2.06 (sb16) in the 10-run pass and 1.94 and 1.95 in the 20-run repeat: next to the gate of 2. Postgres also caches less: a working set over 16 MB is read again from MEMFS (in memory too), which this workload does not exercise.
- **Both (`wal+sb16`).** The two savings add up: 96 MB of data directory and 61 MB of wasm memory at 100 MB, about 157 MB, and every gate passes with room in both engines and both runs (G2 ratio 1.76 and 1.79 in Chromium, 0.94 in Firefox).
- **`initialMemory`:** no lever; it cannot go below 128 MB (above).

**Durability.** None of these touches `fsync`, `full_page_writes` or `synchronous_commit`. Small WAL settings make checkpoints more frequent and keep fewer spare segments; `shared_buffers` is a cache. No lever here weakens durability, so issue #48's STOP condition does not apply.

## What the library does with it

The library does not create the PGlite instance, so it has no defaults to change and no new option. The README section "Running on mobile" recommends `wal+sb16` and the checkpoint after bulk work, with these numbers.
