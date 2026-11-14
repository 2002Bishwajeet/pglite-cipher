# pglite-cipher harness run, 2026-11-13 (final)

Base: `origin/main` at d14ce25 (merge of #64). This replaces the earlier versions of this file (PRs #32, #34, #40); they stay in git history. Sources: the harness result rows, `gh` for issues, PRs and comments, `bench/results/2026-11-13/*.json` as summarised by the benchmark step, `docs/plan/01-sqlcipher-comparison.md`. CI was not waited on. Nothing here was re-tested by this report.

## Summary

All agent-ready work in the queue is merged except the Android open-speed pair (#58, #63). 21 of 24 issues are closed; #4 (owner device runs), #58 and #63 are open. Eight issues were merged this run (#35, #41, #42, #44, #45, #47, #48, #49) plus the research issue #43. Seven of those first stopped at a harness STOP and moved on only after an owner or Fable decision. The benchmark ran on `main` at 12ee54d in Chromium, Firefox and WebKit: no judged gate fails. G3 (memory) and G7 (Rust store) are not measurable here. No `ci-failure` issue is open.

| Item | Result |
|---|---|
| Issues closed this run | #35, #41, #42, #43, #44, #45, #47, #48, #49 |
| Issues open | #4 (owner), #58 (blocked, decision posted), #63 (stage A bench, then stage B `src/`) |
| Checkpoints | 2, no blocker or major finding |
| Benchmark | 2026-11-13, `main` at 12ee54d, three engines, no gate fails |
| CI on main | 12ee54d succeeded; d14ce25 queued when this was written |

## What shipped

Issues merged this run, in merge order. Earlier issues (#1 to #3, #5 to #11, #26, #36) are in the 2026-11-11, -12 and earlier 2026-11-13 reports.

| Issue | What | PR |
|---|---|---|
| #43 | Research: on-demand encrypted storage under PGlite. `opfs-ahp://` reads on demand and saves 218 to 252 MB RSS for a 112 MB database in Chromium and Firefox; it does not open in WebKit (sync access handle limit). Encryption under it is possible with WebCrypto only, through an Atomics bridge to a crypto worker (0.02 to 0.36 ms per 8 KB page miss). No `src/` change | https://github.com/2002Bishwajeet/pglite-cipher/pull/46 |
| #44 | Bench device tooling: `redmi.sh` rebuilds `bench/dist`, each part is posted as it finishes, encrypted-only parts skip the plain build. `bench/` only | https://github.com/2002Bishwajeet/pglite-cipher/pull/50 |
| #35 | A strict sync (or `closeFs`) that joins an in-flight relaxed sync now commits strict: `#owesStrict` re-commits the unchanged root in one strict commit (identical sealed bytes, no nonce reuse). Three new sync tests, README flush-on-hide text updated. `test/keys/crash.test.ts` changed in two owner-approved lines (`switchAt + 4`, `k < end - 1`) | https://github.com/2002Bishwajeet/pglite-cipher/pull/51 |
| #45 | `decodeTable` checks a run's whole length before copying ids, so a corrupt count (25,603 ids in seed 905168194) is rejected at once with `CorruptStoreError`. Counterexample added as a fixed regression test; fuzz budget and case count unchanged | https://github.com/2002Bishwajeet/pglite-cipher/pull/52 |
| #48 | Memory levers, measured by new bench parts `levers10`/`levers100`. At 100 MB, `min_wal_size`/`max_wal_size=32MB` plus a CHECKPOINT shrinks the data dir 254 to 158 MB and the open is 20 to 26 % faster. `shared_buffers=16MB` keeps wasm at its 128 MB floor. `initialMemory` cannot go below 128 MB (`PGlite.create` hangs). README gains "Running on mobile". No durability setting weakened | https://github.com/2002Bishwajeet/pglite-cipher/pull/53 |
| #42 | `closeFs` clears `#FS`, `#tracker` and `#map` before `backend.close()`. `release.test.ts`: 6 cycles, bound 1 in Node, Chromium, Firefox and 2 only in WebKit, a `WeakRef(pg.Module)`, and an assertion that fails if a closed instance still holds a file map | https://github.com/2002Bishwajeet/pglite-cipher/pull/54 |
| #47 | Spike only, no `src/` change: PGlite filesystem through an Atomics bridge over OPFS. Open: Chromium 353 vs 809 ms for `idb://`, Firefox 347 vs 1,457, WebKit 270 vs 975, simulator 291 vs 1,927. AES-GCM adds 49 to 286 ms to a cold scan | https://github.com/2002Bishwajeet/pglite-cipher/pull/55 |
| Checkpoint 1 | Review and simplify c65c53c..43e1925: fixed a typecheck failure on main in `bench/`, closed the lever probe in a `finally` | https://github.com/2002Bishwajeet/pglite-cipher/pull/56 |
| Bench | Bench page readable in dark mode | https://github.com/2002Bishwajeet/pglite-cipher/pull/57 |
| CI | Run on any free self-hosted runner (`pc-ci`); WebKit jobs on yantra-box; the repo test fixed for `pc-ci` | https://github.com/2002Bishwajeet/pglite-cipher/pull/59, https://github.com/2002Bishwajeet/pglite-cipher/pull/60 |
| #41 | Bench measurement order corrected: each timed G2 open follows an untimed open of its own variant. `src/` and format unchanged. Desktop WebKit gates100: G2 0.83x plain at 383 ms. Chromium perf test G2 is 1.91 against the 2.0 limit | https://github.com/2002Bishwajeet/pglite-cipher/pull/61 |
| #49 | After a failed close-time sync `EncryptedFs` holds no reference to the PGlite instance, module, tracker or file map; `close()` still rejects with the backend's error. README states that PGlite 0.5.10 keeps its own module until the app drops the instance. New `test/fs/close-failed.test.ts` | https://github.com/2002Bishwajeet/pglite-cipher/pull/62 |
| Bench | Results 2026-11-13 (three JSON files) | https://github.com/2002Bishwajeet/pglite-cipher/pull/64 |

Device evidence, owner runs: iPhone 15 (iOS 18.7 Safari, `enc100`, 3 runs, `origin/main` 9b21b6b with the #42 fix): the tab survived build, 3 opens, G3, changeKey/verify/rotateDataKey and 3 opens after rotation; before the fix it died on the third open. p50 G2 open 1,273 ms (readMs 977, decryptMs 123), wasm heap 198 MB. Redmi (Chrome Android), 100 MB: plain `idb://` open 2,521 ms, encrypted open after rotation 8,578 ms (readMs 7,719, decryptMs 1,241). iPad Air M3: encrypted open about 0.3 s.

## What stopped, and why

Every STOP below was posted on the issue. "Fable" is the review that decides when the owner does not answer (harness owner gates).

| Issue | Stop condition | Resolution |
|---|---|---|
| #35 | Verification or review still failing after escalation: the crash matrix test had to change (a rule in CLAUDE.md: tests are not loosened by the agent). Branch `agent/35-...-rela-3` pushed, `blocked` added | Owner approved exactly two lines of `crash.test.ts`. Merged in #51. Closed |
| #43 | The doc's own STOP: "the owner decides whether to build it" | Owner: go. Research merged (#46); follow-ups #47 and #48 |
| #42 | The release test's bound (at most one closed instance reachable) cannot hold in WebKit through any change in `EncryptedFs`: plain PGlite with no pglite-cipher code also keeps 2 closed instances after a forced full GC there. Loosening needs the owner (issuecomment-6853534809) | Decision (Fable review, adopted by the owner): bound 1 everywhere, 2 only in WebKit, with a revert proof and 20 consecutive WebKit passes. Merged #54. iPhone 15 run passed |
| #45 | Verification incomplete: the agent was made to return while `npm test` still ran on the box. Nothing committed | Re-run, merged #52 |
| #47 | The issue's own STOP: the owner decides whether to build design A in `src/` (needs format work for crash safety on OPFS) | Decision (Fable review): build later, not now; spike merged as spike-only (#55). Gates for filing the build issue are listed under "What the owner must do next" |
| #49 | Not a listed STOP condition: the issue's Verification (instance released by the same check as `release.test.ts`) contradicts its Change, because PGlite keeps the module when `closeFs` rejects. Making the test pass would mean writing PGlite's protected `mod` field. A second stop: `npm test` was red only on `test/repo.node.test.ts`, which still matched `[self-hosted, yantra-box]` after #59 moved CI to `[self-hosted, pc-ci]`, on `origin/main` too | The fix releases what EncryptedFs holds and documents PGlite's behaviour (the issue's own fallback); the repo test was fixed in #60. Merged #62 |
| #41 | The gap only shows on the physical device. Later: the reviewer asked the owner to accept the smaller Chromium G2 margin (1.91 against 2.0) | The owner accepted the corrected measurement order and the margin. Merged #61. Device re-run on the iPad is owner-only (below) |
| #58 | The change speeds Android but slows desktop Chromium encrypted readMs by more than 10 % (g2 open p50 1,125.8 ms on main, 1,264.0 on the branch, +12.3 %; readMs +14.3 %; n=5 each, back to back). Firefox borderline (+11.8 % readMs after rotation). The Redmi gates100 gate (readMs at least 25 % better) has no measurement. Branch `agent/58-android-encrypted-open-reads-3-4-slower` pushed, `blocked` label created | Decision (Fable review, owner unavailable): do not merge split4 (6d75d8b) and do not gate by engine; land only the bench spike 7e6881e with `src/backend/indexeddb.ts` restored to main; a 262,144-byte block is approved as an opt-in v1 option if stage A passes; 1 MiB rejected. Follow-up #63. **#58 is still open: the bench spike has not been landed**, and the `blocked` label is gone from its labels |

## Checkpoint findings

Checkpoint 1 (PR #56, c65c53c..43e1925): no blocker or major. Fixes in `bench/` only (above). Minor findings it left, two of which are now closed:

1. `closeFs` left `#unsettled` set, so a closed instance kept plaintext copies of the unsynced blocks after a failed final sync. Fixed by #62.
2. Comments in `crash.test.ts` still describe one sync commit; there are now two (the relaxed commit from the INSERT, then the strict root commit). The assertion is right; the comment is stale. Open.

Checkpoint 2 (43e1925..12ee54d, 19 commits, 25 files): `code-review` at medium gave 9 findings, none a confirmed blocker or major within the merged issues, so nothing was fixed or committed. The findings were not recorded in a file and are not reproduced here. `simplify` ran as one inline pass and found nothing to change. **Not run:** build, `npm test`, `npm run test:browser`. The heavy lock was held by another session's cargo build for over an hour and the queued build was killed (exit 143). Lint passed. Main CI for 12ee54d later succeeded.

Open findings from earlier checkpoints that this run did not touch: an interrupted rotation whose new store has a damaged root or header fails to open though the old store is intact (PR #24); six minor `changeKey` items from the #36 review (torn header read as the new or old key, `headerKey` swallowing non-key errors, "unknown" covering a corrupt header, settle logic separate from `commitSettled`, and no tests for a torn header or for a retry after `KeyChangeUnknownError`). No issue is filed for them.

## Benchmark gates

Run on `main` at 12ee54d: gates10, gates100, extras, year, ops. Chromium 158 and Firefox 159 (headless) on the ROG G14 (Ryzen 5 4600HS, 15 GiB), shared with other sessions, so absolute timings are noisy. WebKit through `scripts/harness/webkit.sh` on the Mac: Playwright WebKit, not Safari, not WKWebView, faster hardware. Compare plain against encrypted within one engine, never absolute times across engines. Ratio is encrypted p50 over plain p50. Results are in `bench/results/2026-11-13/{chromium,firefox,webkit}.json` (commit 23d1d1c, PR #64). Node has no row: the page needs IndexedDB and a DOM; Node is covered by the test suite.

| Gate | Target | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| G1 sync, 10 / 100 MB | ratio <= 2 | 0.06 / 0.06 pass | 0.05 / 0.05 pass | 0.02 / 0.02 pass |
| G1b insert, 10 / 100 MB | ratio <= 2; <= 1 table block (p50) | 0.05 / 0.01 pass; p50 1 | 0.05 / 0.01 pass; p50 1 | 0.03 / 0.02 pass; p50 1 |
| G2 open, 10 MB | ratio <= 2 | 1.19 pass | 1.05 pass | 0.51 pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.25, 980 ms pass | 0.93, 1,299 ms pass | 0.68, 293 ms pass |
| G3 memory | db + 64 MB | not measurable | not measurable | not measurable |
| G4 segment switch, 10 / 100 MB | <= 500 ms, <= 10x plain sync | 95 / 97 ms pass | 263 / 299 ms pass | 31 / 34 ms pass |
| G5 unit size | n/a | single 64 KB default | same | same |
| G6 support | all present | all present | all present | all present |
| G7 Rust store | recorded only | owner (Tauri) | owner | owner |
| G8 year (365 sessions) | <= 150 ms | 2.6 ms pass | 10.5 ms pass | 21.0 ms pass |
| G9 file-table phase, 10 / 100 MB | <= 5 % of G2 budget (about 20 ms) / <= 75 ms | 8.6 / 12.5 ms pass | 9.1 / 19.1 ms pass | 4.6 / 5.7 ms pass |
| G9 table blocks in G1 sync | p50 0 | p50 0 pass | p50 0 pass | p50 0 pass |

Reading:

- No judged gate fails in any engine. Sync is 17 to 100 times faster than plain (ratio 0.01 to 0.06) because only dirty records are written.
- Open at 100 MB is 0.68 to 1.25x plain. Firefox has the least headroom against 1,500 ms (1,299 ms). Chromium's G2 ratio is 1.19 to 1.25 here, 1.91 in the perf test of PR #61 (a different measure on a shared machine); the owner accepted that margin.
- G3 is not measurable headless: Chromium reports the renderer heap including baseline, Firefox and WebKit have no API. The two-page read-ahead of #10 is about 64 MB of ciphertext, which is the whole G3 margin on paper.
- **`ops` threw `QuotaExceededError` in Chromium and Firefox again** (WebKit completed it). The likely cause is the headless profile on this host's 7.6 GB tmpfs `/tmp`; that is not verified. `ops` is not a gate, but it makes `node bench/gates.ts --factor 1` exit 1.
- **`bench/results/2026-11-13/SUMMARY.md` is stale.** It describes the earlier run at ae2b2f6 (G2 100 MB: Chromium 1.34, Firefox 0.96, WebKit 0.92). The Write tool refused the bench agent's rewrite, so the numbers above come from the harness's summary of the new JSON, not from SUMMARY.md. It must be regenerated from the JSON.
- Memory levers (#48, PR #53): see `bench/results/2026-11-13/memory-levers.md`.

## SQLCipher parity as it stands

Source: `docs/plan/01-sqlcipher-comparison.md` section 2, 31 rows, last re-judged on 2026-11-12. Count there: stronger 8, parity 14, n/a 2, weaker 7 (1 reduced, 6 accepted). This run changed no verdict.

| Verdict | Rows |
|---|---|
| Stronger (8) | What is covered (every file under PGDATA); what the tag binds (AAD); truncation; replay of one unit; key hierarchy (KEK wraps DEK); wrong key vs corruption; rekey (`changeKey` instant, `rotateDataKey` resumable); integrity check (`verify()`; every open decrypts everything) |
| Parity (14) | Cipher and mode (AES-256-GCM); unit size; nonce and subkey; integrity primitive; swapped unit; modified unit; deletion of a whole file; whole-store rollback (not detected, accepted); opaque header and salt; raw key; key storage (app's job); metadata leakage; cipher agility; migration tooling |
| n/a (2) | Plaintext header option; key derivation (no passphrase) |
| Weaker (7) | Key material in memory; the whole database in memory; no `cipher_memory_security`; no FIPS build; durability (relaxed by default); no random access to a big database; maturity (new code, no external review) |

Where the table and reality differ:

- Durability: #35 is merged, so a strict sync that joins a relaxed one now commits strict and the README's flush-on-hide text is accurate. Still relaxed by default; crash consistency (all or nothing) is unchanged.
- Memory: #42 and #49 make a closed instance release the file map, tracker and unsynced snapshot. The 100 MB database still sits in memory while open. On iPhone 15 it now survives three opens (1,273 ms p50). The weaker rows "whole database in memory" and "no random access" stand; #47 shows an on-demand design is possible in Chromium and Firefox but not built.
- Open time: the section 3 estimates now have shipped-code numbers on desktop (0.68 to 1.25x plain at 100 MB). Android is the outlier: 3.4x plain on the Redmi, 90 % of it IndexedDB read time (#58).
- Migration tooling is marked "parity once PC-10 is in"; owner question 1 was answered A, PC-10 was not filed. Treat the row as not applicable.
- "Stronger" describes the design and is exercised by `test/format`, `test/fs`, `test/keys`; this report did not rerun them. The interrupted-rotation finding (damaged new store) is open.
- Maturity stays weaker. The package is not audited and must not be described as audited.

## What the owner must do next

1. **Device re-runs** (also on #4, which has an owner-only checklist from #41):
   - iPad Air M3, Safari: `bench gates100`, confirm G2 at 100 MB is within 2x plain and 1,500 ms with the corrected measurement order, and read the new `openBeforeRotation` vs `openAfterRotation` split.
   - Redmi: `scripts/harness/remote.sh mac bash bench/device/redmi.sh gates100 3` for the #63 stage A baseline.
   - iPhone `enc100` for #63 stage A (comment on #4 with commands).
   - The #4 list still stands: macOS Tauri shell at 10 and 100 MB, the oldest supported iPhone (name it), Windows WebView2, Android WebView.
2. **Owner-only boxes.** G7 (Rust store throughput, Tauri shell with `encfs-bench`, needs `docs/plan/journal/02-native-bench-endpoints.md`) and G3 on a device with a memory API. Per the memory notes, Rust/Tauri store issues are filed only after your G7 run.
3. **Land #58.** Merge the bench spike 7e6881e and its result files with `src/backend/indexeddb.ts` restored to main; do not merge 6d75d8b (split4). The branch `agent/58-android-encrypted-open-reads-3-4-slower` has 3 commits including the local merge b595f78; make a clean branch rather than merging it. Then #63 stage A.
4. **Before filing the on-demand build issue** (#47 decision), all of: a shell probe on iOS, Android and macOS shows `crossOriginIsolated` is true, sync handles work, and Journal's live blocks and remote images still load under COEP; the iPhone 15 and iPad spike runs survive 100 MB with an idle step added (WebKit's 1 s AES point query is unexplained); Android and iPad G7 numbers are in; #41 and #49 merged (done). If the COEP probe fails, do not build; use the Rust store.
5. **Regenerate `bench/results/2026-11-13/SUMMARY.md`** from the JSON, and rerun `ops` with the browser profile on a disk, not the tmpfs.
6. **Decide which open findings block a release:** the damaged-new-store case at an interrupted rotation, the six minor `changeKey` items, and the checkpoint 2 findings (not recorded). Say which become issues.
7. **Checkpoint 2 gap.** Build, `npm test` and `npm run test:browser` did not run at that checkpoint; CI on 12ee54d succeeded, which is the only evidence.
8. **Journal-side plan files** in `docs/plan/journal/` (17 files, `01` to `17`). No Journal-side work has been done by this harness. `07-1017-wire-encrypted-fs.md` is the one that uses this package. `08-native-migration.md` and `09-native-plaintext-sweep.md` are not needed under answer 1A. `16-at-rest-scanner-e2e-device-checklist.md` gates any "encrypted at rest" claim per platform. File the ones you want agents to take (`01`, `04`, `05`, `06`, `07`, `10` to `15`, `17` are the main chain; `02` is for G7; `03` is the query cache).
9. **Nightly workflow.** Trigger once with `workflow_dispatch` and read the first run. The 2,000-transaction crash matrices have not run to completion anywhere.
10. **Clean up.** Stale worktrees (`.claude/worktrees/wf_*`) and the local branches from earlier runs; the `agent/35-...-rela`, `-rela-2`, `-rela-3` remote branches are superseded by #51.
11. **Read CI once.** A red result comes back as a `ci-failure` issue; none is open.

## Risks

- **Android open time.** 8.6 s at 100 MB on the Redmi against a 3 s phone budget; unfixed. #63 stage A may not explain it (the raw 64 KB read is 2,254 ms but real readMs is 7,719 ms).
- **Open memory.** The two-page read-ahead is about 64 MB of ciphertext on top of the database. Unmeasurable headless; iPhone 15 survived at 100 MB with a 198 MB wasm heap, but the margin on older phones is unknown.
- **Whole database in memory**, plaintext, while the app is open. The app lock (J-12) is the mitigation. An on-demand design exists only as a spike.
- **WebKit release bound.** The leak test allows 2 closed instances in WebKit because plain PGlite does the same; a regression of one instance there would not fail the test.
- **Verification gaps.** Firefox and WebKit full suites ran locally for few of these PRs (`ci-covers` is not a pass); a WebKit-only failure (#26) already got through the local gate once. Checkpoint 2 skipped build and tests.
- **Test changes.** `crash.test.ts` changed by two owner-approved lines in #51; the stale comment there is the only follow-up.
- **Benchmark scope.** Headless engines on a shared machine; WebKit is Playwright's build on faster hardware; `SUMMARY.md` is stale; `ops` is unmeasured on Linux. Not Safari, not a webview, not a phone.
- **Maturity.** New cryptographic format, no external review, one author and agents. Keep the repository private; make no "audited" claim.
