# Using pglite-cipher

The README has the quick start. This page has the rest: options, open modes, errors, keys, integrity checks and memory on mobile.

## Options

`blockSize` (8192, 32768 or 65536, default 65536; used when the store is created, then read from it), `onProgress({ phase, done, total })` during the open, and `onFatal(error)` when the instance stops syncing for good (a second writer). `fs.stats()` reports counts and timings, and never keys or contents.

- **Give the database a name that says nothing:** `data`, not `notes-encrypted`. `new IndexedDbBackend(name)` opens one IndexedDB database with exactly `name` and one object store, `kv`, holding nothing but the encrypted records. A random name works too, but then you have to remember it somewhere, and that place is as visible as the name was. No name hides that a database exists.
- **Keep temp storage inside the data directory.** Everything under PGDATA is encrypted, Postgres's temp files included. Do not point `temp_tablespaces`, a tablespace or another mount outside it.
- **Exports are plaintext.** Encrypt or delete them yourself.
- **A close whose sync fails rejects with the backend's error:** the changes since the last sync were not saved. The instance cannot be used or closed again; open the store again, and it opens at the last sync. EncryptedFs drops everything it holds even then, but PGlite (0.5.10) keeps its own module, the whole database in memory, until the app drops the PGlite instance. Drop it, as SQLite frees a `sqlite3_close_v2` zombie connection once its last user lets go.
- **One writer per store.** A second instance that opened the same store loses at its next sync, `changeKey` or `rotateDataKey` (`StaleWriterError`). During a rotation either one can lose (see Keys, below).

## Syncing

