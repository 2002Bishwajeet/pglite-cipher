# Crash safety and tamper detection

## Crash safety

**Each sync is one atomic commit.** Data blocks, table blocks, deletes and the new root go into one
backend transaction (see [architecture.md](architecture.md)). The store therefore holds either the
state before a sync or the state after it, never a mix. Each committed state is a snapshot taken
between two Postgres engine calls, which is a crash image of Postgres; Postgres replays its WAL on
the next open, as after a power loss.

**No journal and no free list are needed.** A block is overwritten in place under its own id, which
is safe because the overwrite is part of an all-or-nothing transaction. Space freed by a delete is
the backend's to reuse.

**Relaxed and strict durability.** A relaxed commit can be lost in a crash; the store then opens at
an earlier, consistent sync. A strict commit (`syncToFs(false)`, `close`, key change, rotation) is
durable once it resolves. Crash *consistency* is the same in both modes.

**A commit whose outcome is unknown.** A commit can reject although it applied (the process or the
connection died after the write). In a packed block space it is not safe to guess: a writer that
wrongly believed a commit failed would forget ids that are in the store, and the next open would
find records the file table does not list and refuse the store. So after any rejection other than
`StaleWriterError`, the filesystem reads slot 2:

| Slot 2 holds | Meaning | What happens |
|---|---|---|
| the root this sync sealed | the commit applied | the sync counts as done |
| the previous root | nothing was written | the snapshot is requeued, the error is rethrown, the next sync retries |
| anything else | another writer committed | `StaleWriterError`, syncs stop |
| the read fails | unknown | the plan is kept as *unsettled*; `hasDirty()` stays true and the next sync or close settles it first |

`changeKey` and the rotation steps settle their commits the same way (`commitSettled` and
`headerKey` in `src/encryptedFs.ts`).

**Never `initdb` over data.** After `initialSyncFs`, PGlite runs `initdb` when `PG_VERSION` is
missing. So an open never returns normally on a store it could not read completely, never treats
a non-empty store as empty, and removes anything it built in MEMFS before it throws. Storage that
holds something other than a complete store gives an error and is never initialised over.

**Incomplete stores.** A store with records but no header, a header but no root, or a root marked
`populating` gives `IncompleteStoreError`. A root marked `rotating` is an interrupted rotation, which
an open with both stores available finishes or undoes (see [keys.md](keys.md)).

**One writer per store.** Every commit carries `expectRoot`. When a second instance has committed,
the first one's next commit is refused with `StaleWriterError`, its syncs stop for good, and
`onFatal` is called. It never overwrites the newer store. A load that keeps meeting a moving root
also gives `StaleWriterError` after 3 attempts.

These properties are tested with `FaultyBackend` at every commit of a workload, with a worker
terminated at random moments in the browsers, and by opening a frozen reference store
(`test/fixtures/v1-reference/`) that every later version must keep opening.

## Tamper detection

Every open decrypts and checks every record, so every open is a full integrity check. `verify()`
runs the same checks on demand and reports instead of throwing.

| Change to the stored bytes | Caught by | Result at open |
|---|---|---|
| a bit flipped in any record | the record's GCM tag | `CorruptStoreError` |
| a data block moved or swapped to another id, file or position | AAD binds file id and index; the table says what lives at each id | `CorruptStoreError` |
| a record moved between stores, or a root/table/data record used as another type | AAD binds `storeId` and the type byte | `CorruptStoreError` |
| a data block deleted | the count of data blocks against the root, and the manifest | `CorruptStoreError` |
| a whole file's blocks deleted | the file table still lists them | `CorruptStoreError` |
| a table block deleted, swapped or reordered | `getMany` finds it missing, or `tableDigest` | `CorruptStoreError`, before anything is built |
| a record added under a new id | the id is not in the file table | `CorruptStoreError` |
| one record replaced by an older valid copy of itself | its tag no longer matches `manifest` or `tableDigest` | `CorruptStoreError` |
| the root replaced by an older root | its digests no longer match the current blocks | `CorruptStoreError` |
| the file table internally inconsistent | `assembleFiles` checks | `CorruptStoreError` |
| one header copy damaged | the other copy opens | opens; the next sync rewrites both |
| both header copies damaged differently, or one missing | the pair disagrees | `CorruptStoreError` |
| version, cipher or block size changed or downgraded | the meta is authenticated under a key derived from the DEK | `CorruptStoreError` (or `UnsupportedFormatError` for a version a reader does not know) |

`CorruptStoreError` means: a record failed its tag, a body failed to decode, or the file table and
blocks are inconsistent with each other or with the root (`src/format/errors.ts`). Its message
names a slot or block id, never a path, a key or plaintext. Nothing is loaded when it is thrown.
What an app should do about it is in [Usage](../usage.md#errors-and-what-an-app-should-do): restore from a backup or let the user choose to
start over, and never reset on its own.

## Not detected

- **Whole-store rollback.** An older complete copy of the store is valid in every byte and opens,
  with its older data. Catching it would need a counter outside the store; a relaxed sync lost in
  a crash would then look like an attack.
- **Two header copies overwritten with the same bytes** read as a wrong key (`WrongKeyError`), not
  as damage: two identical copies that fail to unwrap are indistinguishable from a wrong key.
