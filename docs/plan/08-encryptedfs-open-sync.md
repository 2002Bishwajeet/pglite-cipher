<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-08).
Title: The EncryptedFs filesystem (open, sync, close) on format v1
Labels: agent-ready, security
Origin: the core of 2002Bishwajeet/journal#553. (That Journal issue is rewritten as the submodule integration, journal/01.)
Resolves review findings: B2 (package half), S1 (load check), S5, S6, S7, S8. Handles upstream PGlite sync bugs #1065, #1191, #1063. Owns the in-memory file map of the packed block space (owner decision 2026-11-10; format in plan file 05).
-->
## Context
PGlite (Postgres in WebAssembly) persists to IndexedDB in plain text through its `idb://` filesystem, which is Emscripten IDBFS: the data directory lives in memory (MEMFS) and changed files are written whole on each sync.

`pglite-cipher` encrypts below Postgres, the way SQLCipher does below SQLite, with no change to the engine:

```ts
import { EncryptedFs, IndexedDbBackend, importKek } from "pglite-cipher";
const fs = new EncryptedFs({ backend: new IndexedDbBackend("data"), key: await importKek(raw32), mode: "open-or-create" });
const pg = new PGlite({ fs });
```

The pieces exist: the byte format and crypto (#<PC-05>, `FORMAT.md`), the dirty-block tracker (#<PC-06>), the storage backends with atomic commits and fault injection (#<PC-07>). This issue joins them into the `Filesystem` that PGlite calls.

The store is a **packed block space** (`FORMAT.md`): two header copies, one root, and equal-size blocks under random ids. Some blocks hold file data and some hold the encrypted file table; the stored bytes do not say which. The tracker speaks of files and block indexes, the backend of opaque ids. This issue owns what lies between: the **file map**, an in-memory copy of the file table (`fileId` → path, type, mode, size, target and the ordered ids of its blocks; and block id → file and index), together with the table blocks it is packed into and the tag of every stored record.

Why this design and how it compares to SQLCipher: `docs/plan/01-sqlcipher-comparison.md`; the short version goes into the README in this issue.

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
   | A header copy opens under the key (`openHeader`, #<PC-05>), the version is supported, the root opens, `state: "ready"` | load | throw `StoreExistsError` | load |
   | A header copy opens, and its version, cipher or subkey scheme is unknown | `UnsupportedFormatError` | `UnsupportedFormatError` | `UnsupportedFormatError` |
   | Both header copies are present and identical, and neither unwraps | `WrongKeyError` | `StoreExistsError` | `WrongKeyError` |
   | Records exist but both header copies are missing; or a header opens and the root (slot 2) is missing or its `state` is `"populating"` | `IncompleteStoreError` | `IncompleteStoreError` | `IncompleteStoreError` |
   | `state: "rotating"` | `IncompleteStoreError` with `rotation: true` (handled by #<PC-09>) | same | same |
   | Anything else (the header copies differ and neither opens, a header of the wrong length, a root that does not open, …) | `CorruptStoreError` | `CorruptStoreError` | `CorruptStoreError` |

   Never treat a non-empty store as empty. Never write during a failed open. The header is opaque, so "is this one of ours" has no answer without the key: a store that does not unwrap is a wrong key or a damaged header, and the two copies are what tell them apart (#<PC-05>, rule 5).
   - **Create:** make `storeId`, the DEK and the header in memory only (`createHeader`), start with an empty file map, and leave MEMFS empty so PGlite runs initdb. The tracker sees every file initdb creates, so the first `syncToFs` commits them together with both header copies, a densely packed file table (`packEntries`) and the first root, with `expectRoot: null`. Until that commit the backend stays empty.
   - **Load**, in three phases:
     1. **Header and root.** `get(0)`, `get(1)`, `get(2)`; `openHeader`; `openRoot`.
     2. **File table.** `getMany` the table block ids the root lists (pages of 512). A missing one is `CorruptStoreError`. Open each (its AAD names its id), collect the tags and compare `tableDigest`: a difference is `CorruptStoreError`, **and nothing has been built yet**, so a replayed or reordered file table never reaches MEMFS. Then `assembleFiles` (#<PC-05>) gives the file map and the id → (file, index) index and checks `fileCount` and `dataBlocks`. Build the directory tree in MEMFS and **preallocate each file's buffer from its size**.
     3. **Blocks.** `readRange` in pages of 512 over every block. The order is the order of random ids, so consecutive records belong to unrelated files. For each record: the id of a table block is skipped (phase 2 has it); an id in the index is opened with that file and index as AAD, at most 64 decrypts in flight, and its plaintext copied into the file at `index * blockSize` (cut to the file's size); **an id the index does not know is `CorruptStoreError`** (an added record). Drop the page before reading the next, so peak memory is the database, one page and the file map (review S5). While reading, collect each record's tag. At the end, the number of data blocks read must equal `dataBlocks` (a smaller number is a deleted block), and the manifest computed from the tags must equal the root's: a difference is `CorruptStoreError` (this is what detects a replayed block, review S1). Then `tracker.loadState(…)`.
   - Files get the time of the load as their modification time; the format stores none (#<PC-05>, rule 10).
   - On any error, unmount what was built so far: no half-loaded directory is left for PGlite to find.
   - Report progress through an optional `onProgress({ phase, done, total })` callback (the app's splash uses it).
4. **`syncToFs(relaxedDurability)`:** serialised (one at a time; a call during a sync waits and then runs once more if anything is dirty).
   1. If an earlier commit is unsettled (step 6), settle it first. Then `snap = tracker.snapshot()`: synchronous. If it is empty and no header repair is pending, return.
   2. **Plan**, without changing the file map or the tag table yet. Translate the snapshot into records:
      - a dirty block of an index the file already has → a put under **the id it already has** (an overwrite); of a new index → a put under a fresh id (`newBlockId`, drawn again if it equals a live id);
      - a file in the snapshot whose path, type, mode, size or target differs from its entry in the map, a new file, a block list that grew or shrank → changed table entries, and from them the table blocks to rewrite (placement below). A file whose blocks changed and nothing else has **no** changed entry: the snapshot's `mtime` is ignored;
      - the tracker's delete ranges and dead files → the ids of those indexes, looked up in the map, as `deletes`; a table block left empty → a delete.

      Encrypt outside any transaction (bounded concurrency) every data block and every changed table block under the session subkey, counting attempts in `encryptions`. Compute `tableDigest` (only if a table block changed) and the manifest from the tags as they will be. Seal a new root with `gen + 1` and the new list of table block ids.
   3. One `backend.commit({ expectRoot: <the root bytes this instance last read or wrote>, puts, deletes, durability })`. Data blocks, table blocks and the root are in the same batch, so **the file table can never be newer or older than the blocks it describes**. `durability` is `"strict"` when `relaxedDurability === false`, else `"relaxed"` (review S8). If a header repair is pending, the batch also rewrites both header copies.
   4. On success: apply the plan to the file map and the tag table, `tracker.commit(snap)`, remember the new root bytes.
   5. On `StaleWriterError`: drop the plan, `tracker.requeue(snap)`, disable further syncs on this instance (another instance has written a newer store; this one must not overwrite it, review S6) and surface the error through an `onFatal` callback.
   6. On any other rejection, **find out what the store holds before deciding anything**: `get(2)`.
      - It equals the root of this plan: the commit did apply and only its report was lost. Continue with step 4; the sync succeeded.
      - It equals the previous root: nothing was written. Drop the plan (the ids it drew were never stored; `encryptions` keeps counting attempts), `tracker.requeue(snap)`, rethrow.
      - Anything else: treat as `StaleWriterError` (step 5).
      - The read itself fails: keep the plan and the snapshot as *unsettled* and rethrow. `hasDirty()` is true while unsettled, and the next `syncToFs` (and `closeFs`) settles first, by the same read, before it takes a new snapshot.

      This step exists because of the packed layout. With one group of records per file, a writer that wrongly believed a commit had failed wrote the same keys again and no harm was done. Here it would forget ids that are in the store, and the next open would find records the file table does not list and refuse the store.
   - **Placing table entries.** A changed entry stays in its table block when it still fits. Otherwise it moves to the first table block, in the root's list order, with room for it, and failing that to a new table block (a fresh id, appended to the list). A file's first run goes into the table block of its file entry when it fits. A run that holds `maxRunIds(blockSize)` ids is closed and the next index starts a new run. A table block left without entries is deleted.
   - **Repacking the table.** Removed files leave holes that later entries may not fill. If, after placement, less than half of the table blocks' bytes hold entries and the table has more than 4 blocks, the plan replaces the whole table with `packEntries` of the map as it will be: puts for the new table blocks under fresh ids, deletes for all the old ones, in the same commit. This is the only compaction in the format. It rewrites table blocks only (every data block keeps its id), it needs no state of its own, and it keeps the table at no more than twice its dense size. After a repack the table is full, so the next one is at least half a table of removals away. `StoreFullError` (#<PC-05>, rule 11) is thrown in step 2, before the commit.
5. **`closeFs`:** wait for a running sync, run a final strict `syncToFs(false)` if anything is dirty and syncs are enabled, then close the backend. Never close the backend under a running sync (#1063). Do not swallow the sync's error.
   **`hasDirty()`:** true when the tracker holds anything unsynced. Hosts use it for a flush on hide and for an idle flush.
6. **`dumpTar`:** inherited; it reads plaintext MEMFS. The README says: exports are plaintext by design.
7. **`stats()`:** `{ gen, encryptions, subkeys, files, dataBlocks, table: { blocks, fill }, trackingGaps, lastSync: { dataBlocks, tableBlocks, deletes, repacked, bytes, encryptMs, commitMs }, lastOpen: { tableMs, blocksMs } }`, for benchmarks and the app's diagnostics. `table.fill` is the share of table-block bytes that hold entries. The package logs none of it: it describes what the store hides.
8. **README:** replace the design-stage text with: what it protects and what it does not (from `docs/plan/01-sqlcipher-comparison.md` section 2: someone with the files sees that a database exists, the total number of blocks and when they are written, and nothing about files; whole-store rollback not detected; memory is plaintext), "give the database a name that says nothing", the usage example, the open modes, the errors and what an app should do on each (`UnsupportedFormatError` means a newer version wrote the store: update the app, never reset), "keep temp storage inside the data directory", "exports are plaintext".

### Tests (`test/fs/*.test.ts`): real PGlite; `MemoryBackend` and `IndexedDbBackend`; in Node on `fake-indexeddb` and, through `npm run test:browser`, on the real IndexedDB of Chromium, Firefox and WebKit
- **Round trip:** create, run a schema with `pg_trgm` and `live`, insert, close; reopen with `mode: "open"`: all rows present, a trigram query works, a live query fires.
- **No plaintext:** insert a marker string in a row, a table name and a column name; after sync, no stored value and no record key contains the marker in UTF-8 or UTF-16, nor any path under PGDATA, nor any of the strings `pglite`, `cipher`, `PGLCIPHR`, `PG_VERSION`.
- **Nothing but blocks:** after the 200-transaction workload, read the backend without a key: the keys are `0`, `1`, `2` and 32-character hex strings; slots 0 and 1 are 168 bytes; every other value has the length `44 + blockSize`; `count()` equals `3 + stats().table.blocks + stats().dataBlocks`. Two stores created from the same SQL script share no block id.
- **The packed layout does what it is for:** a one-row `UPDATE` followed by a sync leaves the set of block ids unchanged and reports `lastSync.tableBlocks === 0` and `lastSync.deletes === 0`; an insert that extends a relation adds ids and writes at least one table block; renaming a 16 MB file writes table blocks and zero data blocks; `DROP TABLE` followed by a checkpoint and a sync removes the dropped files' ids from the store and lowers `count()`; a truncate removes exactly the ids of the cut indexes.
- **Wrong key:** `WrongKeyError`, and the backend's contents are byte-identical before and after.
- **Never initdb over data:** for each of: delete both header copies; delete slot 2; set `state: "populating"`; truncate a header value; overwrite the two header copies with different random bytes. Open throws the documented error, the backend is unchanged, and `PG_VERSION` was never created in MEMFS.
- **Tamper:** flip a bit in a block; exchange the values under two ids of one file; exchange the values under two ids of different files; exchange two table blocks; delete one data block; delete one table block; delete every block of one file; replace a data block with its own older valid value (keep a copy from an earlier sync); replace a table block with its older value; replace the root with its older value; add an extra record under a new random id. Each gives `CorruptStoreError` at open. For the table-block cases, also assert that no file was created in MEMFS before the error.
- **Newer format:** a store whose header meta says `v = 2` (test helper) gives `UnsupportedFormatError` in every mode, and the backend is unchanged.
- **Whole-store rollback is not detected** (a test that documents it: restore a full earlier copy, open succeeds with the older data).
- **Crash injection, with `FaultyBackend`:** drive a write workload of 200 small transactions, with a `CREATE TABLE`, growth, a `VACUUM` that truncates and a `DROP TABLE` among them, so that the file table changes. For every sync number K: (a) fail commit K before writing → the instance keeps working, and after the next successful sync a reopen has all data; (b) commit K applies but reports failure → the instance reads the root, finds its own, counts the sync as done and keeps working, and a reopen has all data; (b′) as (b), and the `get(2)` that follows fails too → the sync rejects, the next one settles first and then succeeds; (c) drop the instance at commit K and open a fresh one on the state after K-1 commits, and on the state after K commits → both open, Postgres recovers, every transaction that was acknowledged before the last durable sync is present, no error. Run (c) for every K, not a sample. **After every reopen in (a), (b), (b′) and (c), `count()` equals `3 + table blocks + data blocks`: no record without an owner, no owner without a record.**
- **Worker killed mid-sync (browser only):** run the filesystem in a real Web Worker, `terminate()` it at a random moment during a write workload, open the store in a new worker: it opens, Postgres recovers, and the data equals some acknowledged prefix. 50 repetitions per browser. (Evolu found a real rollback bug in SQLite's OPFS VFS with exactly this test.)
- **Sync during writes:** with `relaxedDurability`, start a sync, make the backend's commit slow, run more queries meanwhile, let it finish, reopen from the store as of that commit: it opens and holds a consistent earlier state. Then the next sync carries the rest.
- **Stale writer:** open instance A and B on one backend; A syncs; B's next sync rejects with `StaleWriterError`, B's later syncs are disabled, the store still opens with A's data and holds no record that B drew an id for.
- **Header repair:** damage copy 0; open succeeds; after the next sync both copies are valid.
- **Memory shape:** with a counting backend, a load never holds more than one page of ciphertext (assert the maximum number of un-dropped page buffers is 1), in the table phase and in the block phase.
- **File-table packing:** after 2,000 random creates, grows, truncates, renames and unlinks, the incrementally packed table assembles to the same files as MEMFS, a reopen equals MEMFS byte for byte, and `stats().table.blocks` is at most twice the number `packEntries` needs for the same files, plus 4. A run of removals that takes the table under half full triggers exactly one repack, and a crash at that commit (`FaultyBackend`, all modes) leaves either the old table or the new one, never a mix.
- **All three block sizes** run the round-trip, tamper and crash tests.
- **Upstream-bug regressions:** (#1191) call `fs.syncToFs()` twice in a row while the first is in flight: both promises resolve only after everything dirty at the time of the second call is committed. (#1065) run `pg.transaction(...)`, then, without any further query, call `fs.hasDirty()`: if it is true, `fs.syncToFs()` persists the transaction and a reopen has its rows. (#1063) make one background sync fail: no unhandled rejection, and the next sync persists everything.
- **Frozen reference store:** commit `test/fixtures/v1-reference/` (a small store written by this code with a published test key, as SQLCipher 5 ships `sqlcipher-5.0-testkey.db`) and a test that opens it and checks a known row. Every later version must keep opening it.
- **Ported scenarios:** port the CRUD/reopen/large-row/index cases and the failure cases (wrong key, tampered page, truncated file, missing header) from davidmuggleton/pglite-encrypted-fs `test/integration/pglite-basic.test.ts` and `pglite-failure.test.ts` (MIT; keep its licence notice in a `THIRD_PARTY.md`). Adapt them to this API; do not port its filesystem code.
- **Strict/relaxed:** `syncToFs(false)` commits with `"strict"`, `syncToFs(true)` with `"relaxed"`, `closeFs` with `"strict"`.

## Acceptance criteria
- [ ] A PGlite instance on `EncryptedFs` survives close and reopen with all data; `pg_trgm` and `live` work.
- [ ] No stored value or key contains plain text, a path, or a byte that names the format.
- [ ] The store shows equal-size blocks under random ids: no file count, no file sizes, no link between a block and a file.
- [ ] A sync that only changes the contents of existing blocks writes those blocks and the root, and no file-table block.
- [ ] A wrong key, a missing header and an interrupted population each throw their own error, change nothing, and never lead to initdb.
- [ ] Modified, swapped, moved, deleted, added and replayed records, and a deleted file, are detected at open; a replayed file table is detected before anything is built from it.
- [ ] A crash at any sync leaves a store that opens to a consistent state, with the file table and the blocks from the same commit and no orphan record.
- [ ] A second writer cannot overwrite a newer store.

## Verification
- `~/.claude/bin/heavy npm test` passes everything above plus the earlier suites.
- `~/.claude/bin/heavy npm run test:browser -- test/fs` passes in Chromium, Firefox and WebKit: at least the round trip, no-plaintext, wrong-key, never-initdb, tamper and stale-writer tests, and the crash matrix for every tenth K.
- `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0.
- The PR description has the acceptance list ticked with the test name that proves each line, and the `stats()` output of the 200-transaction workload (data blocks, table blocks, deletes and bytes per sync; `table.blocks` and `table.fill` at the end).

## Out of scope
- Key change, data-key rotation, `verify()`: #<PC-09>.
- Importing a plain-text database: not planned (owner question 1 = A; plan file 10 is kept for reference).
- Benchmarks and CI gates: #<PC-11>.
- Using it in Journal: 2002Bishwajeet/journal#1017.
- A Rust file backend.
- Publishing to npm and making the repository public (owner).

## STOP and comment on the issue if
- PGlite calls `syncToFs` or reads PGDATA before `initialSyncFs` has finished, or runs initdb in a way the open state machine cannot prevent.
- The crash-injection test (c) finds a K where the reopened database is not consistent. Paste K, the batch contents by record kind and count, and the Postgres error. Do not weaken the test.
- A load cannot be made to hold only one page (the backend or MEMFS forces a full copy).
- A reopen in the crash matrix finds a record the file table does not list, or a listed id without a record. That is an atomicity hole in the packed layout; paste K and the batch. Do not make the reader tolerant of orphans.
- A sync that only overwrites existing blocks writes a table block, or the packing test ends above twice the dense number of table blocks in spite of the repack rule, or repacks happen on most syncs of a workload. Report the workload; do not add a second compaction scheme on your own.
- You need to change the format of #<PC-05>. Propose the change on that issue first.

## Metadata
Depends on: #<PC-05>, #<PC-06>, #<PC-07>
Size: L
Area: db, security
Model: opus
Effort: xhigh
Review: fable
