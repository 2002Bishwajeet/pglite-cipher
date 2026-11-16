# pglite-cipher harness run, 2026-11-15

Base: `origin/main` at 04ba064 (merge of #74). Sources: the harness result rows, `gh` for issues, PRs and comments, `bench/results/2026-11-15/SUMMARY.md` and its JSON, `docs/plan/01-sqlcipher-comparison.md`. CI was not waited on. Nothing here was re-tested by this report.

## Summary

This run was short. It merged #63 as bench tooling only, checkpoint 1, and the benchmark results. No `src/` code changed. Of 25 tracked issues, 24 are closed; the only open issue is #4 (owner device runs). Nothing is blocked. No benchmark gate fails in Chromium, Firefox or WebKit; G3 (memory) and G7 (Rust store) cannot be measured here.

| Item | Result |
|---|---|
| Issues closed this run | #63 (by #72), #67 (earlier, see below) |
| Issues open | #4 (owner) |
| Blocked | none |
| Stopped | #63 stage B, by decision (stage A missed its gate) |
| Checkpoints | 1, two bench fixes, no `src/` finding |
| Benchmark | 2026-11-15, `main` at 1896ea8, three engines, no judged gate fails |
| CI on main | 04ba064 was pending when this was written; 1896ea8 was in progress; c7c01be was cancelled by a newer push. No green result is known for this run's commits |

## What shipped

| Item | What | PR |
|---|---|---|
| #63 | Stage A only (bench): a 256 KiB block size option in the bench page (`?block=`, `--block` in `bench/run.mjs`), `readsOnly` and split4 diagnostics, `bench/patches/block256k.patch` committed as a file and never applied. `bench/judge.ts` now adds a failing "Key operations" row when `encrypted.keysError` is set. Stage B (a `src/` change) did not proceed. `src/` is untouched. Results in `bench/results/2026-11-14-63/` | https://github.com/2002Bishwajeet/pglite-cipher/pull/72 |
| Checkpoint 1 | Review and simplify 72e63ec..c7c01be (bench only). Fixes: the `readsOnly` diagnostic runs in try/catch so it cannot cost a part its G1-G4 results; an empty `?block=` falls back to 65536 instead of 0 | https://github.com/2002Bishwajeet/pglite-cipher/pull/73 |
| Bench | Results 2026-11-15 (`chromium.json`, `firefox.json`, `webkit.json`, `SUMMARY.md`) | https://github.com/2002Bishwajeet/pglite-cipher/pull/74 |

State changes on issues:

- #63 is closed as COMPLETED because PR #72 said "Closes #63". The review decision on the issue was "closes as not planned"; the GitHub reason is the only mismatch. The decision comment is the record.
- #67 (CI red on main) was closed on 2026-11-15 22:36 UTC with the comment "Main CI green at 43554565856 (PR #70) after #68 moved browser jobs to pc-ci-heavy". That confirms the `pc-ci-heavy` runners picked up the browser jobs at least once.

## What stopped, and why

| Issue | Stop condition | State |
|---|---|---|
| #63 stage B | Stage A missed its gate: "no engine's G2 more than 10 % worse". At 256 KiB the Firefox encrypted open goes from 1,486 to 1,902 ms (+28 %; a repeat run gave 1,497 to 1,954, +31 %), above the 1,500 ms open budget. WebKit with split4 is +18 % | The review decision (owner unavailable) was that stage B does not proceed and the bench-only branch merges. Costs measured: storage +51 % (442 MiB of records against 292 MiB at 64 KiB), bytes per one-row sync 4x, Chromium out of quota during `rotateDataKey`. The Redmi gap (7,719 ms read against 2,254 ms raw) is at 64 KiB, so the lead is the existing read path, which needs no format change |

Encrypted open p50 in ms, 64 KiB to 256 KiB, from the STOP comment:

| Engine | 64 KiB | 256 KiB | split4, 64 to 256 KiB |
|---|---|---|---|
| Chromium | 1,073 | 1,454 (plain rose 41 %; ratio 1.64 to 1.58) | 1,298 to 1,298 |
| Firefox | 1,486 | 1,902 | 1,417 to 1,629 |
| WebKit | 321 | 345 | 327 to 386 (G4 with split4 34.6 to 83.5 ms) |

No format field overflows at 256 KiB.

STOP comment: https://github.com/2002Bishwajeet/pglite-cipher/issues/63#issuecomment-6870666860. The iPhone commands are on #4: https://github.com/2002Bishwajeet/pglite-cipher/issues/4#issuecomment-6870667271.

## Checkpoint findings

Checkpoint 1 (PR #73, 72e63ec..c7c01be, plus fixes in c821dd3): reviewed `bench/` only; `src/` untouched, no test changed, skipped or weakened, no crypto exposure. No blocker or major finding. Checks run: `npm run build`, `npm run lint`, `npm test`, `npm run test:browser -- --project chromium`, all exit 0. Firefox and WebKit suites do not run on this host; they are "CI covers it", not passes.

Minor findings left open, all in `bench/`:

1. `?block=abc` or `?block=0` makes `BLOCK_SIZE` NaN or 0. The store is then built at 65536 but the result records `blockSize` as NaN or 0, with no error.
2. `runYear` builds its store with the codec default but reports `blockSize: BLOCK_SIZE`. A `node bench/run.mjs --block 262144` run saves a year part labelled 262144 that was measured at 65536.
3. A thrown key-operation failure is now stored as `encrypted.keysError`. `bench/gates.ts` judges only parts whose names start with `gates`, so an `enc10` or `enc100` part with `keysError` exits 0 there with no failing row. The page's own `judgeGates` does add the row. Impact is small: nightly runs no enc parts.
4. The same catch also covers the open-before and open-after rotation loops, so an open failure gets the "Key operations" label.

Open findings carried from earlier reports, with no issue filed: the interrupted-rotation case with a damaged new store (old store intact but open fails); six minor `changeKey` items from the #36 review; the stale comment in `test/keys/crash.test.ts` (it describes one sync commit, there are two); the checkpoint 2 findings from 2026-11-13, never recorded in a file; the idbread findings from the 2026-11-14 checkpoint (throttle value unvalidated, no cold-cache warm-up, split mode is not one transaction, stream bounds assume a divisor of 16, README names a moved result path, `repo.node.test.ts` cannot tell a browser job on plain `pc-ci` from lint, and the idbread error path leaks a connection that can hang a bench part for an hour).

## Benchmark gates

Run on `main` at 1896ea8 (results commit 441e6cc, PR #74): `gates10, gates100, extras, year`, 20 runs per measure, p50. The `ops` part was not run. The page needs IndexedDB and a DOM, so there is no Node row; Node behaviour is covered by the test suite.

Environment: Chromium 158 and Firefox 159 (headless, ROG G14, Ryzen 5 4600HS, 15 GiB, shared with other harness sessions, heavy lock held). The Mac was unreachable, so WebKit ran in Playwright's Linux container (`mcr.microsoft.com/playwright:v1.65.0-noble`, podman, 4 GB cap). It is not Safari and not WKWebView, and its absolute times are not comparable with the Mac WebKit numbers in earlier reports. Compare plain against encrypted within one engine only. Ratio is encrypted p50 over plain p50. Judged by `bench/judge.ts` at factor 1.

| Gate | Target | Chromium | Firefox | WebKit (container) |
|---|---|---|---|---|
| G1 sync, 10 MB | ratio <= 2 | 0.05 (4.11 vs 84.3 ms) pass | 0.04 (6.42 vs 158 ms) pass | 0.02 (5.08 vs 275 ms) pass |
| G1 sync, 100 MB | ratio <= 2 | 0.07 (4.70 vs 67.2 ms) pass | 0.05 (8.12 vs 159 ms) pass | 0.01 (5.32 vs 731 ms) pass |
| G1b insert, 10 MB | ratio <= 2; <= 1 table block | 0.05; blocks p50 1, max 1 pass | 0.04; 1 / 1 pass | 0.02; 1 / 1 pass |
| G1b insert, 100 MB | ratio <= 2; <= 1 table block | 0.01; blocks p50 1, max 2 pass on p50 | 0.01; 1 / 2 pass on p50 | 0.01; 1 / 2 pass on p50 |
| G2 open, 10 MB | ratio <= 2 | 1.28 (428 vs 335 ms) pass | 1.06 (679 vs 638 ms) pass | 0.68 (511 vs 750 ms) pass |
| G2 open, 100 MB | ratio <= 2 and <= 1,500 ms | 1.50, 910 ms pass | 1.03, 1,294 ms pass | 0.54, 913 ms pass |
| G3 memory | db + 64 MB | not measurable (renderer heap 486 / 449 MB) | no memory API | no memory API |
| G4 segment switch, 10 MB | <= 500 ms; <= 10x plain sync | 90.6 ms pass | 266 ms pass | 64.0 ms pass |
| G4 segment switch, 100 MB | same | 91.0 ms pass | 285 ms pass | 65.9 ms pass |
| G5 unit size | n/a | one default unit, 64 KB | same | same |
| G6 support | all present | all present | all present | all present |
| G7 Rust store | recorded only | owner only | owner only | owner only |
| G8 subkeys, one year | <= 150 ms | 1.3 ms (263 salts) pass | 10.5 ms pass | 10.5 ms pass |
| G9 file-table phase, 10 MB | <= 5 % of G2 budget | 8.84 ms pass | 10.7 ms pass | 7.56 ms pass |
| G9 file-table phase, 100 MB | <= 75 ms | 10.9 ms pass | 20.9 ms pass | 10.6 ms pass |
| G9 table blocks in the G1 sync | p50 0 | p50 0 pass | pass | pass |

Other measurements (10 MB / 100 MB):

| Measure | Chromium | Firefox | WebKit (container) |
|---|---|---|---|
| `changeKey` | 3.8 / 6.0 ms | 14.1 / 16.6 ms | 34.5 / 14.4 ms |
| `verify()` | 406 / 874 ms | 625 / 1,643 ms | 427 / 981 ms |
| `rotateDataKey` | 1,021 / 2,395 ms | 2,052 / 4,851 ms | 1,001 / 1,950 ms |
| Open after rotation, 100 MB | 910 ms | 1,234 ms | 878 ms |

Reading:

- No judged gate fails. Sync is 14 to 100 times faster than plain because only dirty records are written.
- Least headroom: G2 at 100 MB. Firefox is at 1,294 of 1,500 ms. Chromium's ratio is 1.50 of 2, up from 1.40 on 2026-11-14 and 1.34 on 2026-11-13; the plain open was 606 ms in this run, so noise on the shared host is plausible, but that was not verified.
- G3 is still not measurable headless.
- The `ops` part was not run, so the Linux `QuotaExceededError` question (headless profile on tmpfs) is still unanswered.
- Only the owner can measure G7, Tauri webviews, iPhone and iPad, Android and real Safari.

## SQLCipher parity as it stands

Source: `docs/plan/01-sqlcipher-comparison.md` section 2, 31 rows, last re-judged 2026-11-12. Its count: stronger 8, parity 14, n/a 2, weaker 7 (1 reduced, 6 accepted). This run changed no verdict, because `src/` did not change.

| Verdict | Rows |
|---|---|
| Stronger (8) | What is covered (every file under PGDATA); what the tag binds (AAD); truncation; replay of one unit; key hierarchy (KEK wraps DEK); wrong key vs corruption; rekey (`changeKey` instant, `rotateDataKey` resumable); integrity check (`verify()`) |
| Parity (14) | Cipher and mode (AES-256-GCM); unit size; nonce and subkey; integrity primitive; swapped unit; modified unit; deletion of a whole file; whole-store rollback (not detected, accepted); opaque header and salt; raw key; key storage (the app's job); metadata leakage; cipher agility; migration tooling |
| n/a (2) | Plaintext header option; key derivation (no passphrase) |
| Weaker (7) | Key material in memory; the whole database in memory; no `cipher_memory_security`; no FIPS build; durability (relaxed by default); no random access to a big database; maturity (new code, no external review) |

Where the table and reality differ:

- Open time: section 3 estimated +0.5 to 4 s at 100 MB. Shipped-code numbers on desktop are 0.54 to 1.50x plain, 910 to 1,294 ms. Android is the outlier (3.4x plain on the Redmi, 8.6 s at 100 MB against a 3 s phone budget, from the 2026-11-13 and 2026-11-14 reports). The 256 KiB option would not fix it: it slows Firefox by about 30 %.
- Migration tooling is marked "parity once PC-10 is in". Owner question 1 was answered A and PC-10 was not filed, so treat the row as not applicable.
- "Stronger" describes the design and is exercised by `test/format`, `test/fs`, `test/keys`. This report did not rerun them. The interrupted-rotation finding is open.
- Maturity stays weaker. The package is not audited and must not be described as audited.

## What the owner must do next

1. **Device runs (#4, open).** Checklist: Tauri shell on macOS at 10 and 100 MB (commands in `bench/README.md`); the oldest supported iPhone (name it); Windows WebView2 and Android WebView if a device is at hand. Compare against the gate table; if a gate fails on a device, reopen #5 with the numbers.
2. **Redmi `gates100` runs from #63** (phone unlocked): 64K and 256K, with and without split4, with `readsOnly`. The one that matters is 64 KB with `readsOnly`: it shows whether the Android open time is in the paged reads or in decryption. That decides whether a read-path fix with no format change is worth an issue.
3. **iPhone `enc100` run** (commands on #4: https://github.com/2002Bishwajeet/pglite-cipher/issues/4#issuecomment-6870667271). For the record only, since stage A already stopped on desktop.
4. **Also on device** (pending since 2026-11-13): iPad Air M3 Safari `bench gates100` to confirm the #41 fix, and the iPhone 15 re-run for #42. The Journal tech article waits for these.
5. **Owner-only boxes.** G7 (Rust store throughput; Tauri shell with `encfs-bench`; needs `docs/plan/journal/02-native-bench-endpoints.md`) and G3 on a device with a memory API. Rust/Tauri store issues are filed only after your G7 run.
6. **Decide which open findings block a release** and which become issues: the damaged-new-store case at an interrupted rotation, the six minor `changeKey` items, the unrecorded checkpoint 2 findings, the idbread connection leak, and the four bench findings above. The two bench-labelling ones (items 1 and 2 under Checkpoint findings) can mislabel a result file; fix them before the next `--block` run.
7. **Before filing the on-demand build issue** (#47 decision), all of: a shell probe on iOS, Android and macOS shows `crossOriginIsolated` is true, sync handles work, and Journal's live blocks and remote images still load under COEP; the iPhone 15 and iPad spike runs survive 100 MB with an idle step added; Android and iPad G7 numbers are in. If the COEP probe fails, do not build; use the Rust store.
8. **Journal-side plan files** in `docs/plan/journal/` (17 files, `01` to `17`). No Journal-side work has been done by this harness. `07-1017-wire-encrypted-fs.md` is the one that uses this package. `02-native-bench-endpoints.md` is for G7; `03-query-cache-in-pglite.md` is the query cache; `04` to `06` are native secrets, credentials and sealed device storage; `10` is recovery, reset and sign-out; `11` to `14` are the settings, app lock, iOS Keychain and Android Keystore pieces; `15` is the desktop sign-in window residue; `16` is the at-rest scanner and device checklist; `17` is the epic rewrite; `01` is the optional submodule. `08-native-migration.md` and `09-native-plaintext-sweep.md` are not needed under answer 1A.
9. **Nightly workflow.** Trigger once with `workflow_dispatch` and read the first run. The 2,000-transaction crash matrices have not run to completion anywhere.
10. **Read CI once** on 04ba064. A red main comes back to the harness as a `ci-failure` issue.
11. **Clean up.** Stale worktrees (`.claude/worktrees/wf_*`) and old local branches, including `agent/63-format-256-kib-block-option-for-android`, which is merged.

## Risks

- **Android open time.** 8.6 s at 100 MB on the Redmi against a 3 s phone budget; unfixed. Split4 and parallel parts slow desktop, and 256 KiB blocks slow Firefox by about 30 %. The next lead is the read path at 64 KB, pending owner item 2.
- **Chromium G2 margin.** 1.50x plain at 100 MB against a limit of 2x. It has risen across three runs (1.34, 1.40, 1.50), possibly host noise. It is the thinnest ratio margin; Firefox is the thinnest absolute margin (1,294 of 1,500 ms).
- **Open memory.** The two-page read-ahead is about 64 MB of ciphertext on top of the database. G3 is unmeasurable headless; the iPhone 15 survived at 100 MB with a 198 MB wasm heap, but the margin on older phones is unknown.
- **Whole database in memory**, plaintext, while the app is open. The app lock (J-12) is the mitigation. An on-demand design exists only as a spike.
- **CI is unverified for this run.** The commits of this run had pending, in-progress or cancelled main runs when this was written. Firefox and WebKit full suites ran locally for none of the PRs in this run.
- **Benchmark scope.** Headless engines on a shared machine; WebKit is Playwright's Linux build in a container, not Safari and not a webview; `ops` not run. Not a phone.
- **Maturity.** New cryptographic format, no external review, one author and agents. Keep the repository private; make no "audited" claim.
