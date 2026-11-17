# Encrypt a PGlite database in 5 minutes

## 1. Install

```sh
npm install pglite-cipher @electric-sql/pglite
```

## 2. Get a key

The key is 32 random bytes that you keep outside the database. In a real app they come from the OS keychain ([Where to keep the key](keys.md)). To try it out, generate one in the page:

```ts
const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
```

If you already have the 32 bytes, import them with `importKek(bytes)` instead. It zeroes `bytes` once imported.

## 3. Open, query, close

```ts
import { PGlite } from '@electric-sql/pglite';
import { EncryptedFs, IndexedDbBackend } from 'pglite-cipher';

const fs = new EncryptedFs({ backend: IndexedDbBackend.pair('data'), key, mode: 'open-or-create' });
const pg = await PGlite.create({ fs, relaxedDurability: true });

await pg.exec('CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text)');
await pg.query('INSERT INTO notes (body) VALUES ($1)', ['hello']);
console.log((await pg.query('SELECT body FROM notes')).rows);
```

`IndexedDbBackend.pair('data')` uses two IndexedDB databases, `data.a` and `data.b`, so that the data key can be rotated later ([rotation](rotation.md)).

## 4. Sync before the page goes away

PGlite does not always sync when it should, so sync yourself when it matters:

```ts
addEventListener('pagehide', () => {
  void fs.syncToFs(false); // strict: durable once it resolves
});

await pg.close(); // when you are done: syncs, then closes
```

That's it. Every file Postgres writes is now encrypted in IndexedDB, and a changed or missing block fails the next open. What the encryption does not cover is listed in the [README](../../README.md#what-it-does-not-protect).
