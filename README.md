# pglite-cipher

SQLCipher-style encryption at rest for [PGlite](https://pglite.dev) (Postgres compiled to WASM).

**Status:** format v1 and the filesystem are written (`EncryptedFs`); key change and data-key rotation are next. The repo is private until there's a first release.

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
- **protect memory.** While the database is open it is plaintext in the page's memory, as it is without encryption. Keys are non-extractable `CryptoKey`s, but JavaScript cannot lock or wipe memory;
- **cover exports.** `dumpTar`, `pg.dumpDataDir()` and `pg_dump` output are plaintext by design;
- protect against software running as the same user while the database is open.

`docs/plan/01-sqlcipher-comparison.md` has the full comparison with SQLCipher.

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
// yourself when it matters, for example when the page is hidden.
if (fs.hasDirty()) await fs.syncToFs(false);

await pg.close(); // waits for a running sync, then commits everything strict
```

Options: `blockSize` (8192, 32768 or 65536, default 65536; used when the store is created, then read from it), `onProgress({ phase, done, total })` during the open, and `onFatal(error)` when the instance stops syncing for good (a second writer). `fs.stats()` reports counts and timings, and never keys or contents.

- **Give the database a name that says nothing:** `data`, not `notes-encrypted`. `new IndexedDbBackend(name)` opens one IndexedDB database with exactly `name` and one object store, `kv`, holding nothing but the encrypted records. A random name works too, but then you have to remember it somewhere, and that place is as visible as the name was. No name hides that a database exists.
- **Keep temp storage inside the data directory.** Everything under PGDATA is encrypted, Postgres's temp files included. Do not point `temp_tablespaces`, a tablespace or another mount outside it.
- **Exports are plaintext.** Encrypt or delete them yourself.
- **One writer per store.** A second instance that opened the same store loses at its next sync (`StaleWriterError`).

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
| `IncompleteStoreError` | `rotation: false`: a create that never finished, or a store whose header or root is gone; nothing in it can be opened. `rotation: true`: a key rotation was interrupted | `rotation: false`: clear the storage (`backend.clear()`) and create again, after asking the user if it could have held data. `rotation: true`: resume the rotation (#9); never clear it |
| `UnsupportedFormatError` | A newer version of this package wrote the store | Update the app. **Never reset**: the data is fine |
| `StoreMissingError` | `open` found empty storage | Create it (`create` or `open-or-create`), or report the missing data |
| `StoreExistsError` | `create` found storage that is not empty | Open it instead, or choose another name |
| `StaleWriterError` | Another instance wrote the store after this one opened it, or kept writing while it opened | Close this instance and reopen; its unsynced changes are lost |
| `StoreFullError` | A sync would pass the format's limits (file table size, ids in a run) | Nothing was written; the store is as it was before that sync. Report it |
| `CryptoSelfTestError` | WebCrypto on this platform gives wrong answers | Do not use encryption on this platform |

## Docs
- `FORMAT.md`: the on-disk format, version 1
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
npm run test:long      # long fuzz/property runs (CIPHER_LONG=1)
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
