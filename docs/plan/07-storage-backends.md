<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-07).
Title: Storage backend interface, IndexedDB and in-memory backends, fault injection
Labels: agent-ready, security
Origin: 2002Bishwajeet/journal#553 ("Pluggable storage backend", "Atomicity"). Resolves the backend parts of review findings S5, S6, S7, S8.
-->
## Context
The encrypted filesystem writes ciphertext records (format v1, #<PC-05>, `FORMAT.md`) to a store. The store sits behind a small interface so that IndexedDB is not the only possible home: a Rust file store may follow (decided in #<PC-04>). This issue defines the interface, implements IndexedDB and an in-memory backend, and builds the fault-injecting wrapper that the crash tests of #<PC-08>, #<PC-09> and #<PC-10> rely on.

The backend sees only keys and opaque bytes. It never holds a key and never decrypts.

## Change
New code in `src/backend/`, tests in `test/backend/`.

1. **Interface** (`backend.ts`):
   ```ts
   type RecordKey = ["h", 0 | 1] | ["m"] | ["i", string] | ["b", string, number];
   interface CommitBatch {
     /** Abort unless the stored ["m"] value equals this, byte for byte. null = must be absent. undefined = no check. */
     expectMutable?: Uint8Array | null;
     puts: Array<[RecordKey, Uint8Array]>;
     deletes: RecordKey[];
     /** Half-open ranges of block indexes for one file. */
     deleteRanges: Array<{ fileId: string; from: number; to: number }>;
     durability: "relaxed" | "strict";
   }
   interface StorageBackend {
     isEmpty(): Promise<boolean>;                       // zero records of any kind
     get(key: RecordKey): Promise<Uint8Array | undefined>;
     /** Ascending key order, at most `limit` records per page; resume with `after`. */
     readRange(kind: "i" | "b", after: RecordKey | null, limit: number): Promise<Array<[RecordKey, Uint8Array]>>;
     /** All or nothing. Rejects with StaleWriterError when expectMutable does not match. */
     commit(batch: CommitBatch): Promise<void>;
     /** Removes every record. */
     clear(): Promise<void>;
     close(): Promise<void>;
   }
   ```
2. **`IndexedDbBackend(name)`** (`indexeddb.ts`): one database `pglite-cipher:<name>`, one object store `r` with out-of-line keys (the `RecordKey` array itself).
   - `commit` runs in **one** `readwrite` transaction opened with `{ durability }`. Order inside it: `get(["m"])` and compare with `expectMutable` (plain byte comparison, **no crypto and no other `await` inside the transaction**: all values arrive already encrypted); on mismatch call `transaction.abort()` and reject with `StaleWriterError`; then the deletes, `deleteRanges` as `IDBKeyRange.bound(["b", id, from], ["b", id, to], false, true)`, then the puts. Resolve on `complete`; reject on `abort` or `error` with the transaction's error.
   - `readRange` uses `getAllKeys` + `getAll` on an `IDBKeyRange` (or a cursor where `getAll` with a range is missing, per the spike's G6 result).
   - `isEmpty` is `count() === 0`.
   - If the browser does not accept the `durability` option, open the transaction without it; never fail the commit for that.
   - A `versionchange` from another connection closes this one, and later calls reject with a clear error (a deleted database must not be silently recreated).
3. **`MemoryBackend`** (`memory.ts`): a sorted map with the same semantics, including the `expectMutable` check and atomic commits. Used by tests and by apps that want an encrypted in-memory snapshot.
4. **`FaultyBackend(inner, plan)`** (`faulty.ts`, exported from `pglite-cipher/testing`): wraps any backend and, per its plan, makes the Nth `commit` (a) reject before writing anything, or (b) reject after the inner commit **did** apply (models "the page died after the write": the caller sees a failure, the store has the new state), or (c) never settle (models a killed process: the test drops the instance and reopens the store). It also records every committed batch, so a test can replay the first K batches into a fresh backend and get the exact state "as of a crash after sync K".
5. **Conformance suite** (`conformance.ts`, exported for future backends): one function `runBackendConformance(makeBackend)` with every behaviour test below, run against `MemoryBackend` and `IndexedDbBackend`: on `fake-indexeddb` in Node, and on the **real** IndexedDB of Chromium, Firefox and WebKit through `npm run test:browser`. Before writing the commit path, read about 150 lines around `jLock`/`xSync` in wa-sqlite's `IDBMirrorVFS.js` (MIT): it solves the same "is my view of the store still current" check for several tabs.

### Tests
- Conformance, both backends: put/get round trip; `readRange` pages in key order and resumes exactly; block keys for one file sort by numeric index (index 2 before index 10); `deleteRanges` removes exactly `[from, to)` of that file and nothing of another file whose id is a prefix-neighbour; a batch with a failing `expectMutable` changes nothing and rejects with `StaleWriterError`; `expectMutable: null` passes only when `["m"]` is absent; a batch is all or nothing (inject an invalid key as the last put: nothing from the batch is visible); `isEmpty` is true only with zero records; `clear` empties it.
- IndexedDB only: a commit of 5,000 puts lands in one transaction (spy on `indexedDB.open(...).transaction`); the `durability` option is passed through when supported and its absence does not fail.
- `FaultyBackend`: modes (a), (b), (c) behave as described; replaying K recorded batches reproduces the state.
- Property test (fast-check): random sequences of batches applied to `MemoryBackend` and `IndexedDbBackend` leave identical contents.

## Verification
- `~/.claude/bin/heavy npx vitest run src/backend` passes: the conformance suite on both backends, the IndexedDB-only tests, the `FaultyBackend` tests, the equivalence property.
- `~/.claude/bin/heavy npm run test:browser -- test/backend` passes in Chromium, Firefox and WebKit, including the all-or-nothing and `expectMutable` tests on the real IndexedDB.
- `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0.
- Read the IndexedDB backend's commit: there is no await between opening the readwrite transaction and its last request. State this in the PR with the line numbers.

## STOP and comment on the issue if
- A conformance test passes on `fake-indexeddb` and fails in a real browser, or the three browsers disagree. Report the test and the browser; that difference is the finding.
- The spike's G6 result says a target webview lacks array keys or key-range deletes. Report the target; do not switch to string-concatenated keys without saying so.
- The owner's comment on #<PC-04> says a `Store:` line other than `indexeddb`. The interface, the in-memory backend, `FaultyBackend` and the conformance suite are still needed; build them, build `IndexedDbBackend` too unless the comment says to skip it, and note in the PR which backend the app will use.

## Metadata
Depends on: #<PC-05>
Size: M
Area: db, security
Model: opus
Effort: high