PGlite does not always sync when it should (electric-sql/pglite#1191, #1065, #1063), so sync yourself when it matters, for example when the page is hidden:

```ts
await fs.syncToFs(false); // strict
await pg.close();         // waits for a running sync, then commits everything strict
```

A strict sync waits for a running one and resolves once everything before it is committed strict, including what a relaxed sync already committed. `hasDirty()` is false then, so don't skip the sync on it.

## Open modes
| Mode | Empty storage | A store that opens |
|---|---|---|
| `open` | `StoreMissingError` | loads it |
| `create` | creates a store | `StoreExistsError` |
| `open-or-create` | creates a store | loads it |

Whatever the mode, storage that holds something other than a complete store is never initialised over: the open throws, changes nothing, and Postgres never runs `initdb` on it.

## Errors, and what an app should do
| Error | Meaning | What to do |
|---|---|---|
| `WrongKeyError` | The key does not open the store | Find the right key. Never reset: the data is intact |
| `CorruptStoreError` | A record was changed, lost, added or replayed | Restore from a backup, or let the user choose to start over. Never reset on your own |
| `IncompleteStoreError` | `rotation: false`: a create that never finished, or a store whose header or root is gone; nothing in it can be opened. `rotation: true`: a rotation was interrupted, on a single backend opened without `openOrigin` (see Keys, below) | `rotation: false`: clear the storage (`backend.clear()`) and create again, after asking the user if it could have held data. `rotation: true`: open again with `openOrigin`, which resumes the rotation; never clear it |
| `UnsupportedFormatError` | A newer version of this package wrote the store | Update the app. **Never reset**: the data is fine |
| `StoreMissingError` | `open` found empty storage | Create it (`create` or `open-or-create`), or report the missing data |
| `StoreExistsError` | `create` found storage that is not empty | Open it instead, or choose another name |
| `StaleWriterError` | Another instance wrote the store after this one opened it, or kept writing while it opened | Close this instance and reopen; its unsynced changes are lost |
| `StoreFullError` | A sync would pass the format's limits (file table size, ids in a run) | Nothing was written; the store is as it was before that sync. Report it |
| `KeyChangeUnknownError` | `changeKey` failed, and it could not tell whether the new key was written: the old key or the new one opens the store | Keep both keys. Call `changeKey` again, or close and open with either |
| `CryptoSelfTestError` | WebCrypto on this platform gives wrong answers | Do not use encryption on this platform |

## Keys
The key you pass (the key-encryption key) wraps a random data key kept in the store's header, and the data key encrypts every record. So there are two operations, with different costs and guarantees:

- **`await fs.changeKey(newKey)`** wraps the same data key under a new key: one small write of both header copies, done at once. Afterwards the old key does not open the store. **But anyone who kept a copy of the old header and has the old key can still read every later copy of the store.** If the write fails, `changeKey` reads the header back to learn whether it applied: if it did, `changeKey` resolves; if not, it rejects with the backend's error and the old key still opens the store. If it cannot tell, it rejects with `KeyChangeUnknownError`: one of the two keys opens the store, so keep both, then call `changeKey` again or open with either.
- **`await fs.rotateDataKey({ onProgress })`** draws a new data key and re-encrypts every record into a second store, checks it, switches to it, and deletes the old one. It takes about as long as an open plus a full write. This is the one that defeats a copied header. It keeps the current key, so after a suspected exposure do both: `changeKey`, then `rotateDataKey`.

Nothing ever forces a rotation. Each writer session encrypts under its own subkey derived from the data key (as SQLCipher 5 does for each page write), which keeps every AES-GCM key far below the NIST SP 800-38D limit for the life of the data key. Rotate for one reason only: the key, or an old copy of the header, may have been exposed.

A rotation writes a second store, so give the filesystem two:

```ts
const fs = new EncryptedFs({ backend: IndexedDbBackend.pair('data'), key, mode: 'open-or-create' }); // databases data.a and data.b
await fs.rotateDataKey({ onProgress: ({ phase, done, total }) => {} });
```

- **An interrupted rotation needs nothing from the app.** The next open finds both stores and either finishes the switch or goes back to the old store, and deletes the other.
- **An instance that opens the pair while another rotates** cannot tell the rotation from an interrupted one, and finishes or undoes it too. Only one of the two wins; the other gets `StaleWriterError` (from its open, its `rotateDataKey` or through `onFatal`), and what it had not synced is lost.
- **Writes made while a rotation runs become durable when it completes.** Syncs wait for it (with `relaxedDurability: true` queries do not). A crash during a rotation returns to the state when it started.
- **With a single backend**, pass `backendFactory: () => ({ name, backend })` (an empty backend for the new store) to `rotateDataKey`, and `openOrigin: (name) => backend` to the constructor so that an open can resume an interrupted rotation.

**`await fs.verify({ onProgress })`**, or `verifyStore(backend, key)` without Postgres, checks every record: both header copies, the root, the file table, every block and the manifest (like SQLCipher's `PRAGMA cipher_integrity_check`). It returns `{ ok, files, blocks, problems }`, each problem a record key (slot number or block id) and a reason, never a path, and it does not throw for damage.

## Running on mobile
The whole data directory sits in memory (as with PGlite's `idb://`), and it is larger than the database: a 100 MB database had a 254 MB data directory, half of it WAL, and 189 MB of wasm memory after an open. Two Postgres settings and a checkpoint cut that by about 157 MB at 100 MB, with no gate regression and no loss of durability (`bench/results/2026-11-13/memory-levers.md`):

```ts
const pg = await PGlite.create({
  fs,
  relaxedDurability: true,
  // startParams replaces PGlite's defaults, so keep them.
  startParams: [...PGlite.defaultStartParams, '-c', 'shared_buffers=16MB', '-c', 'min_wal_size=32MB', '-c', 'max_wal_size=32MB'],
});

// After bulk work (an import, a migration, a large delete):
await pg.exec('CHECKPOINT');
```

- **WAL:** with the small WAL settings, a `CHECKPOINT` after bulk work removes the spare segments: at 100 MB `pg_wal` went from 128 MB to 32 MB, the data directory from 254 MB to 158 MB, and the encrypted open got 20 to 26 % faster. Neither half works alone: PGlite did not checkpoint by itself during a 100 MB import, and with the default settings a checkpoint keeps the old segments for reuse. At 10 MB `pg_wal` is already at its minimum, two 16 MB segments.
- **`shared_buffers` 16 MB** (default 128 MB) keeps the wasm memory at its 128 MB floor: 61 MB less after an open, 98 MB less after a bulk import (wasm memory never shrinks). Postgres caches fewer pages; the data directory is in memory anyway. 32 MB measured the same.
- **`initialMemory`** cannot help: PGlite 0.5.10 needs at least 128 MB, its default, and `PGlite.create` with less never settles.

## Use from another repository as a submodule
Add this repository as a git submodule and import from the source, with no build step:

```ts
import { EncryptedFs } from '../vendor/pglite-cipher/src/index.ts';
```

The host's bundler compiles the TypeScript, and the host provides `@electric-sql/pglite` (`^0.5.10`) from its own `node_modules`. This package has no runtime dependencies.
