# pglite-cipher harness run, 2026-11-16

Base: `origin/main` at cd47348 (merge of #103, the final bench re-run). This replaces the earlier version of this report (PR #100), which was written at 5926674. Sources: the harness result rows, `gh` for issues, PRs and comments, `bench/results/2026-11-16/SUMMARY.md` and its JSON, the Redmi results in PR #101 (not merged), `docs/plan/01-sqlcipher-comparison.md`. CI was not waited on. Nothing here was re-tested by this report.

## Summary

Eight issues were worked: #76, #77, #78, #80, #82, #83, #85, #91. All except #76 are closed and merged. #76 stays open: the Redmi run of the three fixes is in (best case 2.17x plain, against a rule of "under about 2x"), and a Fable review, with the owner unavailable, decided that #76 ships as a documented known Android limitation and is fixed in a later release. The owner can overrule. #80, #83 and #85 stopped once on the way and were released again by owner decision; the STOP comments are in the table below. #94 (CI red on main) was closed without a code change. Two checkpoints ran. The full benchmark ran twice on `main` (150e3a3, then the final re-run 332dcc8) in Chromium, Firefox and WebKit, and every judged gate passes both times. **CI on main is red at 5926674** (Firefox browser job, #102, open); the run for cd47348 was queued when this was written and not waited on.

Two answers to the questions that started this run:

- **Can the WebView2 bench run on GitHub CI?** Yes. `webview2-bench.yml` (#88) runs the bench page in a real WebView2 runtime on a GitHub-hosted Windows runner. It ran once (run 43842286655) and the JSON is in `bench/results/2026-11-16-webview2-ci/` (#90). The gates that fail there are G2 and G4 (see Benchmark). It is a stand-in, not a device run: the #4 WebView2 checkbox stays open.
- **The other three agent-ready issues** (#82, #83, #85) were all built and merged as bench-only work. None changes `src/`. None answers the #76 question yet, because the answer needs the Redmi.

Open issues: #4 (owner device runs), #76 (Android encrypted open, documented limitation pending the owner's confirmation) and #102 (CI red on main, `test-browser (firefox)`). Open PR: #101 (Redmi #76 result files, `checkpoint/redmi-76`). Nothing is labelled `blocked`.

| Item | Result |
|---|---|
| Issues closed this run | #77, #78, #80, #82, #83, #85, #91, #94 |
| Issues open | #4, #76, #102 |
| `src/` changes | #91 only (best-effort plaintext wipe), plus the checkpoint-1 wipe fixes |
| Checkpoints | 2 (checkpoint 2 findings are unverified, see below) |
| Benchmark | 2026-11-16 final re-run, `main` at f0f47c8 (332dcc8, PR #103), three engines, no judged gate fails; G3 not measurable |
| CI on main | Red at 5926674 (#102, Firefox). Not green-confirmed for any commit of this run. See Risks |

## What shipped

| Item | What | PR |
|---|---|---|
| #78 | CI job timeouts, Node 26 added to the test matrix, `mac.sh` accepts connected devices | https://github.com/2002Bishwajeet/pglite-cipher/pull/81 |
| #77 | Bench fixes: G7 error path answered by the page, `getRandomValues` fills chunked to 64 KiB, `idbread` closes its database on error, `dropIdb` blocked while a connection is open, `?block=` parsed by `parseBlockSize` (NaN blocked), year part uses its own block size, a `keysError` part now fails the judge. The G7 hang was not reproduced on main; the new code covers other paths that could hang | https://github.com/2002Bishwajeet/pglite-cipher/pull/84 |
| #82 | `opfsread` bench part: OPFS read throughput by layout, for comparison with IndexedDB on the same device. WebKit headless on the Mac throws `UnknownError` from `getDirectory()`, so that row is recorded as `unavailable` | https://github.com/2002Bishwajeet/pglite-cipher/pull/87 |
| #80 | Manual WebView2 workflow on a GitHub-hosted Windows runner (merged first as "Refs #80", because GitHub dispatches only workflows on the default branch), then its first results | https://github.com/2002Bishwajeet/pglite-cipher/pull/88 and https://github.com/2002Bishwajeet/pglite-cipher/pull/90 |
| #91 | Best-effort plaintext wipe on close and zeroing of transient buffers (data-key rotation copy, rotation catch path). `test/fs/wipe.test.ts` passes on Node, Chromium, Firefox, WebKit | https://github.com/2002Bishwajeet/pglite-cipher/pull/92 |
| #85 | `bench/patches/workers.patch`: W workers each read and decrypt a key range on open. Falls back to the single-thread loader on `DataCloneError`. Never exports key bytes. Bench-local, `src/` untouched | https://github.com/2002Bishwajeet/pglite-cipher/pull/97 |
| #83 | `bench/patches/pack.patch`: pack N sealed blocks per IndexedDB record, no padding. Bench-local, `src/` untouched | https://github.com/2002Bishwajeet/pglite-cipher/pull/98 |
| Checkpoint 1 | Review and simplify 11f89a8..3898987 | https://github.com/2002Bishwajeet/pglite-cipher/pull/93 |
| Checkpoint 2 | Licence and CLA (FSL-1.1-ALv2); comparison with other encrypted browser databases (`docs/design/comparison.md`) | https://github.com/2002Bishwajeet/pglite-cipher/pull/95 and https://github.com/2002Bishwajeet/pglite-cipher/pull/96 |
| Bench | Results 2026-11-16, then the final re-run over the later merges (`src/` unchanged between them) | https://github.com/2002Bishwajeet/pglite-cipher/pull/99 and https://github.com/2002Bishwajeet/pglite-cipher/pull/103 |
| Report | This report (first version) | https://github.com/2002Bishwajeet/pglite-cipher/pull/100 |
| Not merged | Redmi #76 run: baseline, pack N = 4 and 8, workers W = 2 and 4, opfsread; JSON in `bench/results/2026-11-16-redmi-76/` and `bench/device/redmi-76.sh` | https://github.com/2002Bishwajeet/pglite-cipher/pull/101 (open) |
| Harness and docs | Check-in command (#79), `remote.sh` ends the remote command when ssh drops (#86), design documentation (#89) | #79, #86, #89 |

Other state changes:

- **#94** (CI red on main, 3898987): run 43886201385 failed only on `test-browser (firefox)` with a runner shutdown signal at 14:39:13Z. The other 13 jobs passed. Closed without a code change. The rerun (`--failed`, attempt 2) **also failed on `test-browser (firefox)`**; its log was not read.
- **#102** (open, `ci-failure`): run 43933416586 on 5926674 failed only in `test-browser (firefox)`. Failing tests in the log: `test/fs/release.test.ts` (6 closed instances hold at most one database: expected 2 to be at most 1), `test/fs/tamper.test.ts` (32768-byte blocks, 180 s timeout), `test/fs/open.test.ts` (4 tests), `test/fs/close-failed.test.ts` (1 test). Nobody has commented on the issue. Whether this is a real regression, a memory or timeout effect of the shared runner, or the same cause as #94 is not known. The release test asserts a memory property, so do not loosen it to get green.
- **#80** was reported by the harness as stopped. That is superseded: the STOP (workflow not yet on main) was resolved by merging #88 first, dispatching the workflow, and committing the result in #90. The issue is closed.

## What stopped, and why

| Issue | Stop condition | Resolution |
|---|---|---|
| #76 | The only lever found needs a format change, a new block size, or a migration | The issue stays open. Owner rule (2026-11-16): implement a fix only if one option brings the Redmi encrypted open (G2, 100 MB) under about 2x plain; otherwise go public with a documented Android limitation. The Redmi run (comment 20:00Z) gave: baseline 3.41x (8,601 vs 2,521 ms), pack N=4 2.42x, **pack N=8 2.17x (4,833 ms)**, workers W=2 2.98x, W=4 3.19x. OPFS read, 100 MB of 65,580 B records: 12.6 MB/s one file per record, 151.9 MB/s segment slices, 28.4 MB/s sync handle in a worker; the IndexedDB reads-only open is about 15 MB/s. Fable review (20:39Z, owner unavailable): 2.17x does not meet the rule, the pack layout is unpadded and cannot ship, padding is unmeasured and likely slower, write cost rises (Redmi G4 3,598 to 4,459 ms). Decision: ship #76 as a documented known Android limitation, fix later. The vivo V2250 result (4.55x) is on #4; vivo is dropped, Redmi only. Nothing was implemented or closed on this decision |
| #80 | Workflow not on main, so `gh workflow run` could not succeed from the branch | Merge the workflow first (#88, "Refs #80"), dispatch on main, commit the JSON (#90). Done |
| #85 | WebKit throws `DataCloneError` posting any `CryptoKey` (HKDF, AES-GCM, extractable or not) to a worker, so two WebKit suites fail under the patch | Owner chose option 1: workers on Chromium and Firefox, fallback to today's loader on `DataCloneError`, never export key bytes. Built as #97. Bench ran unthrottled because CDP cannot throttle workers |
| #83 | Two raw IndexedDB layout tests fail only with the patch: `test/backend/indexeddb.test.ts` "adds nothing readable" and `test/fs/plaintext.test.ts` "nothing but blocks". Both assert one record per block, which packing removes by design | Owner accepted both failures for this bench-local patch only. They stay unchanged and must pass in any production version. First run's branch name was held by a stale worktree; work was on `agent/83-bench-pack-by-id-range`, then merged as #98 after a conflict fix |

Desktop findings behind #76 (Chromium, `gates100`):

| Option | Result |
|---|---|
| Workers, W = 1 / 2 / 4 (unthrottled), open p50 | 903 / 739 / 724 ms. blocksMs 743 / 610 / 585. G1 4.9 / 4.6 / 4.8 ms, G4 103 / 91 / 87 ms. Modest gain on a fast desktop |
| Pack N = 1 / 4 / 8 / 16 (`--throttle 4`, 5 runs), G2 open p50 | 4,107 / 4,121 / 4,017 / 4,135 ms. No open gain on desktop; readsOnly is about 12 % slower at N >= 4 |
| Pack, G4 segment switch p50 | 226 / 705 / 1,137 / 1,835 ms. 3x to 8x slower, since new block ids are random and a switch rewrites most records |
| Pack, key rotation | `QuotaExceededError` at N = 8 and 16. Store bytes do not change (no padding) |
| OPFS read, 300 MB of 65,580 B records, Chromium / Firefox | per-record files 58.8 / 38.4 MB/s; segment slices 473 / 481 MB/s; sync-handle worker 444 / 659 MB/s. WebKit headless: `unavailable` |

The Redmi did show a gain from packing (3.41x to 2.17x at N=8). A production version needs equal-size (padded) records so both layout tests pass, a fix for the G4 cost and a fix for the rotation quota error. Fable's conditions on the decision: the docs state the Android numbers (3.4x on the Redmi Note 5 Pro, 4.55x on the vivo, 1.37x on desktop Chromium) and the cause (a sealed block of 65,580 B is over Chromium's 64 KiB IndexedDB value threshold, so each record is unwrapped on the requesting thread at about 1.1 ms; open time only, not a security issue); before going public, confirm a later store layout can be introduced behind a version or layout marker (only the `FORMAT_V1` rejection in `src/format/codec.ts` was seen; unchecked whether it covers store layout); then file a follow-up issue, an OPFS segment backend spike first and padded packing second, with layout tests redesigned and never loosened. That follow-up issue is not filed yet. Pack plus workers together was not measured (the patches collide in `src/backend/indexeddb.ts`); Fable's rough estimate is about 2.0x on an unshippable layout.

## Checkpoint findings

**Checkpoint 1** (PR #93, 11f89a8..3898987): fixes in fd7d164. `closeFs` now wipes the plaintext snapshot held in `#unsettled`; the rotation-copy plaintext block is wiped in a `finally`; the threat-model wipe claim is narrowed to snapshot and block copies (file-table and root encodings are not zeroed). Checks: build, lint, `npm test`, Chromium browser suite exit 0; Firefox and WebKit "CI covers it". Minor findings left: neither fix has a regression test; `closebench.ts` hard-codes `sorted[2]` for exactly five runs; the `openBlock` plain buffer is not wiped if `.set` throws.

**Checkpoint 2** (clean: nothing fixed, nothing committed). The code-review skill (medium) returned 7 findings. **None was verified**, so none is confirmed or ruled out. The simplify pass found nothing to change. Build, lint, test and `test:browser` were not run for this checkpoint, and main's CI was not read in it. For the owner to triage:

1. `bench/patches/workers.patch` rewrites the `test/fs/memory.test.ts` load-memory assertion in a weaker form. CLAUDE.md says report, do not loosen. #97 describes it as "restated in bytes" with the limit unchanged and a halved-limit control that fails; that is the author's claim, not checked here.
2. The patch transfers `o.plain.buffer` with no check that each block owns its whole buffer.
3. `runRanges` returns null on a `DataCloneError` after earlier workers have started.
4. `keyRanges` splits on the first hex digit, so a 1-char id could fall in no range.
5. `docs/design/comparison.md` makes unsourced claims about named third-party projects.
6. `LICENSE`, `CLA.md` and the `package.json` licence landed before the planned history rewrite.
7. `closeFs` wipes `#unsettled.snap` in `finally` with no test that a failed close-time sync cannot race it.

Findings 1 to 4 concern bench-local patches and are not in `src/`. Finding 7 overlaps checkpoint 1's "no regression test" finding. Findings from #91's own review also remain: after an unknown commit outcome, a failed close-time settle leaves the plaintext copy in `#unsettled` (partly addressed by fd7d164; item 7 asks whether it is safe), the wipe test does not assert the captured heap is non-empty, and the doc sentence on zeroing was narrowed in checkpoint 1.

Earlier open findings, still without an issue: the interrupted-rotation case with a damaged new store; six minor `changeKey` items from #36; the stale comment in `test/keys/crash.test.ts`; the idbread findings (unvalidated throttle, no cold-cache warm-up, split mode is not one transaction, stream bounds, README path, connection leak on error). Minor findings from this run's PRs: the `gates.ts` header comment is stale after `judgePart` (#84); the `opfsread` try/catch records real failures in layout (c) as `unavailable`, and `readSync()` sets no `onmessageerror` (#87).

## Benchmark gates

Final re-run on `main` at f0f47c8 (results commit 332dcc8, PR #103): `gates10, extras, gates100, year`, 20 runs per measure, p50. It repeats the run merged earlier the same day (150e3a3, PR #99); `src/` did not change between them, and the later merges touched `bench/` and docs only. The `ops` part was not run. The page needs IndexedDB and a DOM, so there is no Node row; Node behaviour is covered by the test suite.

Environment: Chromium 158 and Firefox 159 headless on the ROG G14 (Ryzen 5 4600HS, 15 GiB, shared with other harness sessions, heavy lock held). WebKit ran on the Mac (M1 Pro, 16 GiB, macOS 27.0.1), Playwright WebKit build, not Safari and not WKWebView. WebKit times come from a faster machine: compare plain against encrypted within one engine, not across columns. Ratio is encrypted p50 over plain p50. Judged by `bench/judge.ts` at factor 1.

| Gate | Target | Chromium | Firefox | WebKit (Mac) |
|---|---|---|---|---|
| G1 sync, 10 MB | ratio <= 2 | 0.07 (4.78 vs 67.3 ms) pass | 0.04 (6.42 vs 161 ms) pass | 0.02 (2.34 vs 98.7 ms) pass |
| G1 sync, 100 MB | ratio <= 2 | 0.07 (4.70 vs 70.1 ms) pass | 0.05 (8.48 vs 166 ms) pass | 0.01 (2.26 vs 167 ms) pass |
| G1b insert, 10 MB | ratio <= 2; <= 1 table block | 0.05; p50 1, max 1 pass | 0.04; 1 / 1 pass | 0.03; 1 / 1 pass |
| G1b insert, 100 MB | same | 0.01; p50 1, max 2 pass on p50 | 0.01; 1 / 2 pass on p50 | 0.01; 1 / 2 pass on p50 |
| G2 open, 10 MB | ratio <= 2 | 1.23 (470 vs 381 ms) pass | 1.09 (687 vs 631 ms) pass | 0.54 (156 vs 286 ms) pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.24, 956 ms pass | 1.06, 1,319 ms pass | 0.76, 329 ms pass |
| G3 memory | db + 64 MB | not measurable (514 / 860 MB, whole renderer heap) | no memory API | no memory API |
| G4 segment switch, 10 MB | <= 500 ms; <= 10x plain sync | 91.5 ms (1.36x) pass | 271 ms (1.68x) pass | 29.5 ms (0.30x) pass |
| G4 segment switch, 100 MB | same | 90.9 ms (1.30x) pass | 282 ms (1.70x) pass | 30.2 ms (0.18x) pass |
| G5 unit size | smallest passing G2 | n/a, 64 KB default passes | same | same |
| G6 support | all present | pass | pass | pass |
| G7 Rust store | recorded only | owner (Tauri only) | owner | owner |
| G8 subkeys, one year | <= 150 ms | 1.32 ms (263 salts) pass | 10.5 ms pass | 15.8 ms pass |
| G9 file-table phase, 10 MB | <= 5 % of G2 budget | 8.95 ms (limit 23.5) pass | 10.7 ms (limit 34.4) pass | 4.54 ms (limit 7.8) pass |
| G9 file-table phase, 100 MB | <= 75 ms | 10.8 ms pass | 20.9 ms pass | 5.42 ms pass |
| G9 G1 sync writes no table block | p50 0 | pass | pass | pass |

Other measurements (10 MB / 100 MB):

| Measure | Chromium | Firefox | WebKit (Mac) |
|---|---|---|---|
| `changeKey` | 13.7 / 14.9 ms | 22.0 / 16.8 ms | 8.8 / 9.1 ms |
| `verify()` | 370 / 842 ms | 642 / 1,513 ms | 111 / 241 ms |
| `rotateDataKey` | 1,052 / 2,336 ms | 2,259 / 5,011 ms | 290 / 699 ms |
| Open after rotation | 458 / 927 ms | 655 / 1,270 ms | 145 / 299 ms |

Thinnest margins: Firefox G2 at 100 MB (1,319 of 1,500 ms) and the Chromium G2 ratio (1.23 and 1.24 of 2; the earlier run the same day gave 1.17 and 1.37, 1.50 on 2026-11-15, so noise on the shared host is plausible, unverified).

**Android, Redmi Note 5 Pro** (Chrome 157, Android 10, custom ROM; PR #101, not merged; gates100, 5 runs, unthrottled, main 0ef35b3 plus the named patch). G2 at 100 MB, p50:

| Config | Plain ms | Encrypted ms | Ratio | Limit |
|---|---|---|---|---|
| baseline | 2,521 | 8,601 | 3.41 **fail** | <= 2 and <= 3,000 ms (slowest target) |
| pack N=4 (bench patch) | 2,547 | 6,174 | 2.42 **fail** | same |
| pack N=8 (bench patch) | 2,228 | 4,833 | 2.17 **fail** | same |
| workers W=2 (bench patch) | 2,275 | 6,787 | 2.98 **fail** | same |
| workers W=4 (bench patch) | 2,171 | 6,923 | 3.19 **fail** | same |

**WebView2 on the GitHub-hosted Windows VM** (run 43842286655, WebView2 runtime 156.0.4314.58, Edg/156, 2 vCPU, 8 GB, 3 runs; Chromium-based, a different machine class from the table above):

| Gate | 10 MB | 100 MB | Limit |
|---|---|---|---|
| G1 sync ratio | 0.20 pass | 0.25 pass | <= 2 |
| G2 open ratio | 3.27 **fail** | 4.14 **fail** | <= 2 |
| G2 open, ms | not recorded in the post | 2,687 **fail** | <= 1,500 |
| G3 memory after open | 96.9 MB pass | 296.8 MB pass | db + 64 MB |
| G4 segment switch | 824 ms **fail**, 17.3x **fail** | 535 ms **fail**, 9.72x pass | <= 500 ms; <= 10x |
| G9 file-table phase | 7.72 ms pass | 11.15 ms pass | 47.7 ms; 75 ms |

The G2 miss is the same read-bound open as #76 on Android. The VM is a 2 vCPU shared runner, so the absolute numbers say little about a real Windows machine; the owner still needs one real WebView2 run. G3 passes here because WebView2 has `measureUserAgentSpecificMemory`.

## SQLCipher parity as it stands

Source: `docs/plan/01-sqlcipher-comparison.md` section 2, 31 rows, last re-judged 2026-11-12 (the file was last changed 2026-11-13, for the open read-ahead). Its count: stronger 8, parity 14, n/a 2, weaker 7 (1 reduced, 6 accepted). This run changed no verdict. `src/` changed only for best-effort plaintext wipe (#91), which the table's "Memory: key material" and "Memory: data" rows already list as weaker and accepted; the narrowed wording means the wipe claim covers snapshot and block copies only.

| Verdict | Rows |
|---|---|
| Stronger (8) | What is covered (every file under PGDATA); what the tag binds (AAD); truncation; replay of one unit; key hierarchy (KEK wraps DEK); wrong key vs corruption; rekey (`changeKey` instant, `rotateDataKey` resumable); integrity check (`verify()`, every open is a full check) |
| Parity (14) | Cipher and mode (AES-256-GCM); unit size; nonce and subkey; integrity primitive; swapped unit; modified unit; deletion of a whole file; whole-store rollback (not detected, accepted); opaque header and salt; raw key; key storage (the app's job); metadata leakage; cipher agility; migration tooling |
| n/a (2) | Plaintext header option; key derivation (no passphrase) |
| Weaker (7) | Key material in memory; the whole database in memory; no `cipher_memory_security`; no FIPS build; durability (relaxed by default); no random access to a big database; maturity (new code, no external review) |

Where the table and reality differ:

- Open time: the table estimated +0.5 to 4 s at 100 MB. Desktop numbers are 0.76 to 1.24x plain at 100 MB (329 to 1,319 ms). Android is the outlier: 3.41x on the Redmi (8.6 s at 100 MB against a 3 s phone budget; 2.17x at best with an unshippable bench patch), 4.55x on the vivo, and 4.14x (2.7 s) on the WebView2 CI VM.
- Migration tooling is marked "parity once PC-10 is in". PC-10 was not filed (owner question 1 = A); treat the row as not applicable.
- "Stronger" describes the design and is exercised by `test/format`, `test/fs`, `test/keys`. This report did not rerun them.
- Maturity stays weaker. The package is not audited and must not be described as audited.

## What the owner must do next

1. **Confirm or overrule the #76 decision.** The Redmi run is done; Fable decided (owner unavailable) to ship #76 as a documented known Android limitation. If you agree: write the limitation into the docs (numbers and cause are in the stopped table), check that a later store layout can be introduced behind a version or layout marker, and file the follow-up (OPFS segment backend spike first, padded packing second). Merge or close PR #101 (the Redmi result files). Tick the Redmi boxes on #4. Pack plus workers together is optional and unmeasured.
2. **A real WebView2 run** on a Windows machine (Tauri shell, `bench/README.md`). The CI run is a 2 vCPU stand-in that fails G2 and G4; a real machine decides whether those are VM artefacts.
3. **Other device runs** (#4): the Tauri shell on macOS (WKWebView) at 10 and 100 MB; the oldest supported iPhone; iPad Air M3 Safari `gates100` to confirm #41; the iPhone 15 re-run for #42; Android WebView. The Journal tech article waits for these.
4. **Owner-only boxes.** G7 (Rust store throughput; Tauri shell with `encfs-bench`; needs `docs/plan/journal/02-native-bench-endpoints.md`) and G3 on a device with a memory API (Chromium's number is the whole renderer heap, so it cannot be judged).
5. **Triage the unverified checkpoint-2 findings.** Item 1 (the weakened memory assertion in `workers.patch`) matters most: it touches a test, and CLAUDE.md forbids loosening one. It is in a bench-local patch that is not applied to `src/`, but check it before the patch is ever promoted. Item 6 (licence before history rewrite) belongs to the prepublic plan.
6. **Firefox CI job (#102).** `test-browser (firefox)` failed on 5926674 (seven tests, log above) and on 3898987 (#94, both attempts, log of attempt 2 unread). Read the run for cd47348 once it finishes. If the failures repeat, this is a real problem and needs an agent or you; do not loosen `test/fs/release.test.ts` or `tamper.test.ts`.
7. **Decide which open findings block a release** and which become issues: the damaged-new-store case at an interrupted rotation, the six minor `changeKey` items, the idbread findings, the `#unsettled` close path, and the small bench findings listed above.
8. **Journal-side plan files** in `docs/plan/journal/` (17 files, `01` to `17`). The harness has done no Journal-side work. `07-1017-wire-encrypted-fs.md` is the one that uses this package. Others: `01` optional submodule; `02` native bench endpoints (G7); `03` query cache in PGlite; `04` to `06` native secrets, credentials, sealed device storage; `10` recovery, reset, sign-out; `11` to `14` settings, app lock, iOS Keychain, Android Keystore; `15` desktop sign-in window residue; `16` at-rest scanner and device checklist; `17` epic rewrite. `08` and `09` (native migration, plaintext sweep) are not needed under answer 1A.
9. **Nightly workflow.** Trigger once with `workflow_dispatch` and read the first run. The 2,000-transaction crash matrices have not run to completion anywhere.
10. **Licence and CLA** (#95) are in; the pre-public plan (#76 documented limitation as above, #102 green, history rewrite, FSL + CLA under the owner's name) is the next gate before the repository goes public.
11. **Clean up** stale worktrees under `.claude/worktrees/wf_*` and merged local branches.

## Risks

- **Android open time.** Unfixed. Packing does not help on desktop and costs G4 and rotation; workers help desktop modestly (903 to 724 ms) and are Chromium and Firefox only, so WebKit and WKWebView get nothing. On the Redmi, pack N=8 is the best (3.41x to 2.17x, an unshippable unpadded layout) and workers help little (2.98x, 3.19x). The shipped state is 3.41x on the Redmi and 4.55x on a stock vivo at 100 MB, to be documented as a known limitation.
- **WebView2 and slow machines.** The CI VM fails G2 (4.14x, 2.7 s) and G4 (535 ms at 100 MB). If a real Windows machine behaves similarly, the 1,500 ms desktop budget is not met on Windows.
- **CI on main is red.** Run 43933416586 (5926674) failed on `test-browser (firefox)` (#102, seven tests). The earlier completed run, 43886201385 (3898987), failed on the same job in both attempts (#94). Runs for d779b2e, eeefbff, f649f3d and 0ef35b3 were cancelled by newer pushes; the run for cd47348 was queued when this was written. No green result is known for any commit of this run. Firefox and WebKit full suites ran locally for none of this run's PRs; the Firefox full suite is OOM-killed at the 8 GB heavy cap on the G14.
- **Checkpoint 2 is unverified.** Seven findings were not checked, and no build, lint or test was run in it.
- **Bench patches are not in `src/`.** `workers.patch` and `pack.patch` are applied only on the bench box. The two `pack.patch` layout-test failures are accepted for that patch only.
- **Open memory.** The read-ahead is about 64 MB of ciphertext on top of the database. G3 is unmeasurable headless. The whole database is held as plaintext while the app is open; the wipe on close is best-effort.
- **Benchmark scope.** Headless engines on a shared machine; WebKit is Playwright's macOS build, not Safari and not a webview; `ops` not run; not a phone.
- **Maturity.** New cryptographic format, no external review, one author and agents. Keep the repository private; make no "audited" claim.
