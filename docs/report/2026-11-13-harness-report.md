# pglite-cipher harness run, 2026-11-13

Base: `origin/main` at 926fd25 (merge of #31). Sources: the harness result rows, `gh` for issues and PRs, `bench/results/2026-11-13/SUMMARY.md`, the comments on #10 and #4, and `docs/plan/01-sqlcipher-comparison.md`. CI was not waited on. The 2026-11-12 report (PR #30) covers everything merged up to bench #29; this one covers what changed since.

## Summary

This run did two things. It tried #10 (benchmark gates in CI, long fuzz/crash/soak runs, ported scenarios, SECURITY.md, release checklist) and stopped on it. It re-ran the benchmark page on all three engines (PR #31).

The stop on #10 is the first measurement of the shipped code. In Chromium at 10 MB, encrypted open is 2.01x plain `idb://` open on the first run, and 4 of 10 runs are over the limit of 2x (range 1.43 to 2.07). The gate was not loosened. The decision is the owner's.

The benchmark page still measures the spike prototype, not `src/`. On the prototype, Chromium passes G2 at 64 KB only, fails G3 at every unit, and Firefox fails G4 at 8 KB. Those are the same verdicts as 2026-11-12.

| Item | Result |
|---|---|
| PRs merged this run | #31 (bench results) |
| Issues closed this run | none |
| Stopped | #10 (label `blocked`) |
| Open, owner only | #4 |
| Checkpoints | 0 |
| Benchmark | ran, PR #31 |
| Overall | 10 of 12 issues closed (#1 to #3, #5 to #9, #11, #26); #4 and #10 open |

## What shipped

One PR this run.

| Item | What | PR |
|---|---|---|
| Bench | Results for Chromium 158, Firefox 159 and WebKit (Playwright, on the Mac), 10 MB and 100 MB, extras, 365-session year run. `bench/results/2026-11-13/` has the JSON and `SUMMARY.md` | https://github.com/2002Bishwajeet/pglite-cipher/pull/31 |

Everything else on `main` was shipped earlier: #1 scaffold, #2 spike, #3 provisional gate, #5 format v1 and crypto core, #6 dirty-block tracker, #7 storage backends, #8 `EncryptedFs`, #9 `changeKey`/`rotateDataKey`/`verify()`, #11 agent device runs, #26 CI fix, two checkpoints. See the reports of 2026-11-11 and 2026-11-12 for the PR list. PR #31 has no checks recorded in its description; it adds result files only.

## What stopped, and why

### #10 Benchmark gates in CI, long runs, SECURITY.md

Issue: https://github.com/2002Bishwajeet/pglite-cipher/issues/10. STOP comment: https://github.com/2002Bishwajeet/pglite-cipher/issues/10#issuecomment-6841656075. Labels now `agent-ready`, `security`, `blocked`.

Condition: "G2 fails as a ratio in Chromium on the real implementation, and the perf test fails more than once in 10 local runs at the stated ratios." Both parts hold.

Measured on yantra-box, Chromium, 10 MB, 10 runs. G2 (encrypted open p50 / plain `idb://` open p50, limit 2):

| Run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| G2 ratio | 2.01 | 1.97 | 2.07 | 2.03 | 1.64 | 1.51 | 1.65 | 1.59 | 1.43 | 2.04 |

Runs 1, 3, 4 and 10 are over 2. Run 2 (1.97) passes by a hair. Other gates passed every time: G1 ratio 0.07 to 0.10, G4 (over plain sync) 1.33 to 1.82, G9 open 0.0175 to 0.019.

First run in detail: plain open p50 283 ms (p95 374); encrypted open p50 570 ms (p95 617), of which the table phase is 10 ms and the data-block phase (decrypting every block) is 463 ms. 1,638 data blocks, 1,016 files, 2 table blocks at fill 0.7, 4 subkeys. G1: encrypted 4.6 ms vs plain 55 ms. G4: encrypted switch 95 ms vs plain sync 125 ms; encrypted switch is 20.6x the encrypted sync and 0.77x the plain switch (recorded, not asserted).

What the number does and does not say: the plain baseline here (283 ms) is much lower than in the Chromium bench-page run on the G14 (368 ms), and the prototype at 64 KB measured 461 ms encrypted at 10 MB (1.25x). The two are different machines and different code, so do not read the ratio change as a regression of a known size. It does show the real `EncryptedFs` open is at the edge of the gate at 10 MB in Chromium, and that most of the time is block decryption.

Not run, because of the STOP: the 5-minute long suites (`CIPHER_LONG=1 CIPHER_SOAK_MINUTES=5`), `npm test`, `test:browser` on all engines, build, `bench:build`, and the compat write/read check. So the #10 branch is unverified apart from the perf test above.

Where the work is:

- Branch `worktree-wf_101d8937-edb-2` on origin, head 2f34dcb (5feaf2f, a merge of `origin/main`, then 2f34dcb). It moves `spike/` into `bench/`, adds CI gates and the pgvector dev dependency; against `main` it is 57 files, +1,638 -25,067 (mostly the moved results).
- `origin/agent/10-benchmark-gates-in-ci-long-fuzz-crash-so` is still at 5feaf2f. That branch is checked out in the stale worktree `.claude/worktrees/wf_47356dba-866-30`, so git would not let the agent use it. Move the ref to 2f34dcb or remove that worktree before the next run, or the next agent will start from the old head.
- The five review decisions on #10 (comment 6841220006: G9 per-file rule, G4 denominator, G3 record-only, pgvector 0.0.11 as an exact-pinned dev dependency, long run nightly on the yantra-box runner) were made while the owner was unavailable. They stand until you reverse them.

### #4 Owner device runs (open, not for agents)

Unchanged. See "What the owner must do".

## Checkpoint findings

No checkpoint ran this run. The open findings from checkpoints 1 and 2 and from the PR reviews stand as listed in the 2026-11-12 report. The ones that matter most for a release:

- `changeKey` does not settle an unknown outcome: the store can be under the new key while the caller was told it failed (PR #24).
- A strict sync that joins an in-flight relaxed sync resolves without a strict commit; the README's flush-on-hide claim is not always true (PR #23).
- Open of an interrupted rotation whose new store has a damaged root or header fails, though the old store is intact (PR #24).

## Benchmark gates

Source: `bench/results/2026-11-13/SUMMARY.md`, `main` at 2efe68f, 20 runs per measure, p50.

What was measured: the benchmark page (`bench/`, run through `spike/run.mjs`) benchmarks the spike prototype `spike/protoFs.ts`, not `src/EncryptedFs`. It needs IndexedDB and a DOM, so it cannot run in Node and there is no Node row. "10 MB" and "100 MB" are blob payloads; the data directories are 64.7 MB and 254.2 MB. Chromium 158 and Firefox 159 ran on the G14 (Ryzen 5 4600HS, 15 GiB) while other sessions shared it, so timings are noisy. WebKit ran on the Mac (M1 Pro) through `webkit.sh`: Playwright WebKit, not Safari and not WKWebView. Compare plain against encrypted inside one engine, never across engines. Chromium's G3 reads `performance.memory`; Firefox and WebKit have no memory API the page can use.

Times are ms, p50. Unit sizes 8 / 32 / 64 KB.

| Gate | Target | Chromium | Firefox | WebKit (Mac) |
|---|---|---|---|---|
| G1 sync, one-row UPDATE, 100 MB | enc <= 2x plain | 0.98 vs 80.1 (64 KB): pass | 1.42 vs 149 (32 KB): pass | 0.42 vs 160 (8 KB): pass |
| G1b sync, 4 KB insert, 100 MB | <= 2x plain, <= 1 table block | 1.65 vs 584 (64 KB): pass | 2.84 vs 752 (32 KB): pass | 0.70 vs 264 (8 KB): pass |
| G2 open, 10 MB | <= 2x plain | plain 368; 8 KB 980 FAIL, 32 KB 676, 64 KB 461 | plain 640; 744 / 586 / 587 pass | plain 283; 144 / 120 / 142 pass |
| G2 open, 100 MB | <= 2x plain and <= 1,500 | plain 707; 8 KB 2,948 FAIL, 32 KB 1,646 FAIL, 64 KB 865 pass | plain 1,305; 8 KB 2,033 FAIL, 32 KB 1,293 pass, 64 KB 1,188 pass | plain 416; 353 / 236 / 247 pass |
| G3 memory | open <= db + 64 MB | FAIL at every unit: 100 MB 746 / 702 / 672 MB (plain `idb://` 478 MB); 10 MB 443 / 441 / 560 MB (plain 565 MB) | not available | not available |
| G4 segment switch, 100 MB | <= 500 | 180 / 109 / 80.4: pass | 609 FAIL / 335 / 262 pass | 117 / 47.5 / 36.1: pass |
| G5 unit size | smallest unit passing G2 | 32 KB at 10 MB; 64 KB at 100 MB | 8 KB at 10 MB; 32 KB at 100 MB | 8 KB at both |
| G6 support | all present | pass | pass | pass |
| G7 Rust store throughput | recorded only | owner (Tauri) | owner | owner |
| G8 subkeys, 366 live salts | <= 150 | 3.66: pass | 43.9: pass | 14.6: pass |
| G9 file table | file-map <= 5% of G2 budget | 9.29 to 26.3 at 100 MB (budget 75): pass | 10.5 to 45.8: pass | 9.72 to 25.1: pass |

Reading:

- Sync is two to three orders of magnitude faster than plain at 100 MB (one-row update: 0.4 to 2.5 ms against 80 to 160 ms). Query time is unchanged by design.
- Open is the cost. At 64 KB every engine meets G2 at both sizes. At 8 KB, Chromium and Firefox fail G2 at 100 MB; at 32 KB Chromium fails it at 100 MB (1,646 ms). The 64 KB default chosen at #3 is the only unit that passes in all three engines.
- G3 fails in Chromium at every unit, as it does for plain `idb://` at 100 MB (478 MB): PGlite on IndexedDB holds the whole directory in memory. At 10 MB the plain run (565 MB) is above two of the three encrypted runs, so the 10 MB memory figures mostly show browser noise.
- Firefox fails G4 at 8 KB (609 ms at 100 MB, 551 at 10 MB). Not the default unit.
- G9 read strictly (no table block in any G1 sync) fails at every unit in every engine, because in 1 to 2 of 20 syncs a file grew and one table block was written. Under the restated rule (a table block only with a file change) it passes. The page's flag is the strict one.
- Change from 2026-11-12: verdicts are the same. Chromium 100 MB open at 64 KB is 865 ms (was 849); WebKit G8 is 14.6 ms (was 22.0).
- The year run (365 sessions) ended at 366 live salts and 7,252 live records in every engine. It took 324 s (Chromium), 268 s (Firefox), 64 s (WebKit).

Device numbers from #11 (macOS WebKit, WKWebView, iOS simulator) are in `spike/RESULTS.md` section 6 and the 2026-11-12 report. They were not repeated. WKWebView passes; the simulator says nothing about a phone.

## SQLCipher parity as it stands

Table: `docs/plan/01-sqlcipher-comparison.md` section 2, 31 rows. It was last edited on 2026-11-12 (native PostgreSQL comparison only) and has not been revised for what shipped. Count: stronger 8, parity 14, n/a 2, weaker 7.

| Verdict | Rows |
|---|---|
| Stronger (8) | What is covered (every file under PGDATA); what the tag binds (AAD); truncation; replay of one unit; key hierarchy (KEK wraps DEK); wrong key vs corruption; rekey (`changeKey` instant, `rotateDataKey` resumable); integrity check (`verify()`, every open decrypts everything) |
| Parity (14) | Cipher and mode (AES-256-GCM); unit size; nonce and subkey (v5-style, per-session subkey); integrity primitive; swapped unit; modified unit; deletion of a whole file; rollback of the whole store (not detected, accepted); opaque header and salt; raw key; key storage (app's job, OS keychain); metadata leakage; cipher agility; migration tooling |
| n/a (2) | Plaintext header option; key derivation (no passphrase) |
| Weaker (7) | Memory for key material; whole database in memory; no `cipher_memory_security`; no FIPS build; durability (relaxed by default); no random access to a big database; maturity (new code, no external review) |

Where the table and reality differ:

- Migration tooling is marked "parity once PC-10 is in". Owner question 1 was answered with option A (encryption in the first public native build), so plan file 10 was not filed. Treat the row as not applicable.
- "Stronger" describes the design. Tests in `test/format`, `test/fs` and `test/keys` exercise it, per the PR descriptions; this report did not rerun them. Two of those rows carry open findings (rekey: the `changeKey` unknown-outcome gap; integrity at an interrupted rotation with a damaged new store).
- The performance rows in section 3 are backed by prototype numbers only. The one measurement of the real code (the #10 STOP) puts Chromium open at 10 MB at about 2x plain, at the gate.
- Maturity stays weaker. The package is not audited and must not be described as audited.

## What the owner must do next

1. Decide on #10. Options: (a) accept a higher G2 ratio for Chromium at 10 MB with a stated reason (the 100 MB case and the absolute budget still hold), (b) have an agent optimise block decryption in open (it is 463 of 570 ms), or (c) restate the gate against a noise-aware measure such as median of several runs. Agents cannot loosen the gate. Then confirm or reverse the five decisions in comment 6841220006, and fix the branch state: move `agent/10-...` to 2f34dcb or delete worktree `.claude/worktrees/wf_47356dba-866-30`. Remove the `blocked` label when you want it picked up.
2. Triage the benchmark failures PR #31 asks about: Chromium G3 (fails for plain `idb://` too), Firefox G4 at 8 KB (not the default unit), and G7 (owner-only).
3. Decide whether the open findings from #23 and #24 (especially `changeKey` unknown outcome) block a release, and which become follow-up issues.
4. Device runs on #4 (about an hour). Paste JSON on #4:
   - macOS in the Tauri shell, at 10 MB and 100 MB.
   - The oldest iPhone you will support (name it). This tests the 3 s phone budget; the simulator cannot.
   - Windows (WebView2) and Android WebView if a device is at hand.
   - iPhone 15, iPad Air (M3) and the Redmi need unlocking or pairing first (checkboxes on #4): `scripts/harness/remote.sh mac bash spike/device/mac.sh iphone-15`; `bash spike/device/redmi.sh` after `adb pair`/`adb connect`.
5. Owner-only boxes: G7 (Rust store throughput, Tauri shell with `encfs-bench`) and G3 on a device that has `measureUserAgentSpecificMemory`.
6. Journal-side plan files in `docs/plan/journal/` (17 files, `01` to `17`). No Journal-side work has been done. `07-1017-wire-encrypted-fs.md` is the one that uses this package; `08-native-migration.md` and `09-native-plaintext-sweep.md` are not needed under answer 1A. File the ones you want agents to take.
7. Read CI once. The run on `main` at 926fd25 was queued when this was written; the two before it (c012344, c5ea74b) were cancelled, not red. A red result comes back as a `ci-failure` issue.

## Risks

- Open time is the product risk, and now has a real number: the shipped code is at the G2 edge in Chromium at 10 MB. It grows with data, and no phone has been measured.
- The benchmark page still measures the prototype. After #10 lands, the CI gates measure `src/`; until then regressions are invisible except through the one STOP run.
- #10 is unverified: no `npm test`, no cross-engine browser run, no long suites. Merging it needs the full local verification first.
- Firefox and WebKit were not run locally for #8, #9 or either checkpoint; CI is the only evidence there. One WebKit-only failure (#26) already passed the local gate once.
- Memory: the whole database sits in memory, plaintext, while the app is open. G3 fails and cannot be measured outside Chromium. App lock (J-12) is the mitigation.
- Durability: syncs are relaxed by default, and a strict request can resolve after a relaxed commit.
- Key change: `changeKey` has an unsettled-outcome path that can leave a store under a key the caller thinks it rejected.
- Maturity: new cryptographic format, no external review, one author and agents. Keep the repository private; make no "audited" claim.
- Process: #10's work lives on a worktree-named branch and in two worktrees. Deleting the wrong one loses state; the pushed `worktree-wf_101d8937-edb-2` is the copy of record.
