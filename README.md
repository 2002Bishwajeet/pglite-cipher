# pglite-cipher

SQLCipher-style encryption at rest for [PGlite](https://pglite.dev) (Postgres compiled to WASM).

**Status:** format v1, the filesystem (`EncryptedFs`), key change, data-key rotation and `verify()` are written. The repo is private until there's a first release.

## What it is
- **A PGlite filesystem that encrypts below Postgres.** The database stays in MEMFS while it runs. Changed blocks are tracked, encrypted with AES-256-GCM (WebCrypto), and written in one atomic batch per sync. Each record is bound to its file and position.
- **Postgres is untouched.** Every file under PGDATA is encrypted, including catalogs, WAL, `pg_control` and the SLRUs. File names, sizes and the number of files are hidden.
- **Two-tier keys.** The caller supplies a key-encryption key (for example a random key from the OS keychain). The package wraps its own data key.
- **Pluggable storage.** IndexedDB (`IndexedDbBackend`), and `MemoryBackend` for tests.

Built first for [Journal](https://github.com/2002Bishwajeet/journal)'s native apps, where it's used as a git submodule, and meant to be usable by any PGlite app.

## What it protects, and what it does not
Someone who gets the stored files (a copy of the browser profile, a backup, a stolen disk) and not the key:
- **sees** that a database exists, the total number of blocks in it (its size, to the block) and when blocks are written;
- **does not see** anything about the files inside: not their number, names, sizes or modes, and not which block belongs to which file. No byte and no name says what kind of store it is;
- **cannot change it unnoticed:** a modified, swapped, moved, deleted, added or replayed block, and a deleted file, are detected at open (`CorruptStoreError`), and nothing is loaded.

It does not:
- **detect a rollback of the whole store** to an earlier full copy. That copy opens, with its older data;
- **protect memory.** While the database is open it is plaintext in the page's memory, as it is without encryption. Keys are non-extractable `CryptoKey`s, but JavaScript cannot lock or reliably wipe memory. Close makes a best-effort wipe of the data directory files and the wasm memory; copies the app made (query results), engine-internal copies and swap are not covered;
- **cover exports.** `dumpTar`, `pg.dumpDataDir()` and `pg_dump` output are plaintext by design;
- protect against software running as the same user while the database is open.

`SECURITY.md` has the threat model and how to report a problem.

## Compared to SQLCipher
The same idea, encryption underneath the database engine, adapted to Postgres in a webview. Short version of `docs/plan/01-sqlcipher-comparison.md` section 2, weaker rows included:

| | SQLCipher | pglite-cipher | Verdict |
|---|---|---|---|
| Cipher | v4: AES-256-CBC + HMAC-SHA512; v5 beta: AES-256-GCM | AES-256-GCM through WebCrypto | parity |
| Unit | one SQLite page (4 KB in v4) | one block of a Postgres file (64 KB by default), every file under PGDATA | parity; covers more files |
| Nonce and subkey | v5 beta: random IV and a one-time subkey per page write | random 96-bit nonce per record, under a subkey derived once per writer session (HKDF-SHA256) | parity by a cheaper route; a session's records share a salt |
| Header | 16-byte random salt, the rest encrypted | 168 bytes stored twice; only random nonces and salts are readable; version, cipher and block size inside an authenticated envelope | parity |
| What the stored bytes show | file size, which pages change | that a database exists, the total number of blocks, write timing (which records change, which were written in one session) | parity |
| What the tag binds | ciphertext, IV, page number | ciphertext, nonce, record type, store id, key id, file id and block index | stronger |
| What is detected | modified or swapped pages | also truncation, a replayed older block, a deleted file; every open checks every record. Neither detects a rollback of the whole store | stronger |
| Rekey | `PRAGMA rekey` re-encrypts every page | `changeKey` re-wraps the data key at once; `rotateDataKey` re-encrypts into a fresh store | stronger, but only `rotateDataKey` defeats a copied old header |
| Memory | page cache only; keys `mlock`ed and wiped | the whole database in memory, plus two pages of ciphertext while opening (about 64 MB at 64 KB blocks); JavaScript cannot lock or wipe keys | weaker, accepted |
| Open cost | random access, opens at once | decrypts everything at open (budget: 100 MB in 1.5 s on desktop, 3 s on the slowest phone) | weaker, accepted |
| Passphrase | PBKDF2-HMAC-SHA512 | none: the key is 32 random bytes from the keychain | weaker if a passphrase is ever wanted |
| Compliance, maturity | FIPS-validated enterprise builds; in wide use since 2008 | not FIPS validated; new code, no external review yet | weaker |

## Use

```ts
import { PGlite } from '@electric-sql/pglite';
import { EncryptedFs, IndexedDbBackend, importKek } from 'pglite-cipher';

// 32 random bytes from the OS keychain; importKek zeroes them once imported.
const key = await importKek(rawKey);
const fs = new EncryptedFs({ backend: new IndexedDbBackend('data'), key, mode: 'open-or-create' });
const pg = await PGlite.create({ fs, relaxedDurability: true });

await pg.exec('CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text)');

// PGlite does not always sync when it should (electric-sql/pglite#1191, #1065, #1063): sync
// yourself when it matters, for example when the page is hidden. A strict sync waits for a
// running one and resolves once everything before it is committed strict, including what a
// relaxed sync already committed (hasDirty() is false then, so do not skip on it).
await fs.syncToFs(false);

await pg.close(); // waits for a running sync, then commits everything strict
```

Options: `blockSize` (8192, 32768 or 65536, default 65536; used when the store is created, then read from it), `onProgress({ phase, done, total })` during the open, and `onFatal(error)` when the instance stops syncing for good (a second writer). `fs.stats()` reports counts and timings, and never keys or contents.

- **Give the database a name that says nothing:** `data`, not `notes-encrypted`. `new IndexedDbBackend(name)` opens one IndexedDB database with exactly `name` and one object store, `kv`, holding nothing but the encrypted records. A random name works too, but then you have to remember it somewhere, and that place is as visible as the name was. No name hides that a database exists.
- **Keep temp storage inside the data directory.** Everything under PGDATA is encrypted, Postgres's temp files included. Do not point `temp_tablespaces`, a tablespace or another mount outside it.
- **Exports are plaintext.** Encrypt or delete them yourself.
- **A close whose sync fails rejects with the backend's error:** the changes since the last sync were not saved. The instance cannot be used or closed again; open the store again, and it opens at the last sync. EncryptedFs drops everything it holds even then, but PGlite (0.5.10) keeps its own module, the whole database in memory, until the app drops the PGlite instance. Drop it, as SQLite frees a `sqlite3_close_v2` zombie connection once its last user lets go.
- **One writer per store.** A second instance that opened the same store loses at its next sync, `changeKey` or `rotateDataKey` (`StaleWriterError`). During a rotation either one can lose (see Keys).

### Open modes
| Mode | Empty storage | A store that opens |
|---|---|---|
| `open` | `StoreMissingError` | loads it |
| `create` | creates a store | `StoreExistsError` |
| `open-or-create` | creates a store | loads it |

Whatever the mode, storage that holds something other than a complete store is never initialised over: the open throws, changes nothing, and Postgres never runs `initdb` on it.

### Errors, and what an app should do
| Error | Meaning | What to do |
|---|---|---|
| `WrongKeyError` | The key does not open the store | Find the right key. Never reset: the data is intact |
| `CorruptStoreError` | A record was changed, lost, added or replayed | Restore from a backup, or let the user choose to start over. Never reset on your own |
| `IncompleteStoreError` | `rotation: false`: a create that never finished, or a store whose header or root is gone; nothing in it can be opened. `rotation: true`: a rotation was interrupted, on a single backend opened without `openOrigin` (see Keys) | `rotation: false`: clear the storage (`backend.clear()`) and create again, after asking the user if it could have held data. `rotation: true`: open again with `openOrigin`, which resumes the rotation; never clear it |
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

## Docs
- `docs/design/`: how it works and why, starting at [`docs/design/README.md`](docs/design/README.md)
- `FORMAT.md`: the on-disk format, version 1
- `SECURITY.md`: the threat model, the primitives, reporting a vulnerability
- `RELEASE-CHECKLIST.md`: what the owner checks before a release
- `bench/README.md`: the benchmark page and the nightly gates
- `docs/plan/`: the issue plans, starting at `00-overview.md`
- `docs/research/`: the design, its review and prior art

## Develop
Node 22 or newer. `AGENTS.md` has the rules.

```sh
npm ci
npx playwright install chromium firefox   # once; add webkit where it runs (not on this Linux host)
npm run build          # tsc, emits dist/ with declarations
npm run typecheck
npm run lint
npm test               # vitest in Node
npm run test:browser   # vitest browser mode: chromium, firefox, webkit; or `-- --project chromium`
npm run test:long      # long fuzz, property, crash and soak runs (CIPHER_LONG=1; CIPHER_SOAK_MINUTES, CIPHER_SEED)
npm run bench:build    # the benchmark page, bench/dist
npm run harness:test   # the harness's issue selector
```

## Use from another repository as a submodule
Add this repository as a git submodule and import from the source, with no build step:

```ts
import { EncryptedFs } from '../vendor/pglite-cipher/src/index.ts';
```

The host's bundler compiles the TypeScript, and the host provides `@electric-sql/pglite` (`^0.5.10`) from its own `node_modules`. This package has no runtime dependencies.

## Licence
To be decided before going public. MIT is the intent. Third-party notices: `THIRD_PARTY.md`.
