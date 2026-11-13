# pglite-cipher harness run, 2026-11-13

Base: `origin/main` at 2223cf1 (merge of #33). This replaces the earlier version of this file (PR #32, written at 926fd25 after the first #10 stop and the first bench run of the day); that version stays in git history. Sources: the harness result rows, `gh` for issues and PRs, `bench/results/2026-11-13/SUMMARY.md`, the comments on #10 and #4, `docs/plan/01-sqlcipher-comparison.md`. CI was not waited on.

## Summary

This run did two things. It tried #10 again under the owner-delegated decision on that issue, and stopped a second time. It re-ran the benchmark page on all three engines (PR #33), with the same verdicts as before.

The #10 stop is now better measured than on the first attempt. Chromium, 10 MB, yantra-box, G2 (encrypted open p50 / plain `idb://` open p50, limit 2.0):

- With plain and encrypted opens interleaved and 20 opens per variant (decision step (b)), and the open code as on `main`: 4 of 10 runs fail, median 1.815, range 1.73 to 2.05.
- With a one-page read-ahead in the open (step (a)) and the same interleaving: all 10 runs pass, median about 1.5, range 1.41 to 1.57. But it makes two existing tests fail (`test/fs/memory.test.ts`, "a load holds at most one page of ciphertext at a time", review S5), and the decision forbids editing existing tests. The read-ahead was reverted and is not on the pushed branch.

So the speed-up that works breaks a memory guarantee recorded as review S5. Choosing between them is the owner's. No gate was loosened.

The benchmark page still measures the spike prototype, not `src/`. Verdicts match the earlier 2026-11-13 run and 2026-11-12: Chromium fails G2 at small units and G3 everywhere; Firefox fails G4 at 8 KB; 64 KB passes G2 in every engine.

| Item | Result |
|---|---|
| PRs merged this run | #33 (bench results). #32 (the earlier version of this report) merged before it |
| Issues closed this run | none |
| Stopped | #10 (label `blocked`), second time |
| Open, owner only | #4 |
| Checkpoints | 0 |
| Benchmark | ran, PR #33 |
| Overall | 10 of 12 issues closed (#1 to #3, #5 to #9, #11, #26); #4 and #10 open |

## What shipped

Issue by issue, for the whole project. Only the last row is from this run.

| Issue | What | PR |
|---|---|---|
| #1 | Scaffold: TypeScript build, tests in Node and three browser engines, CI, licence placeholder | https://github.com/2002Bishwajeet/pglite-cipher/pull/12 |
| #2 | Spike: prototype filesystem, filesystem-operation trace, benchmark page with gates | https://github.com/2002Bishwajeet/pglite-cipher/pull/18 |
| #3 | Spike gate (provisional): decision recorded as a comment on the issue, 64 KB block, IndexedDB, budgets 1,500 / 3,000 ms. No PR | issue comment |
| #5 | Format v1 and crypto core | https://github.com/2002Bishwajeet/pglite-cipher/pull/20 |
| #6 | Dirty-block tracker with a model-based property test | https://github.com/2002Bishwajeet/pglite-cipher/pull/13 |
| #7 | Storage backend interface, IndexedDB and in-memory backends, fault injection | https://github.com/2002Bishwajeet/pglite-cipher/pull/21 |
| #8 | `EncryptedFs` (open, sync, close) on format v1 | https://github.com/2002Bishwajeet/pglite-cipher/pull/23 |
| #9 | `changeKey`, crash-safe `rotateDataKey`, `verify()` | https://github.com/2002Bishwajeet/pglite-cipher/pull/24 |
| #11 | Agent device benchmarks (macOS WebKit, WKWebView, iOS simulator) | https://github.com/2002Bishwajeet/pglite-cipher/pull/19 |
| #26 | CI red on main (WebKit-only failure) | https://github.com/2002Bishwajeet/pglite-cipher/pull/27 |
| Checkpoints | 1 (#14, #25) and 2 (#28): review and simplify | https://github.com/2002Bishwajeet/pglite-cipher/pull/28 |
| Other | #16 WebKit container under the heavy lock; #22 native PostgreSQL encryption comparison; reports #15, #17, #30, #32 | |
| Bench | Results for Chromium 158, Firefox 159, WebKit (Mac), 10 MB and 100 MB, extras, 365-session year run. `bench/results/2026-11-13/` replaced in place; the earlier run of the day is commit 5dccf50 (PR #31) | https://github.com/2002Bishwajeet/pglite-cipher/pull/33 |

PR #33 adds result files only. Commit 95fb8b8, on branch `agent/bench-2026-11-13b` (the name `agent/bench-2026-11-13` was used by #31).

## What stopped, and why

### #10 Benchmark gates in CI, long runs, SECURITY.md

Issue: https://github.com/2002Bishwajeet/pglite-cipher/issues/10. Latest STOP comment: https://github.com/2002Bishwajeet/pglite-cipher/issues/10#issuecomment-6844035339. The first STOP (comment 6841656075) is superseded by it. Decision that this run followed: comment 6843068992. Labels now `agent-ready`, `security`, `blocked`.

Condition (decision step (b)): "If the gate still fails more than once in 10 runs, STOP and report the spread and the read/decrypt split, and don't merge #10." It fails 4 of 10.

G2 ratio per run, Chromium, 10 MB, yantra-box, limit 2.0:

| Variant | Runs | Pass | Median |
|---|---|---|---|
| (a) one-page read-ahead, opens not interleaved | 1.79, 2.2, 1.62, 1.62, 1.57, 1.65, 1.63, 1.59, 1.56, 1.65 | 9 of 10 | about 1.62 |
| Read-ahead plus (b), interleaved, 20 opens | 1.48, 1.41, 1.48, 1.53, 1.55, 1.57, 1.55, 1.46, 1.53, 1.48 | 10 of 10 | about 1.5 |
| (b) alone, open code as on `main`, interleaved, 20 opens | 1.81, 1.76, 1.85, 1.73, 2.03, 2.01, 2.05, 2.03, 1.82, 1.75 | 6 of 10 | 1.815 |

Read/decrypt split of the encrypted open, p50, run 3a: open 721 ms, data blocks 552 ms, of which IndexedDB read 367 ms and decrypt 126 ms, file table 11.3 ms. Plain open p50 397 ms. Over the ten runs read is 298 to 417 ms and decrypt 104 to 144 ms, so IndexedDB reads take most of the open, not decryption. (The first STOP assumed decryption dominated: 463 of 570 ms for "the data-block phase". The split corrects that.) `PAGE` 256 and 1024 gave no clear gain over 512 (5 runs each); it stays 512.

Why the read-ahead was reverted: with it, a load holds two pages of ciphertext at once, and `test/fs/memory.test.ts` fails 2 tests. The decision does not allow editing existing tests.

Not run, because of the stop: the long suites (`CIPHER_LONG=1 CIPHER_SOAK_MINUTES=5`), `test:browser` on all engines, build, `bench:build`. A baseline `npm test` of `main` on yantra-box was attempted, but dependencies were not installed there. So the #10 branch is verified only by the perf runs above.

Where the work is:

- Branch `worktree-wf_1d72e28d-3b0-2` on origin, new this run: 4 commits against `origin/main` (5feaf2f, merge bdb37f1, 2f34dcb, 5c6ba2e). No force push. It adds the interleaved `runPair`, 20 opens and the read/decrypt split to the perf test, on top of the earlier #10 work (bench move from `spike/`, CI gates, pgvector dev dependency).
- `origin/agent/10-benchmark-gates-in-ci-long-fuzz-crash-so` is at 2f34dcb. The local `agent/10-...` ref is still held by the stale worktree `.claude/worktrees/wf_47356dba-866-30` (at 5feaf2f), which is why the agent had to use a worktree-named branch.
- The five review decisions on #10 (comment 6841220006) stand until reversed.
- Never pushed to `main`.

### #4 Owner device runs (open, not for agents)

Unchanged. See "What the owner must do next".

## Checkpoint findings

No checkpoint ran this run. The open findings from checkpoints 1 and 2 and from the PR reviews stand as listed in the 2026-11-12 report. The ones that matter most for a release:

- `changeKey` does not settle an unknown outcome: the store can be under the new key while the caller was told it failed (PR #24).
- A strict sync that joins an in-flight relaxed sync resolves without a strict commit; the README's flush-on-hide claim is not always true (PR #23).
- Open of an interrupted rotation whose new store has a damaged root or header fails, though the old store is intact (PR #24).

## Benchmark gates

Source: `bench/results/2026-11-13/SUMMARY.md`, run on `main` at 78e5851, 20 runs per measure, p50. Parts gates10, gates100, extras, year.

What was measured: the benchmark page (`bench/`, through `spike/run.mjs`) benchmarks the spike prototype `spike/protoFs.ts`, not `src/EncryptedFs`. It needs IndexedDB and a DOM, so there is no Node row. "10 MB" and "100 MB" are blob payloads; the data directories are 64.7 MiB and 254.2 MiB. Chromium 158 and Firefox 159 ran on the G14 (Ryzen 5 4600HS, 15 GiB) shared with other sessions, so timings are noisy. WebKit ran on the Mac (M1 Pro, macOS 27.0.1) through `webkit.sh`: Playwright WebKit, not Safari and not WKWebView. Compare plain against encrypted inside one engine, never across engines. Chromium's G3 reads `performance.memory`; Firefox and WebKit have no memory API the page can use.

Times in ms, p50. Cells list unit sizes 8 / 32 / 64 KB.

| Gate | Target | Chromium | Firefox | WebKit (Mac) |
|---|---|---|---|---|
| G1 sync, one-row UPDATE, 100 MB | enc <= 2x plain | plain 83.0; 0.70 / 0.83 / 0.80: pass | plain 159; 1.70 / 1.62 / 1.64: pass | plain 160; 0.38 / 0.44 / 0.44: pass |
| G1b sync, 4 KB insert, 100 MB | <= 2x plain, <= 1 table block | plain 589; 1.08 / 1.18 / 1.56: pass | plain 746; 2.30 / 2.40 / 3.86: pass | plain 273; 0.66 / 0.92 / 1.02: pass |
| G2 open, 10 MB | <= 2x plain | plain 370; 970 FAIL / 648 / 429 | plain 640; 741 / 576 / 598 pass | plain 284; 145 / 117 / 137 pass |
| G2 open, 100 MB | <= 2x plain and <= 1,500 | plain 715; 2,918 FAIL / 1,661 FAIL / 853 pass | plain 1,286; 2,044 FAIL / 1,285 / 1,187 pass | plain 418; 367 / 257 / 244 pass |
| G3 memory | open <= db + 64 MB | FAIL at every unit: 100 MB 737 / 721 / 672 MB (plain `idb://` 721 MB); 10 MB 510 / 374 / 375 MB (plain 398 MB) | not available | not available |
| G4 segment switch, 100 MB | <= 500 | 191 / 106 / 81.7: pass | 618 FAIL / 328 / 273 pass | 114 / 58.2 / 31.7: pass |
| G5 unit size | smallest unit passing G2 | 32 KB at 10 MB; 64 KB at 100 MB | 8 KB at 10 MB; 32 KB at 100 MB | 8 KB at both |
| G6 support | all present | pass | pass | pass |
| G7 Rust store throughput | recorded only | owner (Tauri) | owner | owner |
| G8 subkeys, 366 live salts | <= 150 | 3.66: pass | 36.6: pass | 21.96: pass |
| G9 file table | file-map <= 5% of G2 budget; G1 p50 writes no table block | 7.69 to 28.7 at 100 MB (budget 75): pass | 10.4 to 42.3: pass | 9.92 to 24.5: pass |

Reading:

- Sync is two to three orders of magnitude faster than plain at 100 MB (one-row update: 0.4 to 1.7 ms against 83 to 160 ms). Query time is unchanged by design.
- Open is the cost. At 64 KB every engine meets G2 at both sizes. At 8 KB, Chromium and Firefox fail G2 at 100 MB; at 32 KB Chromium fails it at 100 MB (1,661 ms) and passes at 10 MB. Chromium also fails G2 at 8 KB at 10 MB (970 ms against plain 370). The 64 KB default chosen at #3 is the only unit that passes in all three engines.
- G3 fails in Chromium at every unit, as plain `idb://` does at 100 MB (721 MB): PGlite on IndexedDB holds the whole directory in memory. At 10 MB the plain run (398 MB) is under the 8 KB run (510 MB) and above the other two, so the 10 MB figures mostly show noise.
- Firefox fails G4 at 8 KB (618 ms at 100 MB, 560 at 10 MB). Not the default unit.
- G9 read strictly (no table block in any G1 sync) fails at every unit in every engine, because in 1 to 2 of 20 syncs a file grew and one table block was written. Under the restated rule (the p50 writes no table block) it passes. The page's `G9` flag is the strict one.
- Against the earlier run of the day (on `2efe68f`) verdicts are the same. Moves: Chromium 100 MB open at 64 KB 853 ms (was 865), Firefox G4 at 100 MB 618 ms (was 609), WebKit G8 21.96 ms (was 14.6).
- The year run (365 sessions) ended at 366 live salts and 7,252 live records in every engine. It took 324 s (Chromium), 268 s (Firefox), 62 s (WebKit).
- The #10 STOP is the only measurement of the shipped code: Chromium open at 10 MB is 1.7 to 2.05x plain on `main`'s code, and the 64 KB prototype figure above (429 ms, 1.16x) was optimistic by comparison. The two are different machines (plain open 397 ms on yantra-box, 370 on the G14) and different code.

Device numbers from #11 (macOS WebKit, WKWebView, iOS simulator) are in `spike/RESULTS.md` section 6 and the 2026-11-12 report. They were not repeated. WKWebView passes; the simulator says nothing about a phone.

## SQLCipher parity as it stands

Table: `docs/plan/01-sqlcipher-comparison.md` section 2, 31 rows. Last edited 2026-11-12 (native PostgreSQL comparison only); it has not been revised for what shipped. Count: stronger 8, parity 14, n/a 2, weaker 7 (1 reduced, 6 accepted).

| Verdict | Rows |
|---|---|
| Stronger (8) | What is covered (every file under PGDATA); what the tag binds (AAD); truncation; replay of one unit; key hierarchy (KEK wraps DEK); wrong key vs corruption; rekey (`changeKey` instant, `rotateDataKey` resumable); integrity check (`verify()`, every open decrypts everything) |
| Parity (14) | Cipher and mode (AES-256-GCM); unit size; nonce and subkey (v5-style, per-session subkey); integrity primitive; swapped unit; modified unit; deletion of a whole file; rollback of the whole store (not detected, accepted); opaque header and salt; raw key; key storage (app's job, OS keychain); metadata leakage; cipher agility; migration tooling |
| n/a (2) | Plaintext header option; key derivation (no passphrase) |
| Weaker (7) | Memory for key material; whole database in memory; no `cipher_memory_security`; no FIPS build; durability (relaxed by default); no random access to a big database; maturity (new code, no external review) |

Where the table and reality differ:

- Migration tooling is marked "parity once PC-10 is in". Owner question 1 was answered A (encryption in the first public native build), so plan file 10 was not filed. Treat the row as not applicable.
- "Stronger" describes the design. Tests in `test/format`, `test/fs` and `test/keys` exercise it, per the PR descriptions; this report did not rerun them. Two of those rows carry open findings (rekey: the `changeKey` unknown-outcome gap; integrity at an interrupted rotation with a damaged new store).
- The performance rows in section 3 are backed by prototype numbers only, apart from the #10 stop. Section 3.2 estimated open at 100 MB at "+0.5 to 4 s at 8 KB, about a third of that at 64 KB"; the prototype gives +2.2 s at 8 KB in Chromium (2,918 against 715) and +0.14 s at 64 KB (853 against 715).
- Maturity stays weaker. The package is not audited and must not be described as audited.

## What the owner must do next

1. Decide on #10. Options:
   - Allow two pages of ciphertext in flight during open. This changes the S5 memory test ("a load holds at most one page") by one page, and the measured effect is G2 median about 1.5, 10 of 10 passing. An agent can then re-apply the read-ahead and finish #10.
   - Keep one page in flight and restate G2 for Chromium at 10 MB (for example 2.2, or a median-based rule). With the open as it is, 4 of 10 runs exceed 2.0, median 1.815.
   - Take the plan's remaining options from the decision comment: lazy loading (a format change) or accepting a slower open for small stores.
   Agents cannot loosen the gate or edit the S5 test. Then confirm or reverse the five decisions in comment 6841220006. Remove the `blocked` label when you want #10 picked up, and either use the pushed branch `worktree-wf_1d72e28d-3b0-2` or remove the stale worktree `.claude/worktrees/wf_47356dba-866-30` so the `agent/10-...` ref can move to 5c6ba2e.
2. Triage the benchmark failures: Chromium G3 (fails for plain `idb://` too), Firefox G4 at 8 KB (not the default unit), and G7 (owner-only).
3. Decide whether the open findings from #23 and #24 (especially `changeKey` unknown outcome) block a release, and which become follow-up issues.
4. Device runs on #4 (about an hour). Paste JSON on #4:
   - macOS in the Tauri shell, at 10 MB and 100 MB.
   - The oldest iPhone you will support (name it). This tests the 3 s phone budget; the simulator cannot.
   - Windows (WebView2) and Android WebView if a device is at hand.
   - iPhone 15, iPad Air (M3) and the Redmi need unlocking or pairing first (checkboxes on #4): `scripts/harness/remote.sh mac bash spike/device/mac.sh iphone-15`; `bash spike/device/redmi.sh` after `adb pair`/`adb connect`.
5. Owner-only boxes: G7 (Rust store throughput, Tauri shell with `encfs-bench`) and G3 on a device that has `measureUserAgentSpecificMemory`.
6. Journal-side plan files in `docs/plan/journal/` (17 files, `01` to `17`). No Journal-side work has been done. `07-1017-wire-encrypted-fs.md` is the one that uses this package; `08-native-migration.md` and `09-native-plaintext-sweep.md` are not needed under answer 1A. File the ones you want agents to take. `07` waits on #8, which is closed, but should wait for the #10 verdict on open time.
7. Read CI once. The run on `main` at 2223cf1 was queued when this was written; the two before it (926fd25, c012344) were cancelled, not red. A red result comes back as a `ci-failure` issue.

## Risks

- Open time is the product risk, and now has a real number: the shipped code is 1.7 to 2.05x plain in Chromium at 10 MB. It grows with data, and no phone has been measured. Most of it is IndexedDB read time, which encryption does not control.
- The benchmark page still measures the prototype. After #10 lands, the CI gates measure `src/`; until then regressions are invisible except through the #10 perf runs.
- #10 is unverified: no `npm test` of the final state, no cross-engine browser run, no long suites. Merging it needs the full local verification first.
- Firefox and WebKit were not run locally for #8, #9 or either checkpoint; CI is the only evidence there. One WebKit-only failure (#26) already passed the local gate once.
- Memory: the whole database sits in memory, plaintext, while the app is open. G3 fails and cannot be measured outside Chromium. App lock (J-12) is the mitigation. A read-ahead that holds two pages trades a little more peak memory for open time.
- Durability: syncs are relaxed by default, and a strict request can resolve after a relaxed commit.
- Key change: `changeKey` has an unsettled-outcome path that can leave a store under a key the caller thinks it rejected.
- Maturity: new cryptographic format, no external review, one author and agents. Keep the repository private; make no "audited" claim.
- Process: #10's work lives on two worktree-named branches (`worktree-wf_101d8937-edb-2`, `worktree-wf_1d72e28d-3b0-2`) and several stale worktrees. `worktree-wf_1d72e28d-3b0-2` is the copy of record.
