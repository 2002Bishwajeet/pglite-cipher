# pglite-cipher harness run, 2026-11-14

Base: `origin/main` at 7981fc2 (merge of #70). Sources: the harness result rows, `gh` for issues, PRs and comments, `bench/results/2026-11-14/{chromium,firefox,webkit}.json` as summarised by the benchmark step, `docs/plan/01-sqlcipher-comparison.md`. CI was not waited on. Nothing here was re-tested by this report.

## Summary

The queue is empty except for two blocked issues. 22 of 25 issues are closed. Open: #4 (owner device runs), #63 (blocked, stage A gate missed) and #67 (CI red on main, fixed by #68, waiting for a green main run to auto-close). This run merged #58 (as a bench-only spike), a CI fix (#68), checkpoint 1 (#69) and the benchmark results (#70). It stopped #63. The benchmark ran on `main` at 0fb8bff in Chromium, Firefox and WebKit: no judged gate fails. G3 (memory) and G7 (Rust store) are not measurable here. `src/` did not change in this run.

| Item | Result |
|---|---|
| Issues closed this run | #58 |
| Issues open | #4 (owner), #63 (blocked), #67 (fixed, awaiting a green main run) |
| Stopped | #63 |
| Checkpoints | 1, one bench fix, no `src/` finding |
| Benchmark | 2026-11-14, `main` at 0fb8bff, three engines, no judged gate fails |
| CI on main | 7981fc2 queued when this was written; the three runs before it were cancelled by newer pushes. No result is known for any of them |

## What shipped

| Item | What | PR |
|---|---|---|
| #58 | Owner decision applied: only the IndexedDB read-path bench spike landed (`bench/idbread.ts`, a `--throttle` option in `bench/run.mjs`, five idbread result files under `bench/results/2026-11-13-58/`). `src/backend/indexeddb.ts` stays as on main. The parallel-parts read change (6d75d8b) is not merged: it slowed desktop Chromium by more than 10 %. No change in `src/` or `test/` | https://github.com/2002Bishwajeet/pglite-cipher/pull/66 |
| #67 | CI went red on main because systemd-oomd killed the G14 runner 4.5 minutes into `test-browser (firefox)`; no test failed. Browser jobs now use the label `pc-ci-heavy`, which only yantra-box and the Mac carry. WebKit stays on yantra-box. The G14 keeps lint, build and the Node tests. The repo invariant test was updated to match, not loosened | https://github.com/2002Bishwajeet/pglite-cipher/pull/68 |
| Checkpoint 1 | Review and simplify 1bc6a64..c06f27f (12 files). Fix: `bench/run.mjs` named Firefox and WebKit results `-throttleN` although the CPU throttle is Chromium-only; the suffix now appears only when the throttle was applied | https://github.com/2002Bishwajeet/pglite-cipher/pull/69 |
| Bench | Results 2026-11-14 (three JSON files) | https://github.com/2002Bishwajeet/pglite-cipher/pull/70 |

Issue #67 is still open. Its last comment says it is fixed by #68 and that the next green main run closes it.

## What stopped, and why

| Issue | Stop condition | State |
|---|---|---|
| #63 | A stage A gate is missed: "no engine's G2 more than 10 % worse". At 256 KiB the Firefox encrypted open goes from 1,486 to 1,902 ms (+28 %; a repeat gave 1,497 to 1,954, +31 %). WebKit with split4 is +18 % (327 to 386 ms) | STOP comment: https://github.com/2002Bishwajeet/pglite-cipher/issues/63#issuecomment-6870751548. Label `blocked` created and added. Branch `agent/63-format-256-kib-block-option-for-android` pushed (1 commit, 2922ba2, ahead of main; it holds stage A bench results and a bench patch, no `src/` change). Stage B needs an owner decision |

Stage A detail from the issue comment (encrypted open p50, ms, 64 KiB to 256 KiB):

| Engine | 64 KiB | 256 KiB | Note |
|---|---|---|---|
| Chromium | 1,073 | 1,454 | Plain also rose 41 %; the ratio went 1.64 to 1.58 |
| Firefox | 1,486 | 1,902 | Repeat 1,497 to 1,954. This misses the gate |
| WebKit | 321 | 345 | |
| Chromium, split4 | 1,298 | 1,298 | |
| Firefox, split4 | 1,417 | 1,629 | |
| WebKit, split4 | 327 | 386 | +18 %. G4 with split4 went 34.6 to 83.5 ms |

Other facts from that run: reads alone are most of the open's `readMs` on desktop (Chromium 704 of 877 ms at 64 KiB). No format field overflows at 256 KiB (entry count, run length and table ids fit). A 256 KiB store of the 100 MB database takes 442 MiB of records against 292 MiB at 64 KB. Chromium 256K+split4 hit `QuotaExceededError` during `rotateDataKey`, so the bench now keeps the part instead of failing it. Profiles in `/tmp` (tmpfs, 1.6 GB free) made Firefox hit `QuotaExceededError`, so desktop runs used `TMPDIR` on disk.

Still skipped at the end of the run: #67 (blocked label, fixed, see above) and #63.

## Checkpoint findings

Checkpoint 1 (PR #69, 1bc6a64..c06f27f): no `src/` or crypto change, no blocker or major finding. Checks it ran: `node --check bench/run.mjs`, `npm run build`, `npm run lint`, `npm test`, `npm run test:browser -- --project chromium`, all exit 0. Firefox and WebKit full suites were left to CI (WebKit does not run on this host); that is "CI covers it", not a pass. The main-CI step was skipped because #67 was open and the newest run was in progress.

Minor findings it left in place, all in `bench/` or CI config:

1. Throttle value is not validated.
2. idbread has no cold-cache warm-up.
3. Split mode is not one transaction.
4. Stream bounds assume a divisor of 16.
5. idbmb input is unvalidated.
6. README names `bench/results/chromium-throttle4.json`, but the spike results moved into a dated directory.
7. `repo.node.test.ts` cannot tell a browser job on plain `pc-ci` from lint (it would need a job-name check).
8. `pc-ci-heavy` runner registration cannot be verified from the repo.
9. When `fill` or `readAll` throws in idbread, the local `openDb` connection is never closed. `dropIdb` only closes connections that `measure.ts` tracks, so `deleteDatabase` stays blocked and `run.mjs` waits out `PART_TIMEOUT` (1 h) instead of reporting the failure. Bench only.

Open findings carried from earlier reports, untouched this run and with no issue filed: the interrupted-rotation case with a damaged new store (old store intact but open fails); six minor `changeKey` items from the #36 review; the stale comment in `test/keys/crash.test.ts` (it describes one sync commit, there are two); the checkpoint 2 findings from 2026-11-13, which were never recorded in a file.

## Benchmark gates

Run on `main` at 0fb8bff: gates10, gates100, extras, year, 20 runs. Chromium 158 and Firefox 159 (headless, on the ROG G14 under the heavy lock) and WebKit 27.2 (Playwright WebKit on the Mac M1 Pro, not Safari, not WKWebView, faster hardware). Compare plain against encrypted within one engine, never absolute times across engines. Ratio is encrypted p50 over plain p50. Results are in `bench/results/2026-11-14/{chromium,firefox,webkit}.json` (commit 83a5bdd, PR #70). `node bench/gates.ts --factor 1` exits 0. Node has no row: the page needs IndexedDB. The `ops` part was not run this time.

| Gate | Target | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| G1 sync, 10 MB | ratio <= 2 | 0.05 pass | 0.04 pass | 0.02 pass |
| G1 sync, 100 MB | ratio <= 2 | 0.06 pass | 0.05 pass | 0.02 pass |
| G1b insert, 10 MB | ratio <= 2; <= 1 table block | 0.05 pass | 0.04 pass | 0.03 pass; table blocks p50 1, max 1 in all |
| G1b insert, 100 MB | ratio <= 2; <= 1 table block | 0.01 pass | 0.02 pass | 0.02 pass; table blocks p50 1, max 2 in all |
| G2 open, 10 MB | ratio <= 2 | 1.26 pass | 1.06 pass | 0.51 pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.40, 925 ms pass | 0.96, 1,255 ms pass | 0.68, 281 ms pass |
| G3 memory after open | db + 64 MB | not measurable (Chromium reports 486 MB at 10 MB and 449 MB at 100 MB, the whole renderer heap) | no memory API | no memory API |
| G4 segment switch, 10 MB | <= 500 ms; <= 10x plain sync | 86.3 ms pass | 267 ms pass | 30.7 ms pass |
| G4 segment switch, 100 MB | same | 93.8 ms pass | 276 ms pass | 36.2 ms pass |
| G5 unit size | n/a | one default unit, 64 KB; G2 passes at it | same | same |
| G6 support | all present | all 7 probes | all 7 probes | all 7 probes |
| G7 Rust store throughput | recorded only | owner only (Tauri shell) | owner | owner |
| G8 subkeys after a year (263 live salts) | <= 150 ms | 1.3 ms pass | 21.0 ms pass | 21.0 ms pass |
| G9 file-table phase, 10 MB | <= 5 % of G2 budget (about 20 ms) | 8.28 ms pass | 10.8 ms pass | 4.68 ms pass |
| G9 file-table phase, 100 MB | <= 75 ms | 11.0 ms pass | 21.2 ms pass | 5.64 ms pass |
| G9 table blocks in the G1 sync | p50 0; none without a file change | p50 0, at most 1 per changed file | same | same |

Reading:

- No judged gate fails. Sync is 17 to 100 times faster than plain (ratio 0.01 to 0.06) because only dirty records are written.
- Open at 100 MB is 0.68 to 1.40x plain. Chromium's ratio rose from 1.25 (2026-11-13) to 1.40 and Firefox's from 0.93 to 0.96; both are inside what a shared machine produces, but Chromium is the engine closest to the 2x limit. Firefox has the least headroom against 1,500 ms (1,255 ms).
- G3 is still not measurable headless. The two-page read-ahead (about 64 MB of ciphertext) is the whole G3 margin on paper.
- `SUMMARY.md` for this run was **not written**: the Write tool refused it in the benchmark subagent ("subagents should return findings as text") and the agent did not route around that with Bash. The numbers above come from the harness's summary of the JSON. `bench/results/2026-11-13/SUMMARY.md` is still stale from the earlier run. Both need regenerating from the JSON.
- The `ops` part was not run, so the Linux `QuotaExceededError` question from 2026-11-13 (headless profile on tmpfs) is still unanswered.
- Only the owner can measure G7, Tauri webviews, iPhone/iPad, Android and real Safari.

## SQLCipher parity as it stands

Source: `docs/plan/01-sqlcipher-comparison.md` section 2, 31 rows, last re-judged 2026-11-12. Count there: stronger 8, parity 14, n/a 2, weaker 7 (1 reduced, 6 accepted). This run changed no verdict, because `src/` did not change.

| Verdict | Rows |
|---|---|
| Stronger (8) | What is covered (every file under PGDATA); what the tag binds (AAD); truncation; replay of one unit; key hierarchy (KEK wraps DEK); wrong key vs corruption; rekey (`changeKey` instant, `rotateDataKey` resumable); integrity check (`verify()`; every open decrypts everything) |
| Parity (14) | Cipher and mode (AES-256-GCM); unit size; nonce and subkey; integrity primitive; swapped unit; modified unit; deletion of a whole file; whole-store rollback (not detected, accepted); opaque header and salt; raw key; key storage (app's job); metadata leakage; cipher agility; migration tooling |
| n/a (2) | Plaintext header option; key derivation (no passphrase) |
| Weaker (7) | Key material in memory; the whole database in memory; no `cipher_memory_security`; no FIPS build; durability (relaxed by default); no random access to a big database; maturity (new code, no external review) |

Where the table and reality differ:

- Open time: the section 3 estimate ("+0.5 to 4 s at 100 MB") now has shipped-code numbers on desktop (0.68 to 1.40x plain, 281 to 1,255 ms). Android remains the outlier (3.4x plain on the Redmi, from the 2026-11-13 report). The proposed 256 KiB block option (#63) would not fix it on desktop: it raises plain and encrypted open in Chromium and Firefox.
- Migration tooling is marked "parity once PC-10 is in"; owner question 1 was answered A and PC-10 was not filed. Treat the row as not applicable.
- "Stronger" describes the design and is exercised by `test/format`, `test/fs`, `test/keys`; this report did not rerun them. The interrupted-rotation finding is open.
- Maturity stays weaker. The package is not audited and must not be described as audited.

## What the owner must do next

1. **Decide #63.** Stage A missed its gate on Firefox (+28 %, +31 % on repeat) and WebKit with split4 (+18 %). Options: close #63 as not worth it on desktop; allow 256 KiB only where it helps (the issue's earlier decision rejected gating by engine); or accept the desktop cost for Android. No `src/` work should start before this.
2. **iPhone enc100 for #63** (commands are on #4). It needs the iPhone 15 unlocked and paired with the Mac. It is for the record only, since stage A already stopped on desktop.
3. **Remaining device runs** (checklist on #4): iPad Air M3 Safari `bench gates100` (confirms the #41 fix); Redmi `scripts/harness/remote.sh mac bash bench/device/redmi.sh gates100 3` (baseline for the Android number); macOS Tauri shell at 10 and 100 MB; the oldest supported iPhone (name it); Windows WebView2; Android WebView. Per memory notes, the article waits for #35/#41/#42 merged (done) and the device re-run.
4. **Owner-only boxes.** G7 (Rust store throughput; Tauri shell with `encfs-bench`; needs `docs/plan/journal/02-native-bench-endpoints.md`) and G3 on a device with a memory API. Rust/Tauri store issues are filed only after your G7 run.
5. **Confirm the `pc-ci-heavy` runner registration** on yantra-box and the Mac (item 8 above), then read CI once. #67 closes by itself on the next green main run. If it does not, the browser jobs are not being picked up.
6. **Regenerate** `bench/results/2026-11-13/SUMMARY.md` and write `bench/results/2026-11-14/SUMMARY.md` from the JSON, and rerun `ops` with the browser profile on a disk, not tmpfs.
7. **Decide whether to fix the idbread error-path connection leak** (checkpoint 1, finding 9) before the next bench run; it can hang a bench part for an hour.
8. **Decide which open findings block a release:** the damaged-new-store case at an interrupted rotation, the six minor `changeKey` items, and the unrecorded checkpoint 2 findings. Say which become issues.
9. **Before filing the on-demand build issue** (#47 decision), all of: a shell probe on iOS, Android and macOS shows `crossOriginIsolated` is true, sync handles work, and Journal's live blocks and remote images still load under COEP; the iPhone 15 and iPad spike runs survive 100 MB with an idle step added; Android and iPad G7 numbers are in. If the COEP probe fails, do not build; use the Rust store.
10. **Journal-side plan files** in `docs/plan/journal/` (13 files, `01` to `13`). No Journal-side work has been done by this harness. `07-1017-wire-encrypted-fs.md` is the one that uses this package. `08-native-migration.md` and `09-native-plaintext-sweep.md` are not needed under answer 1A. `02-native-bench-endpoints.md` is for G7; `03-query-cache-in-pglite.md` is the query cache; `11-settings-security.md`, `12-app-lock-desktop.md` and `13-ios-keychain-lock-privacy.md` are the settings and lock work. Any "encrypted at rest" claim per platform needs the scanner and device checklist from the plan; none is done. File the ones you want agents to take.
11. **Nightly workflow.** Trigger once with `workflow_dispatch` and read the first run. The 2,000-transaction crash matrices have not run to completion anywhere.
12. **Clean up.** Stale worktrees (`.claude/worktrees/wf_*`) and old local branches. The branch `agent/63-...` stays until #63 is decided.

## Risks

- **Android open time.** 8.6 s at 100 MB on the Redmi against a 3 s phone budget; unfixed. The only candidate fix so far (split4 / parallel parts) slows desktop, and 256 KiB blocks slow Firefox by about 30 %.
- **Chromium G2 margin.** 1.40x plain at 100 MB in this benchmark against a limit of 2x; the perf test in PR #61 measured 1.91 on a shared machine and the owner accepted that margin. It is the thinnest margin of the three engines.
- **Open memory.** The two-page read-ahead is about 64 MB of ciphertext on top of the database. G3 is unmeasurable headless; iPhone 15 survived at 100 MB with a 198 MB wasm heap, but the margin on older phones is unknown.
- **Whole database in memory**, plaintext, while the app is open. The app lock (J-12) is the mitigation. An on-demand design exists only as a spike.
- **CI is unverified for this run.** Main CI results for 0fb8bff and earlier were cancelled by newer pushes, and 7981fc2 was queued. The browser jobs now depend on `pc-ci-heavy` runners that the repo cannot show are registered. Firefox and WebKit full suites ran locally for none of the PRs in this run.
- **Benchmark scope.** Headless engines on a shared machine; WebKit is Playwright's build on faster hardware; no `SUMMARY.md` for this run; `ops` not run. Not Safari, not a webview, not a phone.
- **Maturity.** New cryptographic format, no external review, one author and agents. Keep the repository private; make no "audited" claim.
