# pglite-cipher harness run, 2026-11-17

Base: `origin/main` at 5ac2369 (merge of #106, the benchmark re-run). Sources: the harness result rows, `gh` for issues, PRs and comments, `bench/results/2026-11-17/SUMMARY.md` and its JSON, `docs/plan/01-sqlcipher-comparison.md`. CI was not waited on. Nothing here was re-tested by this report. This run is short: one issue, one checkpoint, one benchmark. It follows the 2026-11-16 report (`docs/report/2026-11-16-harness-report.md`), which covers #76, #77, #78, #80, #82, #83, #85 and #91.

## Summary

One issue was worked: #102 (CI red on main, `test-browser (firefox)`). It is merged and closed (PR #105). The failures were memory pressure on the runner, not a code regression: the Firefox browser job in `ci.yml` now runs with `--maxWorkers=1`. No test, config or runner cap was changed. The fix was not verified under the runner's own 10 GB cgroup cap, so the next CI run on main is the real test. Checkpoint 1 over the #102 range was clean. The full benchmark ran again on `main` (bb11824) in Chromium, Firefox and WebKit and every judged gate passes; G3 cannot be measured headless. `src/` did not change in this run, and has not changed since the 2026-11-16 report.

Open issues: #4 (owner device runs) and #76 (Android encrypted open, documented known limitation pending the owner's confirmation). Nothing is labelled `blocked`. Open PR: #101 (Redmi #76 result files). CI on main: the newest completed run (bb11824, run 43989417364) was cancelled by a newer push, and the run for 5ac2369 (43995128609) was queued when this was written. No green CI result is known yet for any commit since 5926674. No `ci-failure` issue is open.

| Item | Result |
|---|---|
| Issues closed this run | #102 |
| Issues open | #4, #76 |
| `src/` changes | none |
| Checkpoints | 1, clean |
| Benchmark | 2026-11-17, `main` at bb11824, three engines, no judged gate fails; G3 not measurable |
| CI on main | Not confirmed green. 5926674 was red (#102, now fixed by #105); the runs for cd47348 and bb11824 were cancelled; 5ac2369 queued |

## What shipped

| Item | What | PR |
|---|---|---|
| #102 | Firefox browser job runs with `--maxWorkers=1` (`.github/workflows/ci.yml`, Firefox job only). Firefox holds about 3x Chromium's memory per file (`open.test.ts` peaks at 8.7 GB in Firefox, 2.5 GB in Chromium). Summed resident memory of the suite: 14.3 GB at the default 4 workers, 13.6 GB at 2, 8.5 GB at 1 (535 s against 190 s). Memory does not grow across files, and `release.test` passes standalone, so no release bug was seen | https://github.com/2002Bishwajeet/pglite-cipher/pull/105 |
| Bench | Results 2026-11-17: `bench/results/2026-11-17/` (SUMMARY.md, `chromium.json`, `firefox.json`, `webkit.json`) | https://github.com/2002Bishwajeet/pglite-cipher/pull/106 |

#102 checks, from the PR: `remote.sh box npm run test:browser -- --project firefox --maxWorkers=1` exit 0; the same command locally under `heavy` exit 1 (it ran concurrently with the box run; the PR does not say which test failed or why, so treat it as unexplained); the failing fuzz file rerun alone exit 0; no weakened-test diff; WebKit "CI covers it".

## What stopped, and why

Nothing stopped in this run. The earlier stops (#76, #80, #83, #85) are in the 2026-11-16 report and are unchanged. Before the fix, the hourly check-in found that every main `test-browser (firefox)` job on 2026-11-16 had been OOM-killed (runner unit `MemoryMax=10G`, kills within about 3 minutes), which is why those jobs showed "The operation was canceled" with no failing test; that is the same cause as #94. The check-in's instruction on #102 was: a memory or release bug is a real fix; a parallelism change is acceptable only with numbers; raising the runner cap is an infrastructure change, so STOP. The fix took the middle path with the numbers above and did not touch the cap.

## Checkpoint findings

**Checkpoint 1** (clean): the range since f8b89de touches only `.github/workflows/ci.yml`. Code-review (medium) found no blockers or majors; nothing was fixed. The simplify skill ran as a single pass, not the 4-agent fan-out (no Agent tool), and found nothing to change. Build, lint, node tests and Chromium browser tests pass. Firefox and WebKit were not run, because the change is workflow YAML and CI covers them. Minor finding left open, from #105's review: the 8.5 GB peak was measured under `heavy` without the 10 GB cgroup cap and included swap, so the fix depends on the suite staying under the runner's `MemoryMax`, and nobody has run the suite under the cap itself.

The seven unverified checkpoint-2 findings from the 2026-11-16 report are still untriaged (the weakened memory assertion in `workers.patch` matters most).

## Benchmark gates

`main` at bb11824, parts `gates10, extras, gates100, year`, 20 runs per measure, p50. The `ops` part was not run. The page needs IndexedDB and a DOM, so there is no Node row; Node behaviour is covered by the test suite. Environment: Chromium 158 and Firefox 159 headless on the ROG G14 (Ryzen 5 4600HS, 15 GiB, shared with other harness sessions); WebKit is Playwright's macOS build on the Mac (M1 Pro, macOS 27.0.1), not Safari and not WKWebView. WebKit times come from a faster machine: compare plain against encrypted within one engine, not across columns. Ratio is encrypted p50 over plain p50.

| Gate | Target | Chromium | Firefox | WebKit (Mac) |
|---|---|---|---|---|
| G1 sync, 10 MB | ratio <= 2 | 0.06 (4.3 vs 72.9 ms) pass | 0.04 (6.14 vs 138) pass | 0.03 (2.66 vs 98.8) pass |
| G1 sync, 100 MB | ratio <= 2 | 0.07 (4.83 vs 68.1) pass | 0.05 (6.96 vs 154) pass | 0.01 (2.24 vs 156) pass |
| G1b insert, 10 MB | ratio <= 2; <= 1 table block | 0.06; p50 1, max 1 pass | 0.04; 1 / 1 pass | 0.03; 1 / 1 pass |
| G1b insert, 100 MB | same | 0.01; p50 1, max 2 pass on p50 | 0.01; 1 / 2 pass on p50 | 0.01; 1 / 2 pass on p50 |
| G2 open, 10 MB | ratio <= 2 | 1.31 (440 vs 336 ms) pass | 1.11 (682 vs 613) pass | 0.57 (163 vs 285) pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.60 (923 vs 577 ms) pass | 0.96 (1,265 vs 1,315 ms) pass | 0.78 (323 vs 416 ms) pass |
| G3 memory | db + 64 MB | not measurable (486 / 449 MB, whole renderer heap) | no memory API | no memory API |
| G4 segment switch, 10 MB | <= 500 ms; <= 10x plain sync | 85.1 ms (1.17x) pass | 272 ms (1.97x) pass | 28.6 ms (0.29x) pass |
| G4 segment switch, 100 MB | same | 89.3 ms (1.31x) pass | 277 ms (1.79x) pass | 29.8 ms (0.19x) pass |
| G5 unit size | smallest passing G2 | n/a, 64 KB default passes | same | same |
| G6 support | all present | pass | pass | pass |
| G7 Rust store | recorded only | owner (Tauri only) | owner | owner |
| G8 subkeys, one year | <= 150 ms | 1.32 ms (263 salts) pass | 15.8 ms pass | 15.8 ms pass |
| G9 file-table phase, 10 MB | <= 5 % of G2 budget | 8.91 ms (limit 22) pass | 8.06 ms (limit 34.1) pass | 4.5 ms (limit 8.2) pass |
| G9 file-table phase, 100 MB | <= 75 ms | 11.0 ms pass | 19.6 ms pass | 5.52 ms pass |
| G9 G1 sync writes no table block | p50 0 | pass | pass | pass |

Other measurements (10 MB / 100 MB):

| Measure | Chromium | Firefox | WebKit (Mac) |
|---|---|---|---|
| `changeKey` | 3.7 / 7.2 ms | 26.6 / 22.6 ms | 11.2 / 9.9 ms |
| `verify()` | 374 / 861 ms | 593 / 1,611 ms | 106 / 271 ms |
| `rotateDataKey` | 1,064 / 2,516 ms | 2,169 / 4,982 ms | 299 / 754 ms |
| Open after rotation | 447 / 922 ms | 686 / 1,271 ms | 148 / 293 ms |

Thinnest margins: Firefox G2 at 100 MB (1,265 of 1,500 ms) and the Chromium G2 ratio at 100 MB (1.60 of 2). The Chromium ratio was 1.24 on 2026-11-16; the plain open took 577 ms this time (about 770 ms then, from 956 ms at 1.24x) and the encrypted open 923 ms (956 then), so the ratio moved with the plain baseline on a shared host. The absolute encrypted open is not slower. Android and WebView2 numbers are unchanged from the 2026-11-16 report (Redmi baseline 3.41x at 100 MB; WebView2 CI VM 4.14x, 2.7 s): neither was re-run.

## SQLCipher parity as it stands

Source: `docs/plan/01-sqlcipher-comparison.md` section 2, 31 rows, last changed 2026-11-13. This run changed no verdict and no `src/`. Count: stronger 8, parity 14, n/a 2, weaker 7 (1 reduced, 6 accepted).

| Verdict | Rows |
|---|---|
| Stronger (8) | What is covered (every file under PGDATA); what the tag binds (AAD); truncation; replay of one unit; key hierarchy (KEK wraps DEK); wrong key vs corruption; rekey (`changeKey` instant, `rotateDataKey` resumable); integrity check (`verify()`, every open is a full check) |
| Parity (14) | Cipher and mode (AES-256-GCM); unit size; nonce and subkey; integrity primitive; swapped unit; modified unit; deletion of a whole file; whole-store rollback (not detected, accepted); opaque header and salt; raw key; key storage (the app's job); metadata leakage; cipher agility; migration tooling |
| n/a (2) | Plaintext header option; key derivation (no passphrase) |
| Weaker (7) | Key material in memory; the whole database in memory; no `cipher_memory_security`; no FIPS build; durability (relaxed by default); no random access to a big database; maturity (new code, no external review) |

Where the table and reality differ: open time. The table estimated +0.5 to 4 s at 100 MB; desktop is 0.78 to 1.60x plain (323 to 1,265 ms), Android is 3.41x on the Redmi. Migration tooling is "parity once PC-10 is in"; PC-10 was not filed, so treat it as not applicable. "Stronger" describes the design and is exercised by `test/format`, `test/fs`, `test/keys`; this report did not rerun them. Maturity stays weaker: the package is not audited and must not be described as audited.

## What the owner must do next

1. **Read CI on main once.** Run 43995128609 (5ac2369) is the first run with `--maxWorkers=1`. If `test-browser (firefox)` is still killed, the 8.5 GB peak does not fit the runner's 10 GB cap and the cap or the job split is an infrastructure decision for you. If it is green, #102 is confirmed.
2. **Confirm or overrule the #76 decision** (documented known Android limitation, fix later; see the 2026-11-16 report). If you agree: write the limitation and numbers into the docs, check that a later store layout can be introduced behind a version or layout marker, file the follow-up (OPFS segment backend spike first, padded packing second), and merge or close PR #101.
3. **Device runs (#4).** A real WebView2 run on Windows; Tauri macOS (WKWebView) at 10 and 100 MB; oldest supported iPhone; iPad Air M3 Safari `gates100` (#41 confirmation); iPhone 15 re-run (#42); Android WebView; tick the Redmi boxes. The Journal tech article waits for these.
4. **Owner-only measurements.** G7 (Rust store throughput; needs `docs/plan/journal/02-native-bench-endpoints.md`) and G3 on a device with a memory API.
5. **Triage the unverified checkpoint-2 findings** from the 2026-11-16 report, starting with the weakened memory assertion in `bench/patches/workers.patch`, and decide which other open findings block a release.
6. **Journal-side plan files** in `docs/plan/journal/` (17 files, `01` to `17`). The harness has done no Journal-side work. `07-1017-wire-encrypted-fs.md` is the one that uses this package; `02` is needed for G7; `04` to `06`, `10` to `14` cover secrets, recovery and lock screens on each platform; `16` is the at-rest scanner and device checklist; `17` is the epic rewrite. `08` and `09` are not needed under answer 1A.
7. **Nightly workflow.** Trigger once with `workflow_dispatch` and read the first run. The 2,000-transaction crash matrices have not run to completion anywhere.
8. **Pre-public plan.** #76 documented, CI green, history rewrite, FSL + CLA under your name (memory: repo stays private until then).
9. **Clean up** stale worktrees under `.claude/worktrees/wf_*` and merged local branches.

## Risks

- **CI memory margin.** The Firefox job at one worker peaks at 8.5 GB (with swap) against a 10 GB cap, and takes 535 s. A larger Firefox test file or a second job on the same runner could push it over again.
- **Firefox memory.** About 3x Chromium per test file. The #102 analysis found no release bug and the suite's memory falls between files, but `release.test` (closed instances hold at most one database) is the test to watch; it must never be loosened.
- **Android open time.** Unfixed: 3.41x on the Redmi at 100 MB, to be documented as a known limitation. Unchanged from 2026-11-16.
- **WebView2 and slow machines.** The CI VM fails G2 and G4; no real Windows run exists.
- **Unverified checkpoint-2 findings** (seven) remain open, and no CI result confirms the last several merges.
- **Benchmark scope.** Headless engines on a shared machine; WebKit is Playwright's build on a faster machine; `ops` not run; G3 not measurable; not a phone.
- **Open memory.** The read-ahead is about 64 MB of ciphertext on top of the database, and the whole database is held as plaintext while open; the wipe on close is best-effort.
- **Maturity.** New cryptographic format, no external review, one author and agents. Keep the repository private; make no "audited" claim.
