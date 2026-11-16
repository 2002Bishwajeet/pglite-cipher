# Storage backends

## What a backend is

A backend (`StorageBackend` in `src/backend/backend.ts`) stores keys and opaque bytes. It never
holds a key, never decrypts, and cannot tell which file a block belongs to. Its keys are the three
slots `0`, `1`, `2` (header copies and root) and block ids of 32 lowercase hex characters. Any
other key is refused (`isRecordKey`), so a backend cannot store anything else by mistake.

| Method | Contract |
|---|---|
| `isEmpty()` | zero records of any kind |
| `count()` | slots and blocks together; lets a caller prove no unknown record exists |
| `get(slot)` | one slot |
| `getMany(ids)` | many blocks in one read, in the order asked, `undefined` for a missing one; the open uses it for the table blocks the root lists |
| `readRange(after, limit)` | blocks only, never slots, in ascending id order, resumable after any id |
| `commit(batch)` | all or nothing; deletes run before puts; checks `expectRoot` first |
| `clear()` | removes every record |
| `destroy()` (optional) | removes the storage itself; the backend stays usable and starts empty |
| `close()` | closes the connection |

A `CommitBatch` is `{ expectRoot, puts, deletes, durability }`:

- `expectRoot`: the commit aborts with `StaleWriterError` unless slot 2 holds exactly these bytes
  (`null`: slot 2 must be absent; omitted: no check). This one byte comparison is how a writer
  finds out that another writer committed (see [integrity.md](integrity.md)).
- `durability`: `relaxed` or `strict`, passed to the storage where it supports it.

The interface has no file ids, no block indexes and no range deletes on purpose. A file's blocks
are not neighbours in the key space, so the caller lists the ids to delete. A backend must not add
any of this back: no key prefix, no per-record metadata, no name that says what the store is.

## `IndexedDbBackend`

`src/backend/indexeddb.ts`. One IndexedDB database with exactly the name the caller gives, one
object store `kv` with out-of-line keys, nothing else: no index, no metadata store, no prefix or
suffix on the name.

- **Slots are number keys, blocks are string keys.** IndexedDB orders numbers before strings, so
  `readRange` with a lower bound of `""` sees only blocks. It uses `getAllKeys` and `getAll` over
  the same key range.
- **`commit` is one `readwrite` transaction.** It reads slot 2 and compares it with `expectRoot`,
  then runs the deletes, then the puts. There is no `await` between opening the transaction and
  its last request (every value arrives already encrypted), because an `await` would let
  IndexedDB commit the transaction early. A mismatch aborts the transaction and rejects with
  `StaleWriterError`.
- **Durability** is passed as the transaction option. A browser that rejects the option gets a
  transaction without it.
- **`destroy()`** deletes the database. If another connection blocks the deletion, it waits a
  short grace period (WebKit reports a blocked deletion while a closing connection finishes).
- **Another connection deletes or upgrades the database:** this connection closes and refuses
  later calls, instead of re-creating the database.
- **`IndexedDbBackend.pair(name)`** returns the backends for `<name>.a` and `<name>.b`. A data-key
  rotation writes into the empty one, so an open finds the current store with no outside state.

**Naming.** The name is the one thing about the store the package cannot hide. Pass one that says
nothing (`data`, not `notes-encrypted`). A random name works too, but it has to be remembered
somewhere, and that place is as visible as the name was. No name hides that a database exists. The
object-store name `kv` is a constant because it must be known before anything can be read.

**Why IndexedDB.** It is available in every target webview and in browsers, it runs inside a
worker, and its transactions give an all-or-nothing sync with no journal of our own. Its weakness
is read throughput for many large values at open, on some platforms (see
[performance.md](performance.md)). The interface exists so that another store can be added without
changing the format or the filesystem.

## `MemoryBackend`

`src/backend/memory.ts`. The same semantics in memory: three slots, a sorted map of blocks, the
`expectRoot` check, atomic commits, and values copied in and out as structured clone does. Used by
tests and usable wherever persistence is not wanted.

## `FaultyBackend`

`src/backend/faulty.ts`, exported from `pglite-cipher/testing` with the other test hooks. It wraps
another backend and fails on purpose, for the crash tests:

| Fault | Meaning |
|---|---|
| commit `before` | rejects and writes nothing |
| commit `after` | the commit applies, then rejects: the process died after the write |
| commit `hang` | never settles and writes nothing: a killed process |
| `rootRead` | a chosen `get(2)` rejects |

`pglite-cipher/testing` also has hooks that make randomness predictable. They are for tests only.

## The conformance suite

`runBackendConformance(name, makeBackend)` in `src/backend/conformance.ts` is one vitest suite that
every backend must pass before anything uses it: round trips of slots and blocks, own copies of
written values, `getMany` order, `readRange` order and resumption without slots, delete semantics,
a put and a delete of one key in a batch, `expectRoot` behaviour, all-or-nothing batches, and
`count` and `isEmpty`. `test/backend/` runs it against `MemoryBackend`, `IndexedDbBackend` and
`FaultyBackend` (with no fault planned), in
Node (with `fake-indexeddb`) and in Chromium, Firefox and WebKit.
