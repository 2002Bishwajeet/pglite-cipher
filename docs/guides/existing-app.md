# Add encryption to an existing PGlite app

## The change

Queries stay the same. Only the way PGlite is created changes:

```ts
// Before
const pg = await PGlite.create('idb://my-app');
```

```ts
// After
import { EncryptedFs, IndexedDbBackend } from 'pglite-cipher';

const fs = new EncryptedFs({ backend: IndexedDbBackend.pair('data'), key, mode: 'open-or-create' });
const pg = await PGlite.create({ fs, relaxedDurability: true });
```

Then add the strict sync on `pagehide` from the [quick start](quick-start.md#4-sync-before-the-page-goes-away). For `key`, see [Where to keep the key](keys.md).

## Your existing data

The encrypted store is a new, separate database, and the old `idb://` database is not touched. To keep the data, copy it across once, then delete the plaintext copy:

```ts
import { PGlite } from '@electric-sql/pglite';
import { EncryptedFs, IndexedDbBackend } from 'pglite-cipher';

// 1. Dump the old data directory (plaintext: keep it in memory only).
const old = await PGlite.create('idb://my-app');
const tar = await old.dumpDataDir('none');
await old.close();

// 2. Load it into a new encrypted store and make it durable.
const fs = new EncryptedFs({ backend: IndexedDbBackend.pair('data'), key, mode: 'create' });
const pg = await PGlite.create({ fs, loadDataDir: tar, relaxedDurability: true });
await fs.syncToFs(false);

// 3. After checking the data in `pg`, delete the plaintext database.
indexedDB.deleteDatabase('/pglite/my-app');
```

Check the old database's name in DevTools (Application, IndexedDB) before you delete it. Run the migration once: on the next start, open with `mode: 'open'`, and only migrate if the old database still exists.

## Choosing the open mode

| `mode` | Empty storage | An existing store |
|---|---|---|
| `open` | `StoreMissingError` | loads it |
| `create` | creates a store | `StoreExistsError` |
| `open-or-create` | creates a store | loads it |

Use `open-or-create` for a normal start, `create` for a migration (so it can't silently open an old store), and `open` when an empty store would mean lost data. Whatever the mode, storage that holds something other than a complete store is never written over.

## Things to know

- **Name the database plainly:** `data`, not `notes-encrypted`. The name is the one thing an attacker can read.
- **One writer per store.** A second tab on the same store loses at its next sync (`StaleWriterError`).
- **Exports are plaintext:** `dumpDataDir()` and `pg_dump` output included. Encrypt or delete them yourself.
- **The open is slower than plain `idb://`,** because it decrypts everything. See the [performance numbers](../design/performance.md).
