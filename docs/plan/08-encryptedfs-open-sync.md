<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-08).
Title: The EncryptedFs filesystem (open, sync, close) on format v1
Labels: agent-ready, security
Origin: the core of 2002Bishwajeet/journal#553. (That Journal issue is rewritten as the submodule integration, journal/01.)
Resolves review findings: B2 (package half), S1 (load check), S5, S6, S7, S8. Handles upstream PGlite sync bugs #1065, #1191, #1063.
-->
## Context
PGlite (Postgres in WebAssembly) persists to IndexedDB in plain text through its `idb://` filesystem, which is Emscripten IDBFS: the data directory lives in memory (MEMFS) and changed files are written whole on each sync.

`pglite-cipher` encrypts below Postgres, the way SQLCipher does below SQLite, with no change to the engine:

```ts
import { EncryptedFs, IndexedDbBackend, importKek } from "pglite-cipher";
const fs = new EncryptedFs({ backend: new IndexedDbBackend("my-db"), key: await importKek(raw32), mode: "open-or-create" });
const pg = new PGlite({ fs });
```

The pieces exist: the byte format and crypto (#<PC-05>, `FORMAT.md`), the dirty-block tracker (#<PC-06>), the storage backends with atomic commits and fault injection (#<PC-07>). This issue joins them into the `Filesystem` that PGlite calls. Why this design and how it compares to SQLCipher: `docs/plan/01-sqlcipher-comparison.md`; the short version goes into the README in this issue.

Facts about PGlite 0.5.10 that this relies on (verified in `node_modules/@electric-sql/pglite/dist`):
- The interface is `init`, `initialSyncFs`, `syncToFs(relaxedDurability?)`, `closeFs`, `dumpTar`. `EmscriptenBuiltinFilesystem` is exported from `@electric-sql/pglite/basefs`; `MemoryFS` from the main entry.
- After `initialSyncFs`, PGlite runs **initdb when `PG_VERSION` is missing**. A load that returns normally on a damaged store would therefore create a new empty database over the user's data.
- Under `relaxedDurability`, PGlite does **not** await `syncToFs`, so queries run and change MEMFS while a sync is in flight. A sync is called after every query.
- `execProtocolRawSync` is synchronous, so the state between two engine calls is a crash-consistent image, like a `kill -9` with the page cache intact.
- **Three upstream sync bugs sit on this boundary** (see `docs/research/2026-11-10-prior-art.md` 2.1). `PGlite.syncToFs()` returns at once, without syncing, when a sync is already queued (electric-sql/pglite#1191, open; visible in 0.5.10 as `if (this.#syncQueued) return`). `transaction()` can commit without a following `syncToFs()` (#1065; fix PR #1205 still open). A failed background sync under `relaxedDurability` was an unhandled rejection after which nothing persisted (#1063). **So this filesystem never assumes PGlite will call it at the right time:** dirty state lives in the tracker until a sync really commits it, a failed sync is retried by the next one, and the filesystem offers its own `hasDirty()` and `syncToFs()` for the host to call directly, as Journal's worker does for its flush when the page is hidden.

## Change
`src/encryptedFs.ts`, exported as `EncryptedFs`; tests in `test/fs/`.

0. **Self-test first.** `init` awaits `selfTest()` (#<PC-05>) once per process and fails with `CryptoSelfTestError` before anything is read or written.
1. **Construction:** `new EncryptedFs({ backend, key, mode, blockSize? })`. `key` is a `CryptoKey` with `wrapKey`/`unwrapKey` usages (see `importKek`). `mode` is `"open"`, `"create"` or `"open-or-create"`. `blockSize` applies only when creating; default from #<PC-04>.
2. **`init`:** extend `MemoryFS`. Add a `preRun` hook that installs the tracker on PGDATA. Nothing is read here.
3. **`initialSyncFs`: the open state machine.** Sync stays **disabled** (`syncToFs` rejects with a clear error) until this returns successfully.

   | Store state | `open` | `create` | `open-or-create` |
   |---|---|---|---|
   | `backend.isEmpty()` | throw `StoreMissingError` | create | create |
   | Has a valid static header, DEK unwraps, mutable header opens, `state: "ready"` | load | throw `StoreExistsError` | load |
   | Static header valid, DEK does not unwrap | `WrongKeyError` | `StoreExistsError` | `WrongKeyError` |
   | Records exist but no static header copy parses, or the mutable header is missing or `state` is `"populating"` | `IncompleteStoreError` | `IncompleteStoreError` | `IncompleteStoreError` |
   | `state: "rotating"` | `IncompleteStoreError` with `rotation: true` (handled by #<PC-09>) | same | same |
   | Anything else | `CorruptStoreError` | `CorruptStoreError` | `CorruptStoreError` |

   Never treat a non-empty store as empty. Never write during a failed open.
   - **Create:** make `storeId`, the DEK and both header copies in memory only, and leave MEMFS empty so PGlite runs initdb. The tracker sees every file initdb creates, so the first `syncToFs` commits them together with both header copies and the first mutable header, with `expectMutable: null`. Until that commit the backend stays empty.
   - **Load:** read inodes with `readRange("i", …)` in pages of 512, open them, build the directory tree in MEMFS and **preallocate each file's buffer from the inode's size**. Read blocks with `readRange("b", …)` in pages of 512, open them with at most 64 decrypts in flight, copy each plaintext into its file at `index * blockSize` (cut to the file's size) and drop the page before reading the next, so peak memory is the database plus one page (review S5). While reading, collect each record's tag. A block whose `fileId` has no inode, an index at or beyond the inode's block count, or a missing index below it, is `CorruptStoreError`. Finally compute the manifest digest and compare it, and `fileCount`, with the mutable header: a difference is `CorruptStoreError` (this is what detects a deleted file or a replayed record, review S1). Then `tracker.loadState(…)`.
   - On any error, unmount what was built so far: no half-loaded directory is left for PGlite to find.
   - Report progress through an optional `onProgress({ phase, done, total })` callback (the app's splash uses it).
4. **`syncToFs(relaxedDurability)`:** serialised (one at a time; a call during a sync waits and then runs once more if anything is dirty).
   1. `snap = tracker.snapshot()`: synchronous. If it is empty and no header repair is pending, return.
   2. Encrypt outside any transaction: every block and inode of the snapshot (bounded concurrency) under the session subkey, counting attempts in `encryptions`. Update the in-memory tag table. Compute the new manifest. Seal a new mutable header with `gen + 1`.
   3. One `backend.commit({ expectMutable: <the mutable header bytes this instance last read or wrote>, puts, deletes, deleteRanges, durability })`. `durability` is `"strict"` when `relaxedDurability === false`, else `"relaxed"` (review S8). If a header repair is pending, the batch also rewrites both static header copies.
   4. On success: `tracker.commit(snap)`, remember the new mutable header bytes.
   5. On failure: restore the tag table to before step 2 (`encryptions` keeps counting attempts), `tracker.requeue(snap)`, rethrow. On `StaleWriterError` additionally disable further syncs on this instance (another instance has written a newer store; this one must not overwrite it, review S6) and surface the error through an `onFatal` callback.
5. **`closeFs`:** wait for a running sync, run a final strict `syncToFs(false)` if anything is dirty and syncs are enabled, then close the backend. Never close the backend under a running sync (#1063). Do not swallow the sync's error.
   **`hasDirty()`:** true when the tracker holds anything unsynced. Hosts use it for a flush on hide and for an idle flush.
6. **`dumpTar`:** inherited; it reads plaintext MEMFS. The README says: exports are plaintext by design.
7. **`stats()`:** `{ gen, encryptions, subkeys, files, blocks, trackingGaps, lastSync: { blocks, inodes, bytes, encryptMs, commitMs } }`, for benchmarks and the app's diagnostics.
8. **README:** replace the design-stage text with: what it protects and what it does not (from `docs/plan/01-sqlcipher-comparison.md` section 2: file count, sizes to the block, write timing; whole-store rollback not detected; memory is plaintext), the usage example, the open modes, the errors and what an app should do on each, "keep temp storage inside the data directory", "exports are plaintext".

### Tests (`test/fs/*.test.ts`): real PGlite; `MemoryBackend` and `IndexedDbBackend`; in Node on `fake-indexeddb` and, through `npm run test:browser`, on the real IndexedDB of Chromium, Firefox and WebKit
- **Round trip:** create, run a schema with `pg_trgm` and `live`, insert, close; reopen with `mode: "open"`: all rows present, a trigram query works, a live query fires.
- **No plaintext:** insert a marker string in a row, a table name and a column name; after sync, no stored value and no record key contains the marker in UTF-8 or UTF-16.
- **Wrong key:** `WrongKeyError`, and the backend's contents are byte-identical before and after.
- **Never initdb over data:** for each of: delete both static headers; delete `["m"]`; set `state: "populating"`; truncate a header value. Open throws the documented error, the backend is unchanged, and `PG_VERSION` was never created in MEMFS.
- **Tamper:** flip a bit in a block; swap two blocks of one file; move a block to another file; delete one block; delete an inode and all its blocks (a whole file); replace a block with its own older valid value (keep a copy from an earlier sync); replace an inode with its older value; add an extra block. Each gives `CorruptStoreError` at open.
- **Whole-store rollback is not detected** (a test that documents it: restore a full earlier copy, open succeeds with the older data).
- **Crash injection, with `FaultyBackend`:** drive a write workload of 200 small transactions. For every sync number K: (a) fail commit K before writing → the instance keeps working, and after the next successful sync a reopen has all data; (b) commit K applies but reports failure → same; (c) drop the instance at commit K and open a fresh one on the state after K-1 commits, and on the state after K commits → both open, Postgres recovers, every transaction that was acknowledged before the last durable sync is present, no error. Run (c) for every K, not a sample.
- **Worker killed mid-sync (browser only):** run the filesystem in a real Web Worker, `terminate()` it at a random moment during a write workload, open the store in a new worker: it opens, Postgres recovers, and the data equals some acknowledged prefix. 50 repetitions per browser. (Evolu found a real rollback bug in SQLite's OPFS VFS with exactly this test.)
- **Sync during writes:** with `relaxedDurability`, start a sync, make the backend's commit slow, run more queries meanwhile, let it finish, reopen from the store as of that commit: it opens and holds a consistent earlier state. Then the next sync carries the rest.
- **Stale writer:** open instance A and B on one backend; A syncs; B's next sync rejects with `StaleWriterError`, B's later syncs are disabled, the store still opens with A's data.
- **Header repair:** damage copy 0; open succeeds; after the next sync both copies are valid.
- **Memory shape:** with a counting backend, a load never holds more than one page of ciphertext (assert the maximum number of un-dropped page buffers is 1).
- **All three block sizes** run the round-trip, tamper and crash tests.
- **Upstream-bug regressions:** (#1191) call `fs.syncToFs()` twice in a row while the first is in flight: both promises resolve only after everything dirty at the time of the second call is committed. (#1065) run `pg.transaction(...)`, then, without any further query, call `fs.hasDirty()`: if it is true, `fs.syncToFs()` persists the transaction and a reopen has its rows. (#1063) make one background sync fail: no unhandled rejection, and the next sync persists everything.
- **Frozen reference store:** commit `test/fixtures/v1-reference/` (a small store written by this code with a published test key, as SQLCipher 5 ships `sqlcipher-5.0-testkey.db`) and a test that opens it and checks a known row. Every later version must keep opening it.
- **Ported scenarios:** port the CRUD/reopen/large-row/index cases and the failure cases (wrong key, tampered page, truncated file, missing header) from davidmuggleton/pglite-encrypted-fs `test/integration/pglite-basic.test.ts` and `pglite-failure.test.ts` (MIT; keep its licence notice in a `THIRD_PARTY.md`). Adapt them to this API; do not port its filesystem code.
- **Strict/relaxed:** `syncToFs(false)` commits with `"strict"`, `syncToFs(true)` with `"relaxed"`, `closeFs` with `"strict"`.

## Acceptance criteria
- [ ] A PGlite instance on `EncryptedFs` survives close and reopen with all data; `pg_trgm` and `live` work.
- [ ] No stored value or key contains plain text.
- [ ] A wrong key, a missing header and an interrupted population each throw their own error, change nothing, and never lead to initdb.
- [ ] Modified, swapped, moved, deleted, added and replayed records, and a deleted file, are detected at open.
- [ ] A crash at any sync leaves a store that opens to a consistent state.
- [ ] A second writer cannot overwrite a newer store.

## Verification
- `~/.claude/bin/heavy npm test` passes everything above plus the earlier suites.
- `~/.claude/bin/heavy npm run test:browser -- test/fs` passes in Chromium, Firefox and WebKit: at least the round trip, no-plaintext, wrong-key, never-initdb, tamper and stale-writer tests, and the crash matrix for every tenth K.
- `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0.
- The PR description has the acceptance list ticked with the test name that proves each line, and the `stats()` output of the 200-transaction workload (blocks and bytes per sync).

## Out of scope
- Key change, data-key rotation, `verify()`: #<PC-09>.
- Importing a plain-text database: #<PC-10>.
- Benchmarks and CI gates: #<PC-11>.
- Using it in Journal: 2002Bishwajeet/journal#1017.
- A Rust file backend.
- Publishing to npm and making the repository public (owner).

## STOP and comment on the issue if
- PGlite calls `syncToFs` or reads PGDATA before `initialSyncFs` has finished, or runs initdb in a way the open state machine cannot prevent.
- The crash-injection test (c) finds a K where the reopened database is not consistent. Paste K, the batch contents by record kind and count, and the Postgres error. Do not weaken the test.
- A load cannot be made to hold only one page (the backend or MEMFS forces a full copy).
- You need to change the format of #<PC-05>. Propose the change on that issue first.

## Metadata
Depends on: #<PC-05>, #<PC-06>, #<PC-07>
Size: L
Area: db, security
Model: opus
Effort: xhigh
