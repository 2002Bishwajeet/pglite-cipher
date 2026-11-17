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

// Every byte array stored in a database with its record key, however the values are shaped.
async function records(name) {
  const db = await request(indexedDB.open(name));
  const out = [];
  const collect = (key, value, depth = 0) => {
    if (value instanceof Uint8Array) out.push({ key: String(key), bytes: value });
    else if (value instanceof ArrayBuffer) out.push({ key: String(key), bytes: new Uint8Array(value) });
    else if (value && typeof value === 'object' && depth < 3) for (const v of Object.values(value)) collect(key, v, depth + 1);
  };
  try {
    for (const name of db.objectStoreNames) {
      const store = db.transaction(name).objectStore(name);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      values.forEach((value, i) => collect(keys[i], value));
    }
  } finally {
    db.close();
  }
  return out;
}

function indexOf(bytes, needle) {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const ROW = 8;
const ROWS = 6;

// A few rows of one record: around the first match of `needle`, or from the start of the first block.
function view(list, needle) {
  for (const { key, bytes } of list) {
    const offset = indexOf(bytes, needle);
    if (offset < 0) continue;
    const start = Math.max(0, Math.floor(offset / ROW) * ROW - 2 * ROW);
    const end = Math.max(start + ROWS * ROW, Math.ceil((offset + needle.length) / ROW) * ROW + ROW);
    return { found: true, key, size: bytes.length, start, bytes: bytes.slice(start, end), match: [offset, offset + needle.length] };
  }
  const block = list.find((r) => /^[0-9a-f]{32}$/.test(r.key)) ?? list[0];
  return { found: false, key: block?.key ?? '', size: block?.bytes.length ?? 0, start: 0, bytes: block?.bytes.slice(0, ROWS * ROW) ?? new Uint8Array(), match: null };
}

/** Searches the raw IndexedDB bytes of both stores for `word` and returns the bytes to show. */
export async function proof(word) {
  const needle = new TextEncoder().encode(word);
  const plain = await records((await plainName()) ?? PLAIN);
  const encrypted = await records(ENCRYPTED);
  return {
    plain: { records: plain.length, ...view(plain, needle) },
    encrypted: { records: encrypted.length, ...view(encrypted, needle) },
  };
}

const firstKeys = async (name, n) => {
  const db = await request(indexedDB.open(name));
  try {
    const out = [];
    for (const store of db.objectStoreNames) out.push(...(await request(db.transaction(store).objectStore(store).getAllKeys(null, n))));
    return out.slice(0, n).map(String);
  } finally {
    db.close();
  }
};

/** The first `n` record keys of each store: file paths in the plain one, block ids in the encrypted one. */
export async function storeKeys(n = 6) {
  return { plain: await firstKeys((await plainName()) ?? PLAIN, n), encrypted: await firstKeys(ENCRYPTED, n) };
}

/** Flips one bit in one stored block, then reopens the encrypted store; says which byte changed and how the open ended. */
export async function tamper(key) {
  const db = await request(indexedDB.open(ENCRYPTED));
  let change;
  try {
    const store = db.transaction('kv', 'readwrite').objectStore('kv');
    const keys = await request(store.getAllKeys());
    const block = keys.find((k) => typeof k === 'string');
    const bytes = new Uint8Array(await request(store.get(block)));
    const offset = bytes.length - 1;
    const before = bytes[offset];
    bytes[offset] ^= 1;
    change = { key: block, size: bytes.length, offset, before, after: bytes[offset] };
    await request(store.put(bytes, block));
  } finally {
    db.close();
  }
  try {
    const { pg } = await openEncrypted(key);
    await pg.close();
    return { ...change, error: 'opened' };
  } catch (error) {
    return { ...change, error: error instanceof Error ? error.name : String(error) };
  }
}
