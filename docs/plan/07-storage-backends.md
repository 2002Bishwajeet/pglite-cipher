<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-07).
Title: Storage backend interface, IndexedDB and in-memory backends, fault injection
Labels: agent-ready, security
Origin: 2002Bishwajeet/journal#553 ("Pluggable storage backend", "Atomicity"). Resolves the backend parts of review findings S5, S6, S7, S8. Adapted to the packed block space of format v1 (owner decision 2026-11-10): the backend sees three fixed slots and opaque block ids, never a file.
-->
## Context
The encrypted filesystem writes ciphertext records (format v1, #<PC-05>, `FORMAT.md`) to a store. The store sits behind a small interface so that IndexedDB is not the only possible home: a Rust file store may follow (decided in #<PC-04>). This issue defines the interface, implements IndexedDB and an in-memory backend, and builds the fault-injecting wrapper that the crash tests of #<PC-08> and #<PC-09> rely on.

The backend sees only keys and opaque bytes. It never holds a key and never decrypts. In format v1 it also cannot tell what a record is for: there are three fixed slots (two header copies and the root) and a flat set of equal-size blocks under random ids. Which block belongs to which file is inside the encrypted file table, so the interface has **no file ids, no block indexes and no range deletes**. A backend must not add any of that back: no key prefix, no per-record metadata, no name that says what the store is.

## Change
New code in `src/backend/`, tests in `test/backend/`.

1. **Interface** (`backend.ts`):
   ```ts
   /** 16 random bytes as 32 lowercase hex characters. */
   type BlockId = string;
   /** 0 and 1: the header copies. 2: the root. */
   type Slot = 0 | 1 | 2;
   type RecordKey = Slot | BlockId;
   interface CommitBatch {
     /** Abort unless the stored value of slot 2 equals this, byte for byte. null = must be absent. undefined = no check. */
     expectRoot?: Uint8Array | null;
     puts: Array<[RecordKey, Uint8Array]>;
     /** Deleting a key that is not there is not an error. */
     deletes: RecordKey[];
     durability: "relaxed" | "strict";
   }
   interface StorageBackend {
     isEmpty(): Promise<boolean>;                       // zero records of any kind
     /** Slots and blocks together. */
     count(): Promise<number>;
     get(slot: Slot): Promise<Uint8Array | undefined>;
     /** One read for many blocks; the result has the order of `ids`, with undefined for a missing one. */
     getMany(ids: BlockId[]): Promise<Array<Uint8Array | undefined>>;
     /** Blocks only, never the slots. Ascending id order, at most `limit` per page; resume with `after`. */
     readRange(after: BlockId | null, limit: number): Promise<Array<[BlockId, Uint8Array]>>;
     /** All or nothing. Rejects with StaleWriterError when expectRoot does not match. */
     commit(batch: CommitBatch): Promise<void>;
     /** Removes every record. */
     clear(): Promise<void>;
     close(): Promise<void>;
   }
   ```
   What changed from the per-file layout, and why: `readRange` has no record kind, because the backend cannot know one, and its order is the order of random ids, which means nothing; `getMany` exists because an open must fetch the file-table blocks, whose ids the root lists, before it can place any other block; `deleteRanges` is gone, because one file's blocks are no longer neighbours, and the caller lists the ids to delete; `count` lets a caller prove that a store holds no record it does not know about.
2. **`IndexedDbBackend(databaseName)`** (`indexeddb.ts`): one database with **exactly the name the caller gives** and one object store named `kv` with out-of-line keys: the numbers `0`, `1`, `2` for the slots and the 32-character string for a block. IndexedDB orders numbers before strings, so the blocks are the string keys.
   - **Names.** The package adds no prefix, no suffix and no version to the name, and stores nothing in the database besides the records: no index, no metadata store. The README tells callers to pass a name that says nothing (`data`, not `notes-encrypted`). A caller may use a random name instead; it must then remember the name itself, and the place where it remembers is as visible as the name was. The object-store name is a constant because it has to be known before anything can be read; it says nothing about the contents. What a name cannot hide: that a database exists, and whose profile folder it is in.
   - `commit` runs in **one** `readwrite` transaction opened with `{ durability }`. Order inside it: `get(2)` and compare with `expectRoot` (plain byte comparison, **no crypto and no other `await` inside the transaction**: all values arrive already encrypted); on mismatch call `transaction.abort()` and reject with `StaleWriterError`; then the deletes, then the puts. Resolve on `complete`; reject on `abort` or `error` with the transaction's error.
   - `readRange` uses `getAllKeys` + `getAll` on `IDBKeyRange.lowerBound(after ?? "", after !== null)` (or a cursor where `getAll` with a range is missing, per the spike's G6 result). The lower bound `""` skips the three number keys.
   - `getMany` issues its `get` requests in one `readonly` transaction.
   - `isEmpty` is `count() === 0`.
   - If the browser does not accept the `durability` option, open the transaction without it; never fail the commit for that.
   - A `versionchange` from another connection closes this one, and later calls reject with a clear error (a deleted database must not be silently recreated).
3. **`MemoryBackend`** (`memory.ts`): a sorted map with the same semantics, including the `expectRoot` check and atomic commits. Used by tests and by apps that want an encrypted in-memory snapshot.
4. **`FaultyBackend(inner, plan)`** (`faulty.ts`, exported from `pglite-cipher/testing`): wraps any backend and, per its plan, makes the Nth `commit` (a) reject before writing anything, or (b) reject after the inner commit **did** apply (models "the page died after the write": the caller sees a failure, the store has the new state), or (c) never settle (models a killed process: the test drops the instance and reopens the store). A plan can also make the Nth `get(2)` reject, so that a caller's check of what a failed commit left behind (#<PC-08>) can itself fail. It also records every committed batch, so a test can replay the first K batches into a fresh backend and get the exact state "as of a crash after sync K".
5. **Conformance suite** (`conformance.ts`, exported for future backends): one function `runBackendConformance(makeBackend)` with every behaviour test below, run against `MemoryBackend` and `IndexedDbBackend`: on `fake-indexeddb` in Node, and on the **real** IndexedDB of Chromium, Firefox and WebKit through `npm run test:browser`. Before writing the commit path, read about 150 lines around `jLock`/`xSync` in wa-sqlite's `IDBMirrorVFS.js` (MIT): it solves the same "is my view of the store still current" check for several tabs.

### Tests
- Conformance, both backends: put/get round trip for the three slots and for blocks; `getMany` returns values in the order asked, with `undefined` for a missing id, for 1 and for 2,000 ids; `readRange` returns blocks in ascending id order, resumes exactly after any id, and **never returns a slot**; `deletes` removes exactly the listed keys and deleting an absent key succeeds; a put and a delete of the same key in one batch leaves the put (deletes run first); a batch with a failing `expectRoot` changes nothing and rejects with `StaleWriterError`; `expectRoot: null` passes only when slot 2 is absent; a batch is all or nothing (inject an invalid key as the last put: nothing from the batch is visible); `count` is the number of slots plus blocks; `isEmpty` is true only with zero records; `clear` empties it.
- **The backend adds nothing readable** (IndexedDB only): after writing a store, list `indexedDB.databases()` and the database's object stores, indexes and keys: the database name is exactly the caller's string, the only object store is `kv`, there is no index, and every key is `0`, `1`, `2` or 32 lowercase hex characters.
- IndexedDB only: a commit of 5,000 puts and 2,000 deletes lands in one transaction (spy on `indexedDB.open(...).transaction`); the `durability` option is passed through when supported and its absence does not fail.
- `FaultyBackend`: modes (a), (b), (c) and the failing `get(2)` behave as described; replaying K recorded batches reproduces the state.
- Property test (fast-check): random sequences of batches applied to `MemoryBackend` and `IndexedDbBackend` leave identical contents.

## Verification
- `~/.claude/bin/heavy npx vitest run src/backend` passes: the conformance suite on both backends, the IndexedDB-only tests, the `FaultyBackend` tests, the equivalence property.
- `~/.claude/bin/heavy npm run test:browser -- test/backend` passes in Chromium, Firefox and WebKit, including the all-or-nothing and `expectRoot` tests on the real IndexedDB.
- `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0.
- Read the IndexedDB backend's commit: there is no await between opening the readwrite transaction and its last request. State this in the PR with the line numbers.

## STOP and comment on the issue if
- A conformance test passes on `fake-indexeddb` and fails in a real browser, or the three browsers disagree. Report the test and the browser; that difference is the finding.
- The spike's G6 result says a target webview lacks number and string keys in one object store, orders them differently, or lacks key-range `getAll`. Report the target; do not change the key scheme without saying so.
- 2,000 single-key deletes in one transaction (one 16 MB WAL segment removed at 8 KB blocks) take longer than the same number of puts in any of the three browsers. Report the times: the format has no range delete to fall back on.
- The owner's comment on #<PC-04> says a `Store:` line other than `indexeddb`. The interface, the in-memory backend, `FaultyBackend` and the conformance suite are still needed; build them, build `IndexedDbBackend` too unless the comment says to skip it, and note in the PR which backend the app will use.

## Metadata
Depends on: #<PC-05>
Size: M
Area: db, security
Model: opus
Effort: high
