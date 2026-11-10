<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-10).
Title: Import an existing plain idb:// data directory: verified, header last
Labels: agent-ready, security
Origin: 2002Bishwajeet/journal#1017 step 4 and the spec's "Migrating an existing plaintext DB". Resolves the package half of review finding B2.
Needed only if owner question 1 keeps migration (docs/plan/99-owner-questions.md). If the owner chooses "encryption from the first public native build; testers reset and sync again", close this as not planned, and close the Journal migration issue (journal/08) with it.
-->
## Context
Apps that already have a plain-text PGlite database in IndexedDB (PGlite's `idb://` filesystem) need to move it into `EncryptedFs` (#<PC-08>) without ever having only a half-written copy. SQLCipher's tool for this is `sqlcipher_export()`. This issue is the same for PGlite, done at the file level: it copies the data directory's files, not rows, so it needs no second Postgres engine and no `pg_dump`.

PGlite's `idb://` filesystem is Emscripten IDBFS. Its IndexedDB database is named `/pglite/<dataDir>`, with an object store `FILE_DATA` whose keys are absolute paths and whose values are `{ timestamp, mode, contents? }` (`contents` is a `Uint8Array` for files, absent for directories). Verify these names against `node_modules/@electric-sql/pglite/dist` before relying on them.

Three ways the first design lost data (review finding B2), which this issue must make impossible:
1. A partial encrypted store is taken for a complete one.
2. After a crash both stores exist and the stale plain-text one is imported again over newer encrypted data.
3. The plain-text records are copied while a live engine is still writing them, so the copy is torn.

## Change
`src/importPlain.ts`, tests in `test/import/`.

1. **`readIdbFsImage(dbName): AsyncIterable<{ path, mode, mtime, contents? }>`**: opens the IDBFS database **read-only**, never creates it (if `indexedDB.open` fires `upgradeneeded` for a database that did not exist, abort and delete the empty database, and report "no source"), and yields entries in pages. It does not modify the source.
2. **`importPlainDataDir({ source, backend, key, blockSize, origin, onProgress }): Promise<ImportReport>`**:
   1. **Preconditions:** `backend.isEmpty()` must be true, else `StoreExistsError` (the caller decides what to do with an existing or partial store; this function never overwrites). The source must contain `PG_VERSION`.
   2. Write both static header copies (new `storeId`, new DEK). **No mutable header.** From here until step 5 the store is "records without a mutable header", which `EncryptedFs` refuses to open (`IncompleteStoreError`).
   3. Stream the source: for each entry, assign a `fileId`, seal its blocks and its inode, and commit in batches of at most 512 records. Keep, per file, a SHA-256 of the plain-text contents and the tags of the records written. Never hold more than one source file plus one batch in memory; a 1 GB relation segment is read through its single IDBFS record, so say so in the README (peak memory is the largest file plus one batch).
   4. **Verify by reading back:** re-read every record from the backend in pages, open it, rebuild each file's bytes as a running SHA-256, and compare with the hash from step 3; compare file count, sizes and modes. Any difference: `clear()` the backend and throw `ImportVerifyError` naming the file's *kind* (WAL, relation, other), never its contents.
   5. **Commit marker:** write the mutable header with `state: "ready"`, the manifest digest, `gen: 1`, `origin` (the caller's string, for example `idbfs:/pglite/my-db`), with `expectMutable: null` and `durability: "strict"`. Only now is the store valid.
   6. Return `{ files, blocks, bytes, ms }`. **This function never deletes the source.** Deleting is the caller's step, after it has also opened the new store with Postgres.
3. **`discardIncompleteStore(backend)`**: `clear()` only if the store has no mutable header or its state is `"populating"`; throws if the store is `"ready"`. This is the only sanctioned way to remove a partial import.
4. **README:** a "Migrating a plain database" section with the required order for callers:
   1. Close the plain-text engine after a final awaited, strict flush. Hold a lock so no other tab opens it.
   2. If the encrypted store is `"ready"`: it wins. Do not import again. Go to step 5.
   3. If it is incomplete: `discardIncompleteStore`, then import.
   4. Import. Open the result with PGlite and run the app's own sanity query.
   5. Delete the plain-text database.

### Tests (real PGlite, `fake-indexeddb`)
- **End to end:** build a plain database with PGlite on `IdbFs` (schema with `pg_trgm`, 2,000 rows, deletes, a `VACUUM`), close it, import it, open with `EncryptedFs`: every table's rows and a checksum equal the source's; Postgres reports no recovery error.
- **Source untouched:** the IDBFS database's records are byte-identical before and after an import, successful or failed.
- **Never creates the source:** importing from a name that does not exist reports "no source" and leaves no database of that name.
- **Crash at every batch (`FaultyBackend`):** kill at each commit of steps 2–5. In every case: `EncryptedFs` open throws `IncompleteStoreError` (or, after step 5 committed, opens fine); `discardIncompleteStore` empties it; a second import succeeds.
- **Read-back catches damage:** a backend wrapper that corrupts one stored block makes the import throw `ImportVerifyError` and leave the backend empty.
- **Refuses to overwrite:** import into a `"ready"` store throws `StoreExistsError` and changes nothing; `discardIncompleteStore` on a `"ready"` store throws.
- **Bytes, not meaning:** a source whose files have arbitrary sizes (not multiples of the block) imports byte for byte. The import copies files; making the source consistent first is the caller's flush, and the README says so.
- **Memory:** with a counting backend, never more than one batch of ciphertext is held.
- All three block sizes.

## Verification
- `~/.claude/bin/heavy npm test` passes, including the crash test at every commit index.
- `~/.claude/bin/heavy npm run test:browser -- test/import` passes in Chromium, Firefox and WebKit: the end-to-end test against a plain database written by the real `IdbFs` in that browser.
- `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0.
- The README section exists with the five-step caller order.

## STOP and comment on the issue if
- The IDBFS database layout in this PGlite version differs from the Context (store name, key or value shape). Report what it is.
- A read-only open of the IDBFS database is impossible without triggering an upgrade.
- The end-to-end test shows Postgres doing crash recovery that fails on the imported store. Paste the error.
- You find a reason the function should delete the source itself.

## Metadata
Depends on: #<PC-08>
Size: M
Area: db, security
Model: opus
Effort: high
