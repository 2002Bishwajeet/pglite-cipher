# pglite-cipher harness run, 2026-11-13 (final)

Base: `origin/main` at ace9faf (merge of #39). This replaces the earlier versions of this file (PRs #32, #34, written at 926fd25 and 2223cf1); they stay in git history. Sources: the harness result rows, `gh` for issues and PRs, `bench/results/2026-11-13/SUMMARY.md`, the comments on #35, #10 and #4, the bodies of PRs #37 and #38, `docs/plan/01-sqlcipher-comparison.md`. CI was not waited on. Nothing here was re-tested by this report.

## Summary

#10 is done. After the owner's decision (two pages of ciphertext in flight during open), the open reads the next page while one decrypts, and the benchmark gates now measure the shipped `src/`, not the spike prototype. #36 (`changeKey` settles an unknown commit outcome) is merged. The benchmark ran again on the new code in three engines: no judged gate fails. #35 stopped twice on the crash test and is waiting for work under a second owner decision.

| Item | Result |
|---|---|
| PRs merged this run | #37 (#10), #38 (#36), #39 (bench results) |
| Issues closed this run | #10, #36 |
| Stopped | #35 (twice; owner decisions posted after the second stop, see below) |
| Open, owner only | #4 |
| Checkpoints | 1, no blocker or major finding |
| Benchmark | ran on `main` at ae2b2f6, Chromium, Firefox, WebKit (Mac), 10 and 100 MB |
| Overall | 12 of 14 issues closed (#1 to #3, #5 to #11, #26, #36); #4 and #35 open. `ci-failure` issues open: none |

## What shipped

Issue by issue, for the whole project. The last three rows are from this run.

| Issue | What | PR |
|---|---|---|
| #1 | Scaffold: TypeScript build, tests in Node and three browser engines, CI, licence placeholder | https://github.com/2002Bishwajeet/pglite-cipher/pull/12 |
| #2 | Spike: prototype filesystem, filesystem-operation trace, benchmark page with gates | https://github.com/2002Bishwajeet/pglite-cipher/pull/18 |
| #3 | Spike gate (provisional): 64 KB block, IndexedDB, budgets 1,500 / 3,000 ms. Decision recorded as an issue comment, no PR | issue comment |
| #5 | Format v1 and crypto core | https://github.com/2002Bishwajeet/pglite-cipher/pull/20 |
| #6 | Dirty-block tracker with a model-based property test | https://github.com/2002Bishwajeet/pglite-cipher/pull/13 |
| #7 | Storage backend interface, IndexedDB and in-memory backends, fault injection | https://github.com/2002Bishwajeet/pglite-cipher/pull/21 |
| #8 | `EncryptedFs` (open, sync, close) on format v1 | https://github.com/2002Bishwajeet/pglite-cipher/pull/23 |
| #9 | `changeKey`, crash-safe `rotateDataKey`, `verify()` | https://github.com/2002Bishwajeet/pglite-cipher/pull/24 |
| #11 | Agent device benchmarks (macOS WebKit, WKWebView, iOS simulator) | https://github.com/2002Bishwajeet/pglite-cipher/pull/19 |
| #26 | CI red on main (WebKit-only failure) | https://github.com/2002Bishwajeet/pglite-cipher/pull/27 |
| **#10** | Benchmark gates in CI, nightly long fuzz/crash/soak runs, ported third-party scenarios, `SECURITY.md`, release checklist. The open reads page N+1 while page N decrypts; the S5 memory test now allows two pages | https://github.com/2002Bishwajeet/pglite-cipher/pull/37 |
| **#36** | `changeKey` reads both header copies back after a failed commit and settles the outcome; new `KeyChangeUnknownError` when it cannot | https://github.com/2002Bishwajeet/pglite-cipher/pull/38 |
| **Bench** | Results for the shipped code, three engines. Branch `agent/bench-2026-11-13c` (earlier names were taken). Replaces the earlier 2026-11-13 results in place | https://github.com/2002Bishwajeet/pglite-cipher/pull/39 |

Earlier in the day, also merged: #28 (checkpoint 2), #29/#31/#33 (earlier bench runs), #30/#32/#34 (earlier reports).

Details of the two code changes:

- **#10 (PR #37).** Owner decision (issue comment on #10, 2026-11-13 06:58): allow two pages of ciphertext during a load, update the S5 test to "at most two pages", keep G2 at 2.0x. Local evidence in the PR: Chromium, 10 MB, interleaved, 20 opens, 10 runs on the mini PC, G2 ratio 1.43 to 1.58, median about 1.53, all pass. `npm test`, Chromium browser tests, lint, build, typecheck and `bench:build` exit 0. The Node long subset (soak shortened to 5 minutes) passed. Firefox and WebKit browser suites were not run locally: CI covers them. The 2,000-transaction crash matrices were not run.
- **#36 (PR #38).** After a rejected header commit the code tries the new key, then the old, on the header read back. New key opens: resolves. Old key opens: rejects with the commit's error. Neither, or the read fails: rejects with `KeyChangeUnknownError` (fixed message, the commit error as `cause`). The README errors table is updated. A test covers four cases; on `main` case 3 failed. No format, rotation or existing-test change. Chromium `test/keys` and `npm test` pass; Firefox and WebKit are CI-covered.

## What stopped, and why

### #35 Strict sync that joins an in-flight relaxed sync

Issue: https://github.com/2002Bishwajeet/pglite-cipher/issues/35. State: open, label `agent-ready` (`blocked` is no longer on it).

Stop 1 (comment 6847001495). The fix is a flag `#owesStrict`: after a commit that was not strict, a strict sync (or `closeFs`) writes the root again in one strict commit. Still one transaction per sync, so the file table and blocks cannot disagree. Three new tests fail on `main` and pass with the fix. `test/keys/crash.test.ts` ("a kill at any write of a rotation...") asserted `switchAt + 3` writes and now sees `+ 4`, because the test's strict sync adds the root-only commit. Condition: "an existing crash, fuzz or conformance test has to change". Local commit 21e698c, branch `agent/35-strict-sync-that-joins-an-in-flight-rela`.

Owner decision 1 (comment 6847100007): change the expected count from 20 to 21, no other change; the test must still kill at all 21 writes.

Stop 2 (comment 6847593016). With the count at 21 (commits 8d0dd85 fix, 95312f5 test, branch `agent/35-...-rela-2`, pushed), the matrix fails at state 20. That state is a kill after PGlite's relaxed commit, which already holds `INSERT -1`, and before the new root-only strict commit. The test expects the pre-insert tables there. Changing line 74 from `if (k < end)` to `if (k < end - 1)` makes it pass (11 s on the box); the agent did not apply it.

Owner decision 2 (comment 6848373673, posted after the run stopped): apply that change; states `end - 1` and `end` are checked by row count; every one of the 21 states is still replayed and reopened; nothing else in the test changes. "Continue from 95312f5 on agent/35-...-rela-2."

Status: no agent has picked this up since decision 2. Not merged. Browser tests and lint/build have not been run on the #35 branch.

## Checkpoint findings

Checkpoint 1 (range ending at ae2b2f6): no blocker or major findings, no files changed, no commits. Everything left is minor and in the `changeKey` settle path (`src/encryptedFs.ts`, `headerKey` / `changeKey`):

1. A torn two-copy header read as the new or the old key (`headerRepairNeeded` is ignored). The `StorageBackend` contract says commits are atomic, so this is hypothetical.
2. On `KeyChangeUnknownError` the in-memory key and header stay old. A retry is still safe: it rewraps with the same `expectRoot`.
3. `headerKey` swallows non-key errors from `openHeader`.
4. "Unknown" also covers neither key opening a corrupt header; the message says either key may open it.
5. The settle logic is separate from `commitSettled`.
6. No test for a torn header, or for a retry after `KeyChangeUnknownError`.

How the checkpoint ran: the code-review skill looked at HEAD (7f7f3b3) only, not the whole range; the reviewer read the #10 open-pipeline change and found nothing. The simplify pass was a single inline pass, not the four-agent fan-out, and found nothing. Lint and build exit 0. Tests were not rerun because nothing changed. Main CI: the newest completed runs were cancelled (superseded), none failed.

From the #10 review (PR #37), one minor finding left open: with the default 64 KB block and pages of 512, an open now holds two pages of ciphertext, about 64 MB (2 x 512 x (65,536 + overhead)). Gate G3 reads "open <= database + 64 MB", and the file map, decrypt outputs and IndexedDB's own copies come on top. `bench/judge.ts:49` asserts this whenever `measureUserAgentSpecificMemory` exists, so the nightly Chromium bench can fail G3 by design. Plan 08, plan 01 (RAM row) and the README were updated; the G3 gate row was not.

Open findings from the earlier checkpoints that this run did not touch: an interrupted rotation whose new store has a damaged root or header fails to open though the old store is intact (PR #24); no issue is filed for it.

## Benchmark gates

Source: `bench/results/2026-11-13/SUMMARY.md`, `main` at ae2b2f6, 20 runs per measure, p50. This is the first run where the page benchmarks the shipped `EncryptedFs` over `IndexedDbBackend.pair` (64 KB blocks, the format default) against plain `idb://`; earlier runs measured the spike prototype. Payloads of 10 and 100 MB; data directories 67.8 and 266.6 MB, about 1,020 files. Node has no row: the page needs IndexedDB and a DOM, and Node behaviour is covered by the test suite.

Machines: Chromium 158 and Firefox 159 (headless) on the G14 (Ryzen 5 4600HS, 15 GiB), shared with other sessions, so timings are noisy. WebKit on the Mac (M1 Pro, macOS 27.0.1) through `webkit.sh`: Playwright WebKit, not Safari, not WKWebView. Compare plain against encrypted within one engine, never across engines. Ratio is encrypted p50 over plain p50.

| Gate | Target | Chromium | Firefox | WebKit (Mac) |
|---|---|---|---|---|
| G1 sync, one-row UPDATE, 10 MB | ratio <= 2 | 0.05 (4.36 vs 79.8 ms) pass | 0.04 (6.26 vs 146 ms) pass | 0.05 (6.38 vs 133 ms) pass |
| G1 sync, one-row UPDATE, 100 MB | ratio <= 2 | 0.06 (4.85 vs 82.3 ms) pass | 0.05 (7.00 vs 144 ms) pass | 0.03 (5.40 vs 206 ms) pass |
| G1b 4 KB insert, 10 MB | ratio <= 2; <= 1 table block | 0.05 (5.73 vs 110 ms); blocks p50 1, max 1 pass | 0.04 (7.70 vs 185 ms); 1 / 1 pass | 0.04 (5.78 vs 135 ms); 1 / 1 pass |
| G1b 4 KB insert, 100 MB | ratio <= 2; <= 1 table block | 0.01 (7.06 vs 595 ms); p50 1, max 2: pass on p50 | 0.01 (10.4 vs 724 ms); 1 / 2: pass on p50 | 0.01 (5.78 vs 479 ms); 1 / 2: pass on p50 |
| G2 open, 10 MB | ratio <= 2 | 1.07 (460 vs 431 ms) pass | 1.10 (676 vs 615 ms) pass | 0.65 (233 vs 357 ms) pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.34 (860 ms) pass | 0.96 (1,269 ms) pass | 0.92 (696 ms) pass |
| G3 memory after open | db + 64 MB | not measurable: whole-renderer heap 632 MB (10 MB db), 1,000 MB (100 MB db); plain idb 479 / 1,183 MB | no memory API | no memory API |
| G4 segment switch, 10 MB | <= 500 ms | 92.2 ms pass | 258 ms pass | 63.2 ms pass |
| G4 segment switch, 100 MB | <= 500 ms | 87.3 ms pass | 278 ms pass | 58.8 ms pass |
| G5 unit size | smallest unit passing G2 | n/a: one 64 KB unit; G2 passes | n/a | n/a |
| G6 support | all present | pass | pass | pass |
| G7 Rust store throughput | recorded only | owner (Tauri) | owner | owner |
| G8 subkeys after 365 sessions | <= 150 ms | 1.3 ms pass | 21.0 ms pass | 21.0 ms pass |
| G9 file-table phase of open, 10 / 100 MB | <= 5% of G2 budget (about 20 ms) / <= 75 ms | 9.88 / 12.9 ms pass | 11.0 / 19.0 ms pass | 4.62 / 8.22 ms pass |
| G9 G1 sync writes no table block | p50 0 | pass | pass | pass |

Other measures (10 MB / 100 MB where two values are given):

| Measure | Chromium | Firefox | WebKit |
|---|---|---|---|
| `changeKey` | 3.5 / 6.9 ms | 6.8 / 25.0 ms | 7.3 / 8.0 ms |
| `verify()` | 361 / 865 ms | 580 / 1,519 ms | 301 / 427 ms |
| `rotateDataKey` | 1,150 / 2,282 ms | 2,176 / 5,122 ms | 1,036 / 932 ms |
| Open after the rotation, 100 MB | 867 ms | 1,260 ms | 376 ms |
| Year simulation (365 sessions) | 182 s | 259 s | 74 s |

Reading:

- Verdict: no judged gate fails in any engine. G3 cannot be measured headless and stays open for devices. G7 is owner-only.
- Sync is about 17 to 100 times faster than plain (ratio 0.01 to 0.06), because only dirty records are written.
- Open at 100 MB is 0.92 to 1.34x plain. Firefox has the least headroom against the 1,500 ms budget (1,269 ms). These ratios are lower than the 1.5 median measured for #10 on the mini PC; the machine and the estimator differ, so do not compare them.
- G1b at 100 MB passes on the p50 of table blocks (1), but the maximum is 2 in all three engines. The judge does not cover G1b; the row is computed from the JSON.
- The G3 figures are whole-renderer heap including baseline, so they say nothing about the 64 MB margin. The two-page open alone is about 64 MB (see checkpoint findings).
- **The `ops` part failed in Chromium and Firefox** with `QuotaExceededError` (reproduced on a second Chromium run). WebKit completed it. The likely cause is the headless profile quota on this host's 7.6 GB tmpfs `/tmp`, not verified. `ops` is not a gate. `node bench/gates.ts --factor 1` exits 1 only because of it.
- The AES-GCM throughput row, `deriveKey` median and the Open-in-flight breakdown are in the SUMMARY.
- The device numbers from #11 (macOS WebKit, WKWebView, iOS simulator) were not repeated; see the 2026-11-12 report.

## SQLCipher parity as it stands

Table: `docs/plan/01-sqlcipher-comparison.md` section 2, 31 rows. This run changed only the "RAM, peak at open" row in section 3 (two read batches). The section 2 verdicts are the 2026-11-12 ones. Count: stronger 8, parity 14, n/a 2, weaker 7 (1 reduced, 6 accepted).

| Verdict | Rows |
|---|---|
| Stronger (8) | What is covered (every file under PGDATA); what the tag binds (AAD); truncation; replay of one unit; key hierarchy (KEK wraps DEK); wrong key vs corruption; rekey (`changeKey` instant, `rotateDataKey` resumable); integrity check (`verify()`, every open decrypts everything) |
| Parity (14) | Cipher and mode (AES-256-GCM); unit size; nonce and subkey; integrity primitive; swapped unit; modified unit; deletion of a whole file; rollback of the whole store (not detected, accepted); opaque header and salt; raw key; key storage (app's job); metadata leakage; cipher agility; migration tooling |
| n/a (2) | Plaintext header option; key derivation (no passphrase) |
| Weaker (7) | Memory for key material; whole database in memory; no `cipher_memory_security`; no FIPS build; durability (relaxed by default); no random access to a big database; maturity (new code, no external review) |

Where the table and reality differ:

- Migration tooling is marked "parity once PC-10 is in". Owner question 1 was answered A, so PC-10 was not filed. Treat the row as not applicable.
- "Stronger" describes the design. The tests in `test/format`, `test/fs` and `test/keys` exercise it; this report did not rerun them. Rekey: the `changeKey` unknown outcome is now settled by #36, and the minor items above remain. Integrity at an interrupted rotation with a damaged new store is still open.
- Durability: #35 is not merged, so a strict sync that joins a relaxed one can still resolve without a strict commit, and the README's flush-on-hide note is not always true.
- Performance: the section 3 estimates now have shipped-code numbers. Open at 100 MB is 0.92 to 1.34x plain at the 64 KB default.
- Maturity stays weaker. The package is not audited and must not be described as audited.

## What the owner must do next

1. **#35.** Both decisions are on the issue. Pick the issue up again (next harness run, or by hand) from 95312f5 on `agent/35-strict-sync-that-joins-an-in-flight-rela-2`; the agent must apply only the two approved test changes (`crash.test.ts` line 59 count and line 74 bound). The first branch (21e698c) is held by the stale worktree `.claude/worktrees/wf_ff3f6913-3a6-9`.
2. **G3 gate wording.** Decide whether "open <= database + 64 MB" is updated for the two-page open (the PR #37 finding). Until then the nightly Chromium bench can fail G3 by design when a memory API exists.
3. **Nightly workflow.** Trigger it once with `workflow_dispatch` and read the first run. The Node long subset ran locally with a 5-minute soak; the 2,000-transaction crash matrices take hours and have not run. The Firefox and WebKit suites and the WebKit-written compat fixture have run only in CI. (Checkboxes on #4.)
4. **Device runs on #4** (about an hour). Paste JSON on #4:
   - macOS in the Tauri shell, at 10 MB and 100 MB.
   - The oldest iPhone you will support (name it). This tests the 3 s phone budget; the simulator cannot.
   - Windows (WebView2) and Android WebView if a device is at hand.
   - iPhone 15, iPad Air (M3) and the Redmi need unlocking or pairing first: `scripts/harness/remote.sh mac bash spike/device/mac.sh iphone-15`; `bash spike/device/redmi.sh` after `adb pair` / `adb connect`.
5. **Owner-only boxes.** G7 (Rust store throughput, Tauri shell with `encfs-bench`, needs `journal/02`) and G3 on a device with `measureUserAgentSpecificMemory`.
6. **Journal-side plan files** in `docs/plan/journal/` (17 files, `01` to `17`). No Journal-side work has been done. `07-1017-wire-encrypted-fs.md` is the one that uses this package, and the #10 verdict it waited on is in (open time measured on `src/`). `08-native-migration.md` and `09-native-plaintext-sweep.md` are not needed under answer 1A. File the ones you want agents to take.
7. **Decide which open findings block a release:** the damaged-new-store case at an interrupted rotation, and the six minor `changeKey` items. Say which become issues.
8. **Rerun `ops`** with the browser profile on a disk, not the tmpfs, if you want startup and operations numbers for Chromium and Firefox.
9. **Clean up.** Stale worktrees (`wf_47356dba-866-*`, `wf_101d8937-edb-2`, `wf_1d72e28d-3b0-2`, `wf_ff3f6913-3a6-9`) and the branches `worktree-wf_101d8937-edb-2`, `worktree-wf_1d72e28d-3b0-2` hold #10 history that is now merged via `agent/10-...`; remove them when you are sure.
10. **Read CI once.** At the time of writing the run on `main` at ace9faf was queued; the four before it were cancelled (superseded), not red. A red result comes back as a `ci-failure` issue.

## Risks

- **Open time** is measured on the shipped code now: 0.92 to 1.34x plain at 100 MB on desktop engines, G2 headroom smallest in Firefox. No phone has been measured. Most of the open is IndexedDB read time, which encryption does not control.
- **Open memory.** The two-page read-ahead holds about 64 MB of ciphertext on top of the database, which is the whole G3 margin. Unmeasurable headless.
- **Whole database in memory**, plaintext, while the app is open. App lock (J-12) is the mitigation.
- **Durability.** Syncs are relaxed by default and #35 is unmerged: a strict request can resolve after a relaxed commit.
- **Key change.** #36 removes the silent wrong-outcome case. Left: the no-test cases for a torn header and for a retry after `KeyChangeUnknownError`, and an unfiled interrupted-rotation finding.
- **Verification gaps.** Firefox and WebKit ran locally for neither #10 nor #36; CI is the only evidence there (a WebKit-only failure, #26, already got through the local gate once). The long crash matrices have not run.
- **Benchmark scope.** Headless engines on a shared machine; WebKit is Playwright's build on faster hardware. Not Safari, not a webview, not a phone.
- **Maturity.** New cryptographic format, no external review, one author and agents. Keep the repository private; make no "audited" claim.
