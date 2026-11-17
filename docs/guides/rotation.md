# Change the key and rotate the data key

There are two keys. Your key-encryption key (KEK) wraps a random data key, and the data key encrypts the records. That gives you two operations.

## Change the key (instant)

```ts
await fs.changeKey(newKey);
```

This re-wraps the same data key under `newKey`, which is one small write. Afterwards the old key no longer opens the store. Use it when the user changes their passphrase, or when you move the key to a new keychain entry.

**Limit:** anyone who kept a copy of the old store (or just its header) and has the old key can still read it, and any later copy too, because the data key is unchanged.

If the write fails and `changeKey` can't tell whether the new key landed, it rejects with `KeyChangeUnknownError`. Keep both keys, then call `changeKey` again or open with either one.

## Rotate the data key (slow, thorough)

```ts
import { EncryptedFs, IndexedDbBackend } from 'pglite-cipher';

const fs = new EncryptedFs({ backend: IndexedDbBackend.pair('data'), key, mode: 'open-or-create' });
// ...
await fs.rotateDataKey({
  onProgress: ({ phase, done, total }) => console.log(phase, done, total),
});
```

This draws a new data key, re-encrypts every record into the pair's other store, checks it, switches to it, and deletes the old one. It costs about one open plus one full write ([performance](../design/performance.md)). It needs the two-database pair (`IndexedDbBackend.pair`).

- **After a suspected exposure, do both:** first `changeKey(newKey)`, then `rotateDataKey()`. Only the rotation makes old copies useless.
- **There's no need to rotate on a schedule.** Each writer session already encrypts under its own subkey.
- **An interrupted rotation** (a crash, or a closed tab) needs nothing from you. The next open finishes it or rolls it back.
- **Writes during a rotation** become durable when it completes. A crash returns to the state when the rotation started.
