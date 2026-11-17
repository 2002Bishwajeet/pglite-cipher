# Errors and recovery

Every error is exported, so an app can tell them apart:

```ts
import { CorruptStoreError, WrongKeyError } from 'pglite-cipher';

try {
  pg = await PGlite.create({ fs, relaxedDurability: true });
} catch (error) {
  if (error instanceof WrongKeyError) askForTheRightKey();
  else if (error instanceof CorruptStoreError) offerRestoreFromBackup();
  else throw error;
}
```

The rule behind all of them: **never wipe a store on your own.** Most errors mean the data is still there.

## Wrong key: `WrongKeyError`

The key doesn't open the store. The data is intact. Find the right key (an old keychain entry, or the passphrase before a change). Don't reset.

## Tampering or damage: `CorruptStoreError`

A record was changed, lost, added or replayed. Nothing was loaded. Restore from a backup, or let the user choose to start over. To see what is damaged without opening Postgres:

```ts
import { verifyStore } from 'pglite-cipher';

const result = await verifyStore(backend, key);
console.log(result.ok, result.problems); // each problem: a record key and a reason, never a file path
```

## A store that isn't complete: `IncompleteStoreError`

- **`rotation: false`:** a create that never finished, or a store with its header or root gone. Nothing in it can be opened. Ask the user (if it could have held data), then `await backend.clear()` and create again.
- **`rotation: true`:** a rotation was interrupted on a single backend. Open again with `openOrigin`, which resumes it. Never clear it.

## Storage full (quota)

If the browser refuses a write, the sync rejects with the browser's error (a `QuotaExceededError` `DOMException`). A commit is all or nothing, so the store stays as it was at the last good sync. Free space, or ask for persistent storage with `navigator.storage.persist()`, then sync again. A close whose sync fails also rejects. Drop that PGlite instance and open the store again; it opens at the last sync.

## The others

| Error | What to do |
|---|---|
| `StoreMissingError` | `mode: 'open'` found nothing. Create it, or report the missing data |
| `StoreExistsError` | `mode: 'create'` found a store. Open it instead |
| `StaleWriterError` | Another tab wrote the store. Close and reopen; unsynced changes are lost |
| `UnsupportedFormatError` | A newer version wrote the store. Update the app; never reset |
| `StoreFullError` | A sync would pass the format's limits. Nothing was written |
| `KeyChangeUnknownError` | Keep both keys; call `changeKey` again |
| `CryptoSelfTestError` | WebCrypto is broken on this platform. Don't use encryption here |

The full table is in [Usage](../usage.md#errors-and-what-an-app-should-do).
