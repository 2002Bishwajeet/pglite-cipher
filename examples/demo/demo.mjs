// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// The demo's three checks, kept apart from the page so test/demo.browser.test.ts can run them.
import { PGlite } from '@electric-sql/pglite';
import { EncryptedFs, IndexedDbBackend } from 'pglite-cipher';

const PLAIN = 'pglite-cipher-demo-plain';
const ENCRYPTED = 'pglite-cipher-demo';

export const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// PGlite names the idb:// database after its data directory; look it up rather than guess the prefix.
const plainName = async () => (await indexedDB.databases()).map((d) => d.name).find((n) => n?.endsWith(PLAIN));

const deleteDb = (name) =>
  new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onblocked = () => resolve();
    req.onerror = () => reject(req.error);
  });

export async function reset() {
  const plain = await plainName();
  if (plain) await deleteDb(plain);
  await deleteDb(ENCRYPTED);
}

const openPlain = async () => ({ pg: await PGlite.create(`idb://${PLAIN}`) });

async function openEncrypted(key) {
  const fs = new EncryptedFs({ backend: new IndexedDbBackend(ENCRYPTED), key, mode: 'open-or-create' });
  return { pg: await PGlite.create({ fs, relaxedDurability: true }), fs };
}

const timed = async (run) => {
  const start = performance.now();
  const result = await run();
  return [performance.now() - start, result];
};

/** Writes `rows` rows containing `word` to a plain and an encrypted store, then times reopening each. */
export async function speed(key, rows, word) {
  await reset();
  const result = {};
  for (const [kind, open] of [['plain', openPlain], ['encrypted', () => openEncrypted(key)]]) {
    const [writeMs] = await timed(async () => {
      const { pg } = await open();
      await pg.exec('CREATE TABLE notes (id serial PRIMARY KEY, body text)');
      await pg.query("INSERT INTO notes (body) SELECT $1 || ' ' || g FROM generate_series(1, $2::int) g", [word, rows]);
      await pg.close(); // syncs
    });
    const [openMs, { pg }] = await timed(open);
    const count = (await pg.query('SELECT count(*)::int AS n FROM notes')).rows[0].n;
    await pg.close();
    result[kind] = { writeMs, openMs, count };
  }
  return result;
}

// Every byte array stored in a database, however the values are shaped.
async function rawBytes(name) {
  const db = await request(indexedDB.open(name));
  const out = [];
  const collect = (value, depth = 0) => {
    if (value instanceof Uint8Array) out.push(value);
    else if (value instanceof ArrayBuffer) out.push(new Uint8Array(value));
    else if (value && typeof value === 'object' && depth < 3) for (const v of Object.values(value)) collect(v, depth + 1);
  };
  try {
    for (const store of db.objectStoreNames) {
      for (const value of await request(db.transaction(store).objectStore(store).getAll())) collect(value);
    }
  } finally {
    db.close();
  }
  return out;
}

function includes(chunks, word) {
  const needle = new TextEncoder().encode(word);
  return chunks.some((bytes) => {
    outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
      for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  });
}

const hex = (bytes) => Array.from(bytes.subarray(0, 24), (b) => b.toString(16).padStart(2, '0')).join(' ');

/** Searches the raw IndexedDB bytes of both stores for `word`. */
export async function proof(word) {
  const plain = await rawBytes((await plainName()) ?? PLAIN);
  const encrypted = await rawBytes(ENCRYPTED);
  return {
    plain: { records: plain.length, found: includes(plain, word) },
    encrypted: { records: encrypted.length, found: includes(encrypted, word), sample: encrypted[3] ? hex(encrypted[3]) : '' },
  };
}

/** Flips one bit in one stored block, then reopens the encrypted store; returns the error name. */
export async function tamper(key) {
  const db = await request(indexedDB.open(ENCRYPTED));
  try {
    const store = db.transaction('kv', 'readwrite').objectStore('kv');
    const keys = await request(store.getAllKeys());
    const block = keys.find((k) => typeof k === 'string');
    const bytes = new Uint8Array(await request(store.get(block)));
    bytes[bytes.length - 1] ^= 1;
    await request(store.put(bytes, block));
  } finally {
    db.close();
  }
  try {
    const { pg } = await openEncrypted(key);
    await pg.close();
    return 'opened';
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}
