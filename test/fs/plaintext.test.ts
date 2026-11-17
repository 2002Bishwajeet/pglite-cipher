// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// Stored bytes show equal-size blocks under random ids, and no plain text, path or byte naming the format.
import { describe, expect, it } from 'vitest';
import type { RecordKey, StorageBackend } from '../../src/backend/backend.ts';
import { IndexedDbBackend } from '../../src/backend/indexeddb.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { fsOf, listTree, newKey, openStore, PGDATA, records, shared } from './helpers.ts';
import { runSteps } from './workload.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const utf16 = (s: string, littleEndian: boolean) => {
  const out = new Uint8Array(2 * s.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(2 * i, s.charCodeAt(i), littleEndian);
  return out;
};

/** The first needle found in any value or key, or null; needles are at least 5 bytes. */
function findAny(recs: Map<RecordKey, Uint8Array>, needles: Uint8Array[]): string | null {
  const prefix = (b: Uint8Array, i: number) => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0;
  const byPrefix = new Map<number, Uint8Array[]>();
  for (const n of needles) {
    if (n.length < 5) throw new Error('a needle shorter than 5 bytes would match random bytes');
    const p = prefix(n, 0);
    byPrefix.set(p, [...(byPrefix.get(p) ?? []), n]);
  }
  const search = (b: Uint8Array, where: string): string | null => {
    for (let i = 0; i + 4 <= b.length; i++) {
      const candidates = byPrefix.get(prefix(b, i));
      if (!candidates) continue;
      for (const n of candidates) if (n.every((x, j) => b[i + j] === x)) return `${new TextDecoder().decode(n)} in ${where}`;
    }
    return null;
  };
  for (const [key, value] of recs) {
    const found = search(utf8(String(key)), `key ${String(key)}`) ?? search(value, `value of ${String(key)}`);
    if (found) return found;
  }
  return null;
}

const stores: Array<[string, () => { connect: () => StorageBackend; idb: string | null }]> = [
  ['MemoryBackend', () => {
    const memory = new MemoryBackend();
    return { connect: () => shared(memory), idb: null };
  }],
  ['IndexedDbBackend', () => {
    const name = `plain-${crypto.randomUUID()}`;
    return { connect: () => new IndexedDbBackend(name), idb: name };
  }],
];

describe('no plaintext', () => {
  for (const [name, makeStore] of stores) {
    it(`stores neither the data, nor a path, nor a name of the format (${name})`, async () => {
      const marker = `zqx${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const { connect } = makeStore();
      const key = await newKey();
      const { pg } = await openStore({ backend: connect(), key });
      await pg.exec(`CREATE TABLE t_${marker} (id int PRIMARY KEY, c_${marker} text);`);
      await pg.exec(`INSERT INTO t_${marker} SELECT i, '${marker} ' || i FROM generate_series(1, 50) i;`);
      // Paths under PGDATA, absolute and relative; relative ones of 4 bytes or less match random bytes, so only their absolute forms are searched.
      const paths = [...listTree(fsOf(pg)).keys()];
      await pg.close();

      const texts = [marker, 'pglite', 'cipher', 'PGLCIPHR', 'PG_VERSION', ...paths.map((p) => `${PGDATA}/${p}`)];
      texts.push(...paths.filter((p) => utf8(p).length >= 5));
      const needles = texts.flatMap((t) => [utf8(t), utf16(t, true), utf16(t, false)]);
      expect(findAny(new Map([[2, utf16(`..${marker}..`, true)]]), needles)).not.toBeNull();
      expect(findAny(await records(connect()), needles)).toBeNull();
    }, 120_000);
  }
});

describe('nothing but blocks', () => {
  for (const [name, makeStore] of stores) {
    it(`after the 200-transaction workload the store is slots and equal-size blocks (${name})`, async () => {
      const { connect, idb } = makeStore();
      const key = await newKey();
      const blockSize = 32768;
      const { pg, fs } = await openStore({ backend: connect(), key, blockSize });
      await runSteps(pg, (_i, error) => {
        expect(error).toBeNull();
      });
      const recs = await records(connect());
      const { table, dataBlocks } = fs.stats();
      expect(await connect().count()).toBe(3 + table.blocks + dataBlocks);
      expect(recs.size).toBe(3 + table.blocks + dataBlocks);
      for (const [k, value] of recs) {
        if (k === 0 || k === 1) expect(value.length).toBe(168);
        else {
          expect(k === 2 || /^[0-9a-f]{32}$/.test(k)).toBe(true);
          expect(value.length).toBe(44 + blockSize);
        }
      }
      if (idb !== null) {
        const keys = await rawKeys(idb);
        expect(keys.length).toBe(recs.size);
        expect(keys.every((k) => k === 0 || k === 1 || k === 2 || (typeof k === 'string' && /^[0-9a-f]{32}$/.test(k)))).toBe(true);
      }
      await pg.close();
    }, 300_000);
  }

  it('two stores created from the same SQL script share no block id', async () => {
    const ids = async () => {
      const memory = new MemoryBackend();
      const { pg } = await openStore({ backend: shared(memory), key: await newKey() });
      await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT i, md5(i::text) FROM generate_series(1, 1000) i;');
      await pg.close();
      return new Set([...(await records(memory)).keys()].filter((k) => typeof k === 'string'));
    };
    const [a, b] = [await ids(), await ids()];
    expect(a.size).toBeGreaterThan(100);
    expect([...a].filter((id) => b.has(id))).toEqual([]);
  }, 120_000);
});

async function rawKeys(name: string): Promise<IDBValidKey[]> {
  const request = <T>(r: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      r.onsuccess = () => {
        resolve(r.result);
      };
      r.onerror = () => {
        reject(r.error ?? new Error('request failed'));
      };
    });
  const db = await request(indexedDB.open(name));
  expect([...db.objectStoreNames]).toEqual(['kv']);
  const keys = await request(db.transaction('kv').objectStore('kv').getAllKeys());
  db.close();
  return keys;
}
