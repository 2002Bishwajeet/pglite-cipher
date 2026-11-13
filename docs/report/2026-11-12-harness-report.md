# pglite-cipher harness run, 2026-11-12

Base: `origin/main` at c012344 (merge of #29). This replaces the earlier version of this file (bd580e7, written when #2 was still blocked); that version stays in git history. Sources: the harness result rows, `gh` for issues and PRs, `bench/results/2026-11-12/SUMMARY.md`, `spike/RESULTS.md` section 6, `docs/plan/01-sqlcipher-comparison.md`. CI was not waited on.

## Summary

The package now has its whole core on `main`: the on-disk format and crypto core (#5), the storage backends (#7), `EncryptedFs` open/sync/close (#8), and `changeKey`, crash-safe `rotateDataKey` and `verify()` (#9). The spike (#2), the provisional gate (#3) and the agent device runs (#11) are closed. Two checkpoints reviewed the new code and fixed what they found. One CI failure on `main` (WebKit, #26) was fixed. The benchmark was run on all three engines.

What did not finish: #10 (benchmark gates in CI, long fuzz/crash/soak runs, ported scenarios, SECURITY.md, release checklist). The harness cut the agent off before verification finished, so nothing is committed or pushed. #4 is the owner's device run and is untouched.

Two things in the benchmark need the owner: G3 (memory) fails in Chromium and cannot be measured in Firefox or WebKit, and the benchmark page measures the spike prototype, not the shipped `src/`. Until #10 lands, there is no performance number for the released code.

| Item | Result |
|---|---|
| PRs merged this run (product or tests) | #23, #24, #27, #25, #28 |
| PRs merged this run (docs, bench) | #22, #29 |
| Issues closed this run | #2, #3, #5, #7, #8, #9, #11, #26 |
| Stopped | #10 |
| Open, owner only | #4 |
| Checkpoints | 2 (#25, #28) |
| Benchmark | ran, PR #29 |

## What shipped

Issue by issue, from the earliest PR in this report window. PRs #12 to #17 are in the earlier reports.

| Issue | What | PR |
|---|---|---|
| #2 Spike | Prototype filesystem, filesystem-operation trace, benchmark page with gates G1 to G9, `spike/RESULTS.md`. Closed by the owner's decision to accept the open-time limit (plain PGlite opens in about 746 ms in Chromium, and most of that is PGlite start-up) | https://github.com/2002Bishwajeet/pglite-cipher/pull/18 |
| #3 Spike gate | Closed with "Provisional yes": block size 65536, store IndexedDB, open budget 1500/3000 ms, durability yes, go yes. No PR (decision comment: https://github.com/2002Bishwajeet/pglite-cipher/issues/3#issuecomment-6817955341) | none |
| #11 Device runs | Collector and runners for macOS WebKit, macOS WKWebView and the iOS simulator. iPhone 15, iPad Air and Redmi stay owner-pending | https://github.com/2002Bishwajeet/pglite-cipher/pull/19 |
| #5 Format v1 and crypto core | `FORMAT.md`, `src/format/`: codec, table, keys, records, manifest, self-test, errors. WebCrypto only. 70 browser tests per engine plus a Node-only independent decoder | https://github.com/2002Bishwajeet/pglite-cipher/pull/20 |
| #7 Storage backends | Interface, IndexedDB and in-memory backends, fault injection, shared conformance suite. Includes a fix so a typed-array view is stored as its own bytes and not its neighbours' | https://github.com/2002Bishwajeet/pglite-cipher/pull/21 |
| n/a | Plan doc: native PostgreSQL encryption (pgcrypto, pg_tde, pg_vault_tde) compared | https://github.com/2002Bishwajeet/pglite-cipher/pull/22 |
| #8 EncryptedFs | Open, sync, close on format v1. Load is a retry loop (3 attempts); a root that moves during all three gives `StaleWriterError` instead of a false corruption verdict | https://github.com/2002Bishwajeet/pglite-cipher/pull/23 |
| #9 Key change, rotate, verify | `changeKey`; `rotateDataKey` writes a second store, marks it, switches, retires the old one; `open` resumes or undoes an interrupted rotation; fenced on the old store's root so a stale writer cannot delete another store; `verify()` | https://github.com/2002Bishwajeet/pglite-cipher/pull/24 |
| Checkpoint 1 | Review and simplify 3633c35..474f4a5: sparse-array-safe tag check, IndexedDB open no longer caches a rejection, one concat helper | https://github.com/2002Bishwajeet/pglite-cipher/pull/25 |
| #26 CI red on main | `IndexedDbBackend.destroy()` returned on WebKit's `onblocked` while the database was still being deleted. It now waits for `onsuccess`, capped at 2,000 ms. Test unchanged | https://github.com/2002Bishwajeet/pglite-cipher/pull/27 |
| Checkpoint 2 | Review and simplify 474f4a5..4f37b65: removed a redundant `#db` reset, cleared the destroy timer on error and on a repeated `blocked` event | https://github.com/2002Bishwajeet/pglite-cipher/pull/28 |
| Bench | Results for all three engines, 10 MB and 100 MB, with `SUMMARY.md` | https://github.com/2002Bishwajeet/pglite-cipher/pull/29 |

Earlier and not repeated: #1 scaffold, #6 dirty-block tracker, and a harness fix for the WebKit container. The harness row for #2 reads "closed (no code)": #2 was closed in this run without new code, and its code is PR #18.

Size of the shipped code, from the PRs: #20 +3,194, #21 +1,051, #23 +3,580, #24 +1,973 lines (tests and docs included).

Local verification on the G14 (from the PR descriptions): Node 257 tests and Chromium 254 tests passed at checkpoint 1. Firefox could not be run locally (killed with exit 143 three times at checkpoint 2) and WebKit does not run on this host except through `webkit.sh`, so for #8, #9 and both checkpoints Firefox and WebKit are recorded as "CI covers it", not as passes. WebKit did run locally for #5, #7 and #26 (the container, exit 0).

## What stopped, and why

### #10 Benchmark gates in CI, long runs, SECURITY.md (stopped)

STOP comment: https://github.com/2002Bishwajeet/pglite-cipher/issues/10#issuecomment-6839746982

Condition: none of the issue's STOP conditions applied. The harness made the agent return before verification finished. Nothing is committed and nothing was pushed (`origin/main..HEAD` has no commits). The work is uncommitted in the worktree `/home/biswa/Github/pglite-cipher/.claude/worktrees/wf_47356dba-866-30` (branch `agent/10-benchmark-gates-in-ci-long-fuzz-crash-so`): 32 modified or moved files (+550, -447) and 11 untracked files. It moves `spike/` into `bench/` and edits CI, `package.json`, the vitest config and several test files.

Not run: the full `npm test` (a background run was still going), `npm run test:browser`, `npm run build`, and `CIPHER_LONG=1 npm test`.

The label state is inconsistent. The harness says the `blocked` label was added to #10. The issue shows `agent-ready` and `security` only (checked after the run), and the `blocked` label exists in the repository. The next harness run may therefore pick #10 up again, which may be what you want, since there was no real blocker.

The reviewer's decisions on the agent's questions (owner unavailable), on the issue. You should confirm or reverse them:

1. G9: accepted under your restatement on #2. The test asserts no table block is written by a sync that changes no file (decided from a file-map diff), p50 table blocks is 0, and no more than one table block per grown file. The number of syncs that grew a file is recorded. A table block with no file change is a STOP.
2. G4: the denominator is the plain `idb://` one-row sync, limit 10x. Encrypted switch over encrypted sync, and encrypted switch over plain switch, are recorded, not asserted. Against the encrypted sync the ratio is about 20x.
3. G3: record only, "not measurable" where `measureUserAgentSpecificMemory` is missing, no CI assertion, kept as an owner-device item in `RELEASE-CHECKLIST.md`.
4. pgvector: `@electric-sql/pglite-pgvector@0.0.11` approved as a dev dependency, exact pin, listed in `THIRD_PARTY.md`, `node_modules` never committed.
5. Long run: nightly on the yantra-box runner with an explicit timeout. The agent may merge without the full local run if normal verification (WebKit included) passes, a local `CIPHER_LONG=1 CIPHER_SOAK_MINUTES=5` run passes with the budgets untouched, the PR says the full run is outstanding, and the nightly is dispatched once after merge. A later failure is a STOP, never a budget cut.

Also noted by the agent: there is no `importPlainDataDir` yet (plan file 10 was not filed, since you chose option A on question 1), so there is no import bench row or import crash matrix. The nightly CI factor is 2, and the newest-PGlite job runs Node and Chromium only.

### #4 Owner device runs (open, not for agents)

macOS and the oldest iPhone are required; Windows and Android if a device is at hand. See "What the owner must do".

## Checkpoint findings

Both checkpoints found no blockers. Fixed in the checkpoints: the three items of #25 and the two of #28 (above). Findings left open across all PRs, grouped by what could matter:

Durability and key handling (decide whether any blocks a release):

- `changeKey` does not settle an unknown outcome. If the header commit rejects with something other than `StaleWriterError` and the settle read of slot 0 also fails, the error is rethrown while the in-memory key and header still hold the old values. If the commit did apply, the store is under the new key while the caller was told it failed. An app that then discards the new key gets `WrongKeyError` at next launch. (PR #24, finding 1.)
- A strict sync request that joins an in-flight relaxed sync gets no strict commit: the promise resolves but the data was committed relaxed. This is the README's flush-on-hide pattern, and `closeFs` has the same gap. The README comment "commits everything strict" is not always true. (PR #23.)
- Open of an interrupted rotation whose new store has a damaged root or header fails, though the old store is intact and marked. The issue's resume rule says to delete the new store and open the old one. (PR #24, finding 2.)

IndexedDB backend:

- With `IndexedDbBackend.pair`, `isEmpty()` on the empty slot recreates the database that `destroy()` removed, so after a reopen `<name>.a` and `<name>.b` both exist. No test covers it. (PR #24, finding 4.)
- A failed open racing `destroy()` can clear a newer connection and leak it. Rare. (PR #28.)
- `readRange` with a limit of 2^32 or `Infinity` works on `MemoryBackend` and rejects on real IndexedDB. Not covered by the conformance suite. (PR #21.)
- The 2,000 ms grace path of `destroy()` has no test, and a regression to waiting forever would go unnoticed. (PR #27.)

Format and load:

- A table that maps two block ids to the same file and index leaves a hole in the tags and `concat` throws `TypeError` instead of `CorruptStoreError`. Reachable only by someone holding the key. (PR #28.)
- Lone surrogates in a path are replaced by U+FFFD, so two paths could encode to the same bytes. Postgres paths are ASCII. (PR #20.)
- A rejected `deriveKey` promise stays cached for that salt. `injectRandom` and `restoreRandom` are exported and unused. (PR #20.)

Harness and device tooling (PR #19):

- The collector `serve.mjs` can crash on a malformed URL or a directory path; `save()` can keep a stale top-level `error`; G6 failures recorded as `"error: ..."` strings inside `extras.g6` do not stop `--until`; logging POSTs may overlap the measured open; the `tailscale serve` exit status is not checked. The committed numbers are not affected.

Test gap: the rotation test "a rotation undone by a second instance" passes with no assertion if the second instance's `openPair` throws inside `before` (PR #24, finding 3).

## Benchmark gates

Source: `bench/results/2026-11-12/SUMMARY.md`, `main` at c5ea74b, 20 runs per measure, p50. Targets as restated by you on #3.

What was measured: the benchmark page runs the spike prototype (`spike/protoFs.ts`), not `src/EncryptedFs`. It cannot run in Node (needs IndexedDB and a DOM), so there is no Node row. The "10 MB" and "100 MB" cases are blob payloads; the data directories are 64.7 MB and 254.2 MB. Chromium 158 and Firefox 159 ran on the G14 (Ryzen 5 4600HS) while other sessions shared it, so the timings are noisy. WebKit ran on the Mac (M1 Pro) through `webkit.sh`: Playwright WebKit, not Safari or WKWebView. Compare plain against encrypted inside one engine, never across engines.

Times are ms. "Enc" is encrypted at the recommended unit for that run.

| Gate | Target | Chromium | Firefox | WebKit (Mac) |
|---|---|---|---|---|
| G1 sync, one-row UPDATE, 100 MB | enc <= 2x plain | 0.72 vs 71.9: pass | 1.58 vs 150: pass | 0.44 vs 157: pass |
| G1b sync, 4 KB insert, 100 MB | <= 2x plain, <= 1 table block | 1.63 vs 586: pass | 3.34 vs 748: pass | 1.02 vs 269: pass |
| G2 open, 10 MB | enc <= 2x plain | 414 vs 357: pass at 64 KB; 8 KB fails (967) | 592 vs 639: pass, all units | 139 vs 279: pass, all units |
| G2 open, 100 MB | <= 2x plain and <= 1,500 | 849 vs 663: pass at 64 KB only (8 KB 2,860; 32 KB 1,602) | 1,144 vs 1,317: pass at 32 and 64 KB (8 KB 2,054) | 238 vs 392: pass, all units |
| G3 memory | open <= db + 64 MB | FAIL: 683 MB at 100 MB, 518 MB at 10 MB; plain `idb://` 477 and 315 MB | not available | not available |
| G4 segment switch | <= 500 | 80.3: pass, all units | 279: pass at 32 and 64 KB; 8 KB fails (613) | 32.0: pass, all units |
| G5 unit size | smallest unit passing G2 | 64 KB (32 KB at 10 MB) | 32 KB (8 KB at 10 MB) | 8 KB |
| G6 support | all present | pass | pass | pass |
| G7 Rust store | recorded only | owner (Tauri only) | owner | owner |
| G8 subkeys | 366 salts, <= 150 | 3.7: pass | 14.6: pass | 22.0: pass |
| G9 file table | file-map <= 5% of G2 budget; no table block without a file change | pass at every unit (13.0 ms at 64 KB, 100 MB) | pass at every unit | pass at every unit |

Reading:

- Sync is far faster than plain (roughly 100 to 360 times faster at 100 MB for the one-row update), as the plan expected. Query time is unchanged by design.
- Open time is the cost. At 64 KB it is within 2x of plain everywhere, and under the 1,500 ms budget everywhere. Chromium at 100 MB is 849 vs 663 ms (+28%). Only the 64 KB unit passes G2 at 100 MB in Chromium; 8 KB fails on both Chromium and Firefox. The format default of 64 KB (decided at #3) is the one that passes on all three engines.
- G3 fails in Chromium, and plain `idb://` fails it too, because PGlite on IndexedDB keeps the whole directory in memory. It is a property of the design, not of the encryption layer. It could not be measured at all in Firefox and WebKit headless.
- Firefox G4 fails at 8 KB, which is not the default unit.
- G9 read strictly ("the G1 sync writes no table block") fails: in 1 to 2 of 20 syncs a file grew (a GIN pending list or free-space-map page) and one table block was written. No sync that changed no file wrote a table block, which is your restated rule.

Device numbers from #11 (`spike/RESULTS.md` section 6, spike prototype, 64 KB, p50, encrypted vs plain):

| Gate | macOS WebKit | macOS WKWebView | iOS simulator (not representative) |
|---|---|---|---|
| G2 open, 10 MB | 506 vs 635 | 340 vs 510 | 393 vs 1,097 |
| G2 open, 100 MB (<= 1,500) | 449 vs 963 | 583 vs 1,945 | 1,324 vs 1,581 |
| G4 segment switch, 100 MB (<= 500) | 103 | 305 | 387 |
| G1 sync, 100 MB | 4.6 vs 330 | 12.6 vs 475 | 6.6 vs 692 |

WKWebView, the engine of the macOS app, passes. The simulator uses the Mac's CPU, so its times say nothing about a phone. iPhone 15, iPad Air (M3) and Redmi were not reachable (`devicectl` lists them unavailable, `adb devices` lists nothing) and are owner-pending.

## SQLCipher parity as it stands

The table is `docs/plan/01-sqlcipher-comparison.md` section 2 (31 rows). It was written on 2026-11-10 and has not been revised for what shipped; the 2026-11-12 edit only added the native PostgreSQL comparison. Count in that table: stronger 8, parity 14, n/a 2, weaker 7.

| Verdict | Rows |
|---|---|
| Stronger (8) | What is covered (every file under PGDATA); what the tag binds (AAD: record type, store id, key id, file id, block index); truncation; replay of one unit; key hierarchy (KEK wraps DEK); wrong key vs corruption; rekey (`changeKey` instant, `rotateDataKey` resumable); integrity check (`verify()`, and every open decrypts everything) |
| Parity (14) | Cipher and mode (AES-256-GCM); unit size; nonce and subkey (v5-style, cheaper route); integrity primitive; swapped unit; modified unit; deletion of a whole file; rollback of the whole store (not detected, accepted); header and salt (opaque header); raw key; key storage (the app's job, OS keychain); metadata leakage; cipher agility; migration tooling |
| n/a (2) | Plaintext header option; key derivation (no passphrase; Argon2id would live in Rust) |
| Weaker (7) | Memory for key material; whole database in memory; no `cipher_memory_security`; no FIPS build; durability (relaxed by default; Journal runs relaxed today); no random access to a big database; maturity (new code, no external review) |

Where the table and reality now differ:

- Migration tooling is marked "parity once PC-10 is in". You chose option A on owner question 1 (encryption in the first public native build), so plan file 10 was not filed. Treat this row as not applicable.
- The "Stronger" rows describe the design. Each is exercised by tests in `test/format`, `test/fs` and `test/keys` according to the PR descriptions, but this report did not rerun the suites, and for Firefox and WebKit relies on CI.
- Two of the "Stronger" rows have open caveats from the checkpoints: rekey (`changeKey` unknown-outcome gap) and the integrity story at an interrupted rotation with a damaged new store.
- Performance rows in section 3 of that file ("Open +0.5 to 4 s at 100 MB and 8 KB; about a third at 64 KB") are now backed by prototype measurements, not by the shipped code. The measured 100 MB open at 64 KB is 238 to 1,144 ms depending on engine.
- Maturity stays weaker. Do not describe the package as audited; an external review (owner question 11) has not happened.

## What the owner must do next

1. Decide on #10. The agent's work is intact in `/home/biswa/Github/pglite-cipher/.claude/worktrees/wf_47356dba-866-30`. Either let the harness resume it (the `blocked` label is not on the issue, see above) or finish verification there. Confirm or reverse the five decisions listed under #10, and restate G9 and G3 in the issue text (G9 to match #2, G3 because it also fails for plain `idb://`). Consider adding "encrypted switch <= 2x plain switch" to G4.
2. Decide whether the Chromium G3 failure and the Firefox G4 8 KB failure block the next checkpoint (asked in PR #29). Neither affects the 64 KB default.
3. Decide whether the open findings from #24 (especially the `changeKey` unknown outcome) block a release, and which of the others become follow-up issues.
4. Device runs on #4 (about an hour):
   - macOS, in the Tauri shell, at 10 MB and 100 MB. Paste the JSON on #4.
   - The oldest iPhone you will support (name it). Paste the JSON. This sets the 3 s open budget against a real phone; the simulator cannot.
   - Windows (WebView2) and Android WebView if a device is at hand; otherwise the Journal checklist (`docs/plan/journal/16-at-rest-scanner-e2e-device-checklist.md`) carries them.
   - iPhone 15, iPad Air (M3) and the Redmi need pairing or an unlock before an agent can run them (#11 left them owner-pending). If any device contradicts the gate table, reopen #5 with the numbers.
5. Owner-only boxes: G7 (Rust store throughput, Tauri shell with the `encfs-bench` feature) and G3 on a device that offers `measureUserAgentSpecificMemory`.
6. Journal-side plan files in `docs/plan/journal/` (17 files, J-01 to J-17). This harness did no Journal-side work; the files are plans for issues in the Journal repository. By title: 01 optional submodule, 02 native bench endpoints, 03 query cache in PGlite, 04 to 06 keychain and sealed device storage, 07 wire the encrypted filesystem, 08 and 09 migration and plaintext sweep (08 is not needed under owner answer 1A), 10 recovery and reset, 11 to 15 Settings, app lock and platform privacy, 16 the at-rest scanner and device checklist, 17 the epic rewrite. File the ones you want agents to take; 07 is the one that uses this package.
7. Pending at the time of writing: CI on `main` at c012344 was queued. The two runs before it (c5ea74b, 4f37b65) show as cancelled, not red. Read it once; a red result comes back as a `ci-failure` issue.

## Risks

- Open time is the product risk. It is tied to PGlite loading the whole directory, and it grows with data. On the engines measured it meets the desktop budget at 64 KB, but no phone has been measured. The 3 s phone budget is untested.
- The numbers are from a prototype, and the machine was shared. The released `EncryptedFs` has no benchmark yet; #10 carries it. A regression against the prototype would be invisible until then.
- Firefox and WebKit have not been run locally for #8, #9 or either checkpoint. CI is the only evidence for them, and CI for the latest `main` had not finished. One WebKit-only failure (#26) already got through the local gate once.
- Memory: the whole database sits in memory, plaintext, while the app is open. G3 fails and cannot be measured outside Chromium. App lock (J-12) is the mitigation.
- Durability: syncs are relaxed by default, and a strict request can resolve after a relaxed commit (finding on #23). A flush on hide may not be as strict as the README says.
- Key change: `changeKey` has an unsettled-outcome path that can leave a store under a key the caller thinks it rejected.
- Maturity: new cryptographic format, no external review, one author and agents. Keep the repository private and make no "audited" claim.
- Process: #10 is stopped without a real blocker and its work is only in a worktree. Deleting that worktree loses it.
