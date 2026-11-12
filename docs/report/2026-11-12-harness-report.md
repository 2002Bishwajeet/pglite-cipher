# pglite-cipher harness run, 2026-11-12

Base: `origin/main` at 2df4459. Written from the harness facts plus `gh`, `git` and the spike results file on the local branch (`spike/RESULTS.md`, commit 2501174, not pushed). CI was not waited on.

## Summary

Nothing new merged to the product code. The run resumed #2 (the spike), the owner's earlier decision on the file-table layout (option 1, accept) was applied, and the spike finished its measurements. It then stopped again on a different condition: G2, the open-time gate at 10 MB (400 ms), fails in Chromium at every unit size, and plain `idb://` fails it by itself in all three engines. The owner has to restate that budget or accept the miss. Eight issues still wait behind #2.

The only PR merged since the last report is #16, a harness fix. The spike branch could not be pushed: the remote copy of `agent/2-spike-prototype-filesystem-filesystem-op` was written before the local branch was rebased onto newer `main`, so the two histories differ. It was not force-pushed.

| Item | Result |
|---|---|
| PRs merged this run | 1 (#16, harness only) |
| Issues closed this run | 0 (#1 and #6 closed in the previous run) |
| Stopped | 1 (#2, label `blocked`) |
| Skipped, waiting | 7 (#3, #5, #7, #8, #9, #10, #11) |
| Checkpoints | 0 |
| Benchmark step | not run (no `bench/` on `main`); spike numbers exist on the unpushed branch, see below |

## What shipped

| PR | What | Link |
|---|---|---|
| #16 | Harness: the local WebKit container now runs under the heavy lock with a 4 GB memory cap (a full benchmark run had OOM-killed the earlier harness) | https://github.com/2002Bishwajeet/pglite-cipher/pull/16 |

Earlier, still the whole product code on `main`: #12 scaffold (#1, closed), #13 dirty-block tracker (#6, closed), #14 checkpoint 1, #15 the 2026-11-11 report.

No issue closed this run. All of the spike's work (`spike/`, `bench/`) lives on the unpushed branch.

## Issue status

| Issue | Title | State | Note |
|---|---|---|---|
| #1 | Scaffold | closed | PR #12 |
| #2 | Spike: prototype filesystem, trace, benchmark page with gates | open, `blocked` | STOP 4, see below |
| #3 | Spike gate (provisional) | open | waits on #2, #11 |
| #4 | Owner: confirm spike numbers on real webviews | open, owner-only | not agent-ready |
| #5 | On-disk format v1 and crypto core | open | waits on #3 |
| #6 | Dirty-block tracker | closed | PR #13 |
| #7 | Storage backends | open | waits on #5 |
| #8 | EncryptedFs | open | waits on #5, #7 |
| #9 | changeKey, rotateDataKey, verify | open | waits on #8 |
| #10 | Bench gates in CI, fuzz, SECURITY.md | open | waits on #9 |
| #11 | Device benchmarks run by agents | open | waits on #2 |

## What stopped, and why

### #2 Spike (blocked)

STOP comment: https://github.com/2002Bishwajeet/pglite-cipher/issues/2#issuecomment-6816803132 (the harness's note is comment 6816810784).

Condition: G1 or G2 fails in Chromium at every unit size (STOP 4). G2 at 10 MB (at most 400 ms) fails at 8, 32 and 64 KB. G2 10 MB p50 in Chromium: plain 746 ms, 8 KB 1,523, 32 KB 1,110, 64 KB 771. Firefox and WebKit fail too. Plain `idb://` misses 400 ms by itself in every engine, so the budget is below what PGlite needs to open its smallest store. The "10 MB" case is a 67.8 MB data directory, because a fresh PGlite directory is 40 MB and every open reads all of it. The 2x-plain part of G2 passes at 32 and 64 KB. Every other gate passes at 64 KB. G3 cannot be measured headless and G7 needs the owner.

What happened to the first STOP: the file-table finding from the previous run (about half of ordinary syncs change the table) was decided by the owner as option 1, accept (comment 6814184918). The prototype keeps a file's size with its tail run of block ids, so a growing file rewrites one table block. STOP 5 now applies only if a sync that changes no file writes a table block. Measured: that never happened in any run.

The branch (local `agent/2-spike-prototype-filesystem-filesystem-op`, HEAD 2501174, three commits ahead of `main`) holds `spike/` (trace filesystem, workload, prototype filesystem, `RESULTS.md`, `results/*.json`) and the benchmark page. The remote branch has two older commits (61727c7, 7a1280d), which the local three replace after a rebase. The push was rejected as non-fast-forward. Someone must choose: force-push the rebased branch, or merge the remote into it. The harness did not do either.

The harness note says the earlier `run.mjs` verification was not rerun in full here, because a full run OOM-killed the previous harness; the committed results come from that full run, and a Chromium extras smoke run was restored afterwards.

### Skipped

| Issue | Waiting on |
|---|---|
| #3 | #2, #11 |
| #5 | #3 |
| #7 | #5 |
| #8 | #5, #7 |
| #9 | #8 |
| #10 | #9 |
| #11 | #2 |

## Checkpoint findings

No checkpoint ran. The last one (PR #14) is in the 2026-11-11 report; its minor findings are still open, including the 200 versus 2000 browser property-test cases question.

## Benchmark gates

The benchmark step of the harness did not run: `origin/main` has no `bench/README.md` or `spike/README.md`, and `package.json` has no bench script. Nothing was run, saved or committed on `agent/bench-2026-11-12`.

The numbers below are from the spike branch (`spike/RESULTS.md`, not merged). Headless Playwright on the Linux host (a shared 16 GB laptop, so absolute times are noisy by up to 2x; the encrypted-against-plain ratios in one run are stable). WebKit is Playwright's Linux build in a container, not Safari or WKWebView. 20 runs each, p50 in ms, gates judged on p50. These are not device numbers.

G2 open time (budget 400 ms at 10 MB; 1,500 ms and at most 2x plain at 100 MB):

| Engine | Size | Plain | 8 KB | 32 KB | 64 KB |
|---|---|---|---|---|---|
| Chromium | 10 MB | 746 | 1,523 fail | 1,110 fail | 771 fail |
| Chromium | 100 MB | 776 | 3,424 fail | 2,553 fail | 1,432 pass |
| Firefox | 10 MB | 673 | 776 fail | 560 fail | 602 fail |
| Firefox | 100 MB | 1,829 | 2,139 fail | 1,221 pass | 1,332 pass |
| WebKit | 10 MB | 1,193 | 1,478 fail | 609 fail | 669 fail |
| WebKit | 100 MB | 2,764 | 2,088 fail | 1,712 fail | 1,207 pass |

An earlier, quieter Chromium run: 10 MB plain 361, 8 KB 1,034, 32 KB 732, 64 KB 449; 100 MB plain 542, 8 KB 2,896, 32 KB 1,516, 64 KB 871. Same verdicts.

G1 sync after a one-row update at 100 MB (p50, ms; plain in brackets): Chromium 0.75 (8 KB), 1.06 (32 KB), 6.84 (64 KB) against 75.4; Firefox 1.58, 1.82, 2.02 against 176; WebKit 2.40, 5.50, 5.86 against 932. The gate (at most 2x plain) passes everywhere, by a wide margin, because the encrypted store writes a few blocks and plain `idb://` rewrites whole files.

G4 sync when a new 16 MB WAL segment appears (500 ms at 10 and 100 MB; p50, ms):

| Engine | 8 KB | 32 KB | 64 KB |
|---|---|---|---|
| Chromium | 289 / 192 pass | 148 / 147 pass | 136 / 280 pass |
| Firefox | 638 / 920 fail | 322 / 355 pass | 293 / 330 pass |
| WebKit | 901 / 448 (10 MB fails) | 141 / 356 pass | 111 / 146 pass |

Other gates:

| Gate | Result |
|---|---|
| G3 memory | Fails as measured, for plain `idb://` too: 375-481 MB at 10 MB and 671-966 MB at 100 MB in headless Chromium; the wasm heap alone is 198 MB. Needs `measureUserAgentSpecificMemory` on a real device. Firefox and WebKit: not available |
| G5 unit size | 64 KB on Chromium and WebKit; 32 KB on Firefox. The spike recommends 64 KB: the only unit that passes G2 at 100 MB on Chromium and WebKit |
| G6 feature support | AES-GCM, HKDF, `unwrapKey`, IndexedDB `durability`, key-range `getAll`: all present in Chromium, Firefox and WebKit |
| G7 Rust store | owner only (Tauri shell) |
| G8 session salts | After 365 simulated sessions, 366 salts still own live records. Cost of one `deriveKey`: 0.010 ms Chromium, 0.08 ms Firefox and WebKit. Total at open: 3.7 ms Chromium, 29 ms others, under the 150 ms budget |
| G9 file table | Passes at 32 and 64 KB on all three engines. At 8 KB the 10 MB file-map phase misses its 20 ms budget in Chromium (22 ms) and WebKit (51 ms). In 1 of 20 G1 syncs (2 at 8 KB, 100 MB) a file grew and that sync wrote one table block; strictly read, "the G1 sync writes no table block" fails on that sync |

AES-GCM micro-benchmark (100 MB, 64 calls in flight, encrypt / decrypt MB/s): Chromium 445 / 590 at 8 KB and 1,043 / 874 at 64 KB; Firefox 102 / 206 at 8 KB and 722 / 1,002 at 64 KB.

## SQLCipher parity as it stands

The table is in `docs/plan/01-sqlcipher-comparison.md` (2026-11-10). It describes the plan. No format code exists on `main` yet (#5 has not started), so none of these rows is verified in code. The spike prototype checks only that a round trip works at 8, 32 and 64 KB and that sync writes behave as designed.

Stronger in 8 rows, weaker in 7 (1 reduced, 6 accepted), parity or n/a in the rest.

| Area | Verdict |
|---|---|
| Cipher (AES-256-GCM), unit size, raw key, key storage by the app | Parity |
| Integrity primitive (GCM tag against HMAC-SHA512), swapped and modified units | Parity |
| Nonce handling (per-session HKDF subkey, at most 2^24 encryptions per subkey) | Parity with SQLCipher v5 by a cheaper route |
| Header opacity, metadata leakage (block count and write timing stay visible) | Parity |
| What is covered (every file under PGDATA, names and sizes hidden) | Stronger |
| What the tag binds (type, store id, key id, file id, block index) | Stronger |
| Truncation, replay of one unit | Stronger |
| Deleted file | Parity for the user |
| Key hierarchy and rekey (`changeKey`, `rotateDataKey`) | Stronger |
| `verify()` and wrong key versus corruption | Stronger |
| Whole-store rollback | Parity, accepted (not detected) |
| Key material in memory, data in memory, no `cipher_memory_security`, no FIPS build, durability (relaxed) | Weaker, accepted |
| Maturity (new code, no external review) | Weaker, reduced not closed |
| Passphrase KDF | n/a (no passphrase) |

Performance position, updated by the spike: query time stays at 0 % overhead. Sync after a small edit is far faster than plain `idb://`. Open is the weak point: only 64 KB blocks open a 267 MB data directory within 1.5 s, and the 10 MB budget cannot be met by anyone on this host. Whether real webviews do better is the question for #4 and #11.

## What the owner must do next

1. Decide G2 at 10 MB: raise the 400 ms budget (for example to "at most 2x plain" only, or an absolute value above plain's own 673-1,193 ms), or accept the miss and drop the gate. Then clear the `blocked` label on #2. Without this the harness cannot get past #2.
2. Decide what to do with the spike branch: force-push the rebased local branch, or merge the older remote commits. The local HEAD is 2501174 in the harness worktree `.claude/worktrees/wf_a20ca398-ccc-2`; if that worktree is removed before a push, the three commits survive only as the branch ref in the main repository.
3. Note the unit-size result for #3: the spike recommends 64 KB (32 KB for Firefox only). 8 KB fails G2 at 100 MB on all three engines.
4. Device runs: #4 (owner) and #11 (agent, waits on #2). WKWebView (macOS, iPhone), WebView2 (Windows) and Android WebView are the real tests of G2, G3 and G7. Commands are in `bench/README.md` once the branch merges.
5. Owner-only boxes: the `yantra-box` runner must be online, or CI jobs queue forever. At the time of writing the CI run for 2df4459 on `main` was queued. Mac access through `scripts/harness/remote.sh mac` is needed for #11. A red main returns as a `ci-failure` issue.
6. The Journal-side plan files (`docs/plan/journal/`, J-01 to J-17) are untouched. File them in the journal repository when ready. J-16 (at-rest scanner, per-platform device checklist) gates any "encrypted at rest" claim. No public claim before J-05, J-06, J-09, J-15 and J-16 close and an external review (owner question 11) exists.
7. Raise or keep the browser property-test case count (200 in browsers against 2,000 in Node; plan 06 asks for 2,000). Carried over from checkpoint 1.
8. The licence holder in `LICENSE` is still a placeholder.

## Risks

- **Open time.** The whole store is decrypted at open, and the 40 MB base directory already costs plain `idb://` 0.4 to 1.2 s here. Only 64 KB blocks reach 1.5 s at 100 MB, and only on a quiet desktop engine. Phones are unmeasured; the 3 s phone budget is a guess until #4 or #11.
- **Gate definitions.** G2 at 10 MB and G3 as written fail for plain PGlite too, so they do not measure encryption. If they stay, nothing can pass.
- **Noise.** The host is shared with other jobs; two Chromium runs of the same build differed by up to 2x on G2. Only the ratios against plain are reliable.
- **Unpushed work.** The whole spike exists in one local branch. A disk or worktree cleanup before the owner decides loses it.
- **Strict G9 reading.** One of the 20 one-row updates grew a file and wrote a table block. It passes under the owner's restated STOP 5 (no sync without a file change wrote one), not under the literal gate text.
- **Layout.** Appends still write about one table block on about two of three commits (63 % of write commits over the trace workload). Accepted by the owner; the prototype bounds it at one block per growing file.
- **Durability.** PGlite's #1065, #1191 and #1063 are confirmed on 0.5.10; `pg.close()` does not sync, so #8 must sync in `closeFs`.
- **Critical path.** One owner decision gates seven issues (#3, #5, #7, #8, #9, #10, #11).
- **Unreviewed code.** No external review; the tracker has one automated review.
