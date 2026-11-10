<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-11).
Title: Benchmark gates in CI, long fuzz/crash/soak runs, ported third-party scenarios, SECURITY.md, release checklist
Labels: agent-ready, security
Origin: 2002Bishwajeet/journal#553 ("Benchmark" and its 2× acceptance line). Carries review S5's gates into CI and the test approaches of docs/research/2026-11-10-prior-art.md section 3.
-->
## Context
The unit, property and crash tests run on every PR with small budgets so that `npm test` stays fast. Three things are still missing before anyone should trust this with their notes:

1. **Performance gates that fail a build.** The spike (#<PC-03>) measured a prototype once. The real implementation must keep meeting the gates the owner approved in #<PC-04> (the `Open budget` line), and a later change must not quietly make open or sync slower.
2. **Long runs** of the fuzz, property and crash-injection suites, which are too slow for every PR, and scenarios other projects already wrote.
3. **The security documentation** a cryptographic library needs: what it claims, what it does not, how to report a problem.

Gate definitions (`docs/plan/01-sqlcipher-comparison.md` 3.3): **G1** sync after a one-row update on a 100 MB database, encrypted p50 ≤ 2× plain `idb://`; **G2** open, ≤ 2× plain and within the absolute budget; **G3** peak memory at open ≤ database + 64 MB; **G4** WAL segment switch ≤ 500 ms on desktop; **G8** subkey derivation ≤ 10 % of the open budget; **G9** the file-table indirection of the packed block space: at open, the time from the first read to a complete file map (root, table blocks fetched, opened and assembled) ≤ 5 % of the open budget; and the sync after a one-row update writes no file-table block.

## Change
1. **Benchmark page on the real implementation.** Switch `bench/bench.ts` from the prototype to `EncryptedFs` + `IndexedDbBackend`, keep the plain `IdbFs` baseline, the JSON output, the G7 rows and the Tauri run sheet. Add rows for `changeKey`, `rotateDataKey`, `verify()` and (if it exists) `importPlainDataDir` at 10 and 100 MB, and the `stats().lastSync` breakdown. Add the **G9 rows** from `stats()`: `lastOpen.tableMs` beside `lastOpen.blocksMs` and the whole open; the number of table blocks and `table.fill`; over the whole workload, the median and the 95th percentile of `lastSync.tableBlocks` and of `lastSync.tableBlocks / lastSync.dataBlocks`, and how many syncs repacked the table; and the open time of the same data after a rotation (a densely packed table) beside the open time before it. Delete `spike/` except `RESULTS.md`, which moves to `bench/SPIKE-RESULTS.md`.
2. **Perf test on every PR.** `test/perf/gates.browser.test.ts` (Chromium only, in the `test:browser` run): G1, G2 and G4 at **10 MB** (100 MB is too slow for every PR), asserted as **ratios against the plain baseline measured in the same run** (machine-independent): G1 ≤ 2×, G2 ≤ 2×, G4 ≤ 10× a normal sync. **G9** as a ratio and a count, both machine-independent: `lastOpen.tableMs` ≤ 5 % of the encrypted open time of the same run, and the G1 sync reports `lastSync.tableBlocks === 0`. It prints the JSON. No absolute milliseconds here: CI runners vary.
3. **Nightly job.** `.github/workflows/nightly.yml` (schedule + `workflow_dispatch`): (a) the bench at 100 MB in Chromium, Firefox and WebKit with the **absolute** budgets from #<PC-04> relaxed by a documented CI factor (state the factor and why in the workflow), failing the job when exceeded; (b) the long suites of step 4; (c) the same suites against the newest published `@electric-sql/pglite` (allowed to fail; it is an early warning for upgrades); (d) uploads the JSON as an artifact and prints the gate table in the job summary.
4. **Long suites.** `CIPHER_LONG=1` (the `test:long` script) raises budgets: fast-check runs ×25, decoder fuzz to 1,000,000 cases, the 200-transaction crash matrix to 2,000 transactions, the rotation and import crash matrices at every commit index for a 100 MB store, the worker-kill test to 500 repetitions per browser. Without the switch nothing changes. Add `test/soak.test.ts` (only under `CIPHER_LONG=1`): 30 minutes of a random workload (inserts, updates, deletes, `VACUUM`, checkpoints, random syncs, random close and reopen, random injected commit failures) with a full table checksum compared against a shadow PGlite on `MemoryFS` after every reopen, and `trackingGaps === 0` throughout. After every reopen it also checks the packed layout: `count()` equals `3 + table blocks + data blocks` (no orphan record), and `stats().table.blocks` is at most twice what `packEntries` needs for the same files, plus 4.
5. **Ported scenarios** from davidmuggleton/pglite-encrypted-fs (MIT; the only other encrypted PGlite filesystem, Node-only): its `test/integration/pglite-pgvector.test.ts` (an extension with its own access method over the encrypted filesystem; PGlite ships `vector`), whatever of `pglite-basic.test.ts` and `pglite-failure.test.ts` #<PC-08> did not already port, and the shape of its `bench/` (crypto overhead, startup, operations) as extra rows. Record the source and licence in `THIRD_PARTY.md`.
6. **Compatibility lock.** A test that opens the frozen reference store (`test/fixtures/v1-reference/`, from #<PC-08>) in Node and in each browser, and a second fixture written **by WebKit** and opened by Chromium and Node (and the reverse), generated in CI by one browser job and consumed by the others through an artifact. Two engines that each read only their own stores is the failure this catches.
7. **`SECURITY.md`:** the threat model (what an attacker with the files learns, in the words of `FORMAT.md`'s observer paragraph: that a database exists, the total number of equal-size blocks, which records change between two copies and which were last written in one session; and what they do not learn: the format, the number of files, any file's size, which block belongs to what; what they cannot do; whole-store rollback not detected; memory is plain text; no passphrase KDF; not FIPS validated; not externally audited as of this date), the primitives and where each is used (one table, pointing at `FORMAT.md`), session subkeys and why no rotation is forced, and how to report a vulnerability. Copy no marketing words: `docs/plan/01-sqlcipher-comparison.md` section 4 lists the words not to use.
8. **README: "Compared to SQLCipher"**: a short table from `docs/plan/01-sqlcipher-comparison.md` section 2 (cipher, unit, nonce and subkey, header, what the stored bytes show, what the tag binds, what is detected, rekey, memory, open cost), with the weaker rows included.
9. **`RELEASE-CHECKLIST.md`** for the owner: nightly green for 7 days; bench JSON from macOS, iOS, Windows, Android attached to #<PC-04> or the Journal checklist issue; `FORMAT.md` vectors reproduced by the independent decoder; the frozen fixtures open; version `0.1.0` and a tag for Journal to pin; the README's limits read once more.

## Verification
- `~/.claude/bin/heavy npm run test:browser -- test/perf` passes in Chromium and prints the JSON.
- `CIPHER_LONG=1 ~/.claude/bin/heavy npm test` passes locally once (paste the duration and the fast-check seed in the PR); the soak test may be shortened to 5 minutes for this local run with `CIPHER_SOAK_MINUTES=5`, and the PR says so.
- `~/.claude/bin/heavy npm test`, `~/.claude/bin/heavy npm run test:browser`, `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0, one at a time; `npm test` is not measurably slower than before this PR (state both durations).
- `~/.claude/bin/heavy npm run bench:build` produces the bench page on the real implementation.
- A `workflow_dispatch` run of the nightly workflow is linked in the PR (or the PR says the owner must trigger the first run).
- `SECURITY.md`, the README comparison, `THIRD_PARTY.md` and `RELEASE-CHECKLIST.md` exist. None of them contains "military", "audited", "FIPS-compliant", "unbreakable" or "zero-knowledge".

## STOP and comment on the issue if
- G1 or G2 fails as a ratio in Chromium on the real implementation. Paste the JSON. Do not loosen the ratio; the owner decides.
- The soak test finds a checksum mismatch or a tracking gap. Paste the seed and the operation log tail.
- A store written by one browser does not open in another. Paste which pair and the error: that is a format bug, not a test problem.
- The perf test is flaky (fails more than once in 10 local runs) at the stated ratios. Report the spread instead of widening the gate.
- G9 fails: the file-table phase takes more than 5 % of the open, or the one-row-update sync writes a table block, or the soak ends with a table more than twice its dense size. Paste the numbers. The remedies (another repack rule, a second table level, another way to place entries) are format decisions; do not pick one here.

## Metadata
Depends on: #<PC-09>
Size: M
Area: bench, ci, security
Model: opus
Effort: high
