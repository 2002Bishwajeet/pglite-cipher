# pglite-cipher harness run, 2026-11-11

Base: `origin/main` at 76056c2. Written from the harness facts plus `gh` and `git`; CI was not waited on.

## Summary

The run delivered the scaffold (#1), the dirty-block tracker (#6) and one checkpoint review (#14). It stopped at #2, the spike, on a trace finding that needs an owner decision about the file-table layout of format v1. Eight issues were skipped because they depend on #2 directly or through a chain. The benchmark step did not run: there is no benchmark page or script yet, and so there are no gate numbers.

| Item | Result |
|---|---|
| Merged PRs | 3 (#12, #13, #14) |
| Closed issues | 2 (#1, #6) |
| Stopped | 1 (#2, label `blocked`) |
| Skipped, waiting | 8 (see below) |
| Checkpoints | 1 |
| Benchmark gates measured | 0 of 9 |

## What shipped

### #1 Scaffold (PR #12, https://github.com/2002Bishwajeet/pglite-cipher/pull/12)

TypeScript build, vitest projects for Node, Chromium, Firefox and WebKit, ESLint strict type-checked, CI, LICENSE placeholder, AGENTS.md, README sections. The smoke test passed in all four environments on the harness machine. Local checks (build, typecheck, lint, Node tests, Chromium and Firefox, WebKit through the container, actionlint, a scratch Vite consumer) all exited 0.

Deviations recorded in the PR:

1. The issue body is older than `docs/plan/02-scaffold.md` (self-hosted runner versus Playwright container). The plan was followed: every CI job runs on `[self-hosted, yantra-box]`.
2. `typescript` is ~6.0.3 because typescript-eslint requires `<6.1`.
3. `vitest.config.ts` adds `server.fs.allow` for the realpath of `node_modules`, so a symlinked `node_modules` (harness worktrees, `remote.sh`) can load PGlite's wasm and data.
4. A `test:browser` wrapper script makes `--project` filters work.
5. `.github/actionlint.yaml` was added for the custom runner label.

### #6 Dirty-block tracker over MEMFS (PR #13, https://github.com/2002Bishwajeet/pglite-cipher/pull/13)

`src/tracker/` (bitmap and tracker, 504 lines) and `test/tracker/` (engine, property, regression and harness tests, 949 lines). The model-based property test runs 2000 cases in Node and 200 in the browsers (see checkpoint findings).

## What stopped, and why

### #2 Spike (blocked)

STOP comment: https://github.com/2002Bishwajeet/pglite-cipher/issues/2#issuecomment-6806836176 (the harness's own note is comment 6806842269).

Condition 5 of the issue applies: ordinary syncs change the file table most of the time. The trace (PGlite 0.5.10, Node, the step 3 workload) shows:

| Phase | Syncs | Syncs that change the file table |
|---|---|---|
| 2,000 inserts of 4 KB blobs | 2,300 | 1,364 (59 %) |
| 200 one-row updates | 399 | 1 (0.3 %) |
| 20 transactions | 21 | 12 (57 %) |
| Writes up to 2 WAL segment switches | 194 | 93 (48 %) |
| **Whole workload** | **2,930** | **1,477 (50.4 %)** |

Cause: Journal's main write pattern (append one update blob per edit) grows the TOAST relation of the blob table. A 4 KB blob is 3 TOAST chunks of about 2 KB and a page holds 4, so a new page is added on about 2 of 3 inserts (267 of 269 size-changing syncs in a 400-insert run). Block size does not help: at 32 and 64 KB a growth inside the last block still changes the entry's size.

Other trace answers (they matter for #8):

- `msync` is never called. `mmap` is called 4 times, only on `/dev/shm`, outside PGDATA. No content write bypasses `MEMFS.stream_ops.write`.
- No writes past EOF, no truncate or size-changing `setattr`, no truncate followed by re-extend.
- Unaligned writes occur only in small whole-file rewrites (`pg_internal.init`, `replorigin_checkpoint.tmp`, `postmaster.pid`, `pg_filenode.map`, `PG_VERSION`).
- A new WAL segment is written whole as `xlogtemp.N` and renamed into place. Old segments are recycled by rename.
- A fresh data directory is 972 files, 26 directories, 39,854,275 bytes.
- PGlite syncs once per `query` and once per `exec`. A transaction syncs once (at `BEGIN`); `COMMIT` does not sync. electric-sql/pglite#1065 and #1191 are confirmed.
- Under `relaxedDurability`, a failed sync surfaces only as an unhandled rejection (#1063).
- `MemoryFS` can be subclassed and `initialSyncFs` runs before the `PG_VERSION` check, so STOP condition 2 does not apply. `/pglite/data` does not exist yet at that point, so the filesystem must create it.

Options the trace report gives for the owner's format decision:

1. Accept it: about one extra file-table record per append commit. The G1 gate (one-row update, no growth) should still write no table block (0.3 % in the trace; not yet measured on the prototype).
2. Keep sizes out of the packed table: a small per-file record holds the size or block count, so growth inside an allocated block changes nothing.
3. Preallocate block ids in chunks, so the table changes once per chunk.
4. Give a growing file's table entry a block of its own.

Work on the branch `agent/2-spike-prototype-filesystem-filesystem-op` (one commit, 61727c7, pushed, not merged): `spike/memfs.ts`, `traceFs.ts`, `workload.ts`, `protoFs.ts` (packed layout, round trip passing at 8, 32 and 64 KB with `fake-indexeddb`), `trace.node.test.ts`, `relaxedProbe.mjs`, `results/trace.json`. Not written: the benchmark page, `spike/run.mjs`, `spike/RESULTS.md`, `bench/README.md`. Lint and typecheck were not run on this partial work.

### Skipped

| Issue | Waiting on |
|---|---|
| #3 Spike gate (provisional) | #2, #11 |
| #5 Format v1 and crypto core | #3 |
| #7 Storage backends | #5 |
| #8 EncryptedFs | #5, #7 |
| #9 changeKey, rotateDataKey, verify | #8 |
| #10 Bench gates in CI, long fuzz, SECURITY.md | #9 |
| #11 Device benchmarks run by agents | #2 |
| #4 Owner: spike numbers on real webviews | owner-only, not agent-ready |

## Checkpoint 1 (PR #14, https://github.com/2002Bishwajeet/pglite-cipher/pull/14)

Covered f6ea7b7..f548c29 (scaffold and tracker). The reviewer (medium) found no blocker or defect. One simplify commit, 61ad955, replaced four repeated "for each child of a directory" loops in `src/tracker/tracker.ts` with a `forChildren` helper (7 insertions, 4 deletions). No crypto, test or scope change. Build, lint, Node tests and Chromium passed; Firefox and WebKit are covered by CI only (not run on this host).

Minor findings left open:

- `snapshot()` and `loadState()` clear state before finishing, so a throw part-way loses it (only on corrupt MEMFS input).
- The safety net misses mmap writes without `msync`, and same-millisecond bypassed writes.
- Directory mtimes are not marked dirty.
- `installTracker` has no `blockSize` validation and no uninstall.
- `snapshot` walks the whole tree each time.
- The browser property test runs 200 cases against 2000 in Node. Plan 06 asks for at least 2000. Owner decision whether to raise it.
- Main CI had no completed run at checkpoint time. At the time of this report the run for 76056c2 was still queued on the self-hosted runner; the run for f548c29 was cancelled (superseded by the later merge).

## Benchmark gates

Not run. Neither `bench/README.md` nor `spike/README.md` exists on `origin/main`, and `package.json` has no bench script; only the plan documents (`docs/plan/11-bench-fuzz-ci-gates.md`, `docs/plan/gcmbench.mjs`) exist. Nothing was run or committed. The branch `agent/bench-2026-11-11` was created from `origin/main` with no changes.

| Gate | What it measures | Status |
|---|---|---|
| G1 | sync after a one-row update, 100 MB, encrypted p50 at most 2x plain | not measured |
| G2 | open time, 10 and 100 MB (budget 1.5 s desktop, 3 s slowest phone, 400 ms for 10 MB) | not measured |
| G3 | peak worker heap (open at most db + 64 MB; population at most 1.5x db) | not measured |
| G4 | sync when a new 16 MB WAL segment appears (500 ms desktop, 1 s phone) | not measured |
| G5 | G1, G2, G4 at 8, 32 and 64 KB | not measured |
| G6 | WebCrypto and IndexedDB feature support per webview | not measured |
| G7 | Rust store throughput | not measured |
| G8 | session salts after a simulated year, plus `deriveKey` cost | not measured |
| G9 | file table: open cost at most 5 % of the G2 budget; G1 sync writes no table block | not measured. The trace is evidence against the second half for appends (see #2) |

The only numbers on file are from the Node 24 WebCrypto script (`docs/plan/gcmbench.mjs`, measured on the owner's laptop, not a webview): AES-256-GCM at 8 KB costs 20 to 27 microseconds per call with 64 calls in flight, about 390 MB/s; at 64 KB about 900 to 1,100 MB/s. These are from `docs/plan/01-sqlcipher-comparison.md`, not from this run. There are no per-engine numbers for Chromium, Firefox or WebKit.

## SQLCipher parity as it stands

This is the table in `docs/plan/01-sqlcipher-comparison.md` (2026-11-10). It describes the plan. No format code exists yet, so none of the rows is verified by this run. Stronger in 8 rows, weaker in 7 (1 reduced, 6 accepted), parity or n/a in the rest.

| Area | Verdict |
|---|---|
| Cipher and mode (AES-256-GCM), unit size, wrapped keys, raw key, key storage by the app | Parity |
| Integrity primitive (GCM tag against HMAC-SHA512), swapped and modified units | Parity |
| Header opacity and metadata leakage (block count and write timing stay visible) | Parity |
| IV and nonce (per-session HKDF subkey, at most 2^24 encryptions per subkey) | Parity with SQLCipher v5, by a cheaper route |
| What is covered (every file under PGDATA, names and sizes hidden) | Stronger |
| What the tag binds (type, store id, key id, file id, block index) | Stronger |
| Truncation, replay of one unit, deleted file | Stronger (the first two), parity (the last) |
| Two-tier key hierarchy and rekey (`changeKey`, `rotateDataKey`) | Stronger |
| Integrity check (`verify()`, every open is a full check), wrong-key versus corruption | Stronger |
| Whole-store rollback | Parity, accepted (not detected) |
| Key material in memory (no `mlock`, no wipe in JavaScript) | Weaker, accepted |
| Data in memory (the whole database), no random access | Weaker, accepted |
| No `cipher_memory_security` equivalent | Weaker, accepted |
| No FIPS build | Weaker, accepted |
| Durability (relaxed by default) | Weaker, accepted; not caused by encryption |
| Maturity (new code, no external review) | Weaker, reduced not closed |
| Passphrase KDF | n/a (no passphrase); Argon2id would live in Rust |
| Plaintext import | Parity once plan file PC-10 is built; it is not filed (owner answer 1: encryption in the first public build) |

Performance position: query time 0 % overhead (Postgres reads plaintext memory); open is slower than today and than SQLCipher with a raw key, and this is the number the missing G2 measurement would settle. The #2 trace adds a cost the plan did not price: with the layout as specified, about 2 of 3 append commits write at least one file-table block.

## What the owner must do next

1. Decide the file-table layout from the #2 options (accept, per-file size record, preallocated id chunks, or separate entry for growing files). Then unblock #2 so the harness can finish the benchmark page and gates. This changes the layout in `docs/plan/05-format-v1-crypto-core.md`.
2. Decide whether the browser property-test run count rises from 200 to 2000 (checkpoint 1).
3. Run the device benchmarks that agents cannot (issue #4 and, when it exists, the output of #11): the benchmark page in the Tauri shell on macOS, the oldest supported iPhone, Windows (WebView2) and Android, at 10 MB and 100 MB. None of this can start until the benchmark page exists.
4. WebKit does not run on the harness host. Check that the CI jobs for 76056c2 on the `yantra-box` runner pass for all three engines; the runs were queued at the time of this report. A red main returns as a `ci-failure` issue.
5. Owner-only boxes: the self-hosted `yantra-box` runner must be online for CI to run at all. Mac access through `scripts/harness/remote.sh mac` is needed for #11.
6. The Journal-side plan files in `docs/plan/journal/` (17 files, J-01 to J-17) were not touched. They file as issues in the journal repository when the owner is ready; J-16 (at-rest scanner, e2e dump of every store, device checklist) is the gate for any "encrypted at rest" claim per platform. The plan's rule: no public claim before J-05, J-06, J-09, J-15 and J-16 close, and an external review (owner question 11) before any security claim.
7. The licence holder in `LICENSE` is a placeholder until the owner names it.

## Risks

- **Layout risk.** The packed file table, as specified, writes a table block on about half of ordinary syncs. It still works, but it weakens the "G1 sync writes no file-table block" claim for append-heavy use and adds one record per commit. The decision is cheap now and expensive after #5 ships.
- **Open time.** The largest unmeasured risk: the whole store is decrypted at open. G2 has no number from any engine or device yet.
- **No gate has been measured.** Everything quantitative in the plan about performance remains an estimate.
- **Durability.** PGlite's #1065, #1191 and #1063 are confirmed: a transaction syncs once at `BEGIN`, a queued second `syncToFs` returns before any sync has run, and a failed relaxed sync is only an unhandled rejection. #8 must work around all three.
- **Test coverage in browsers.** The tracker property test runs 200 cases in browsers; Firefox and WebKit results come only from CI, which was queued.
- **Unreviewed code.** The tracker has one automated medium-effort review; there is no external review.
- **Harness.** One of eleven issues is blocked and eight sit behind it, so a single owner decision gates the whole critical path (#2, #3, #5, #7, #8, #9, #10, #11).
