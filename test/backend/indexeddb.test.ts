// Conformance suite on IndexedDB (fake-indexeddb in Node), plus names, object stores, transactions, durability, versionchange.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockId, CommitBatch } from '../../src/backend/backend.ts';
import { runBackendConformance, testBlockId, testValue } from '../../src/backend/conformance.ts';
import { IndexedDbBackend } from '../../src/backend/indexeddb.ts';
import { freshName } from './names.ts';

runBackendConformance('IndexedDbBackend', () => new IndexedDbBackend(freshName()));

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('request failed'));
    };
  });

const rawOpen = (name: string): Promise<IDBDatabase> => request(indexedDB.open(name));

const puts = (from: number, n: number, length = 16): Array<[BlockId, Uint8Array]> =>
  Array.from({ length: n }, (_, i): [BlockId, Uint8Array] => [testBlockId(from + i), testValue(from + i, length)]);

describe('IndexedDbBackend only', () => {
  const backends: IndexedDbBackend[] = [];
  const make = (name = freshName()) => {
    const backend = new IndexedDbBackend(name);
    backends.push(backend);
    return backend;
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const backend of backends.splice(0)) await backend.close();
  });

  it('adds nothing readable: the exact name, one store `kv`, no index, only slot and block keys', async () => {
    const name = `data-${freshName()}`;
    const b = make(name);
    await b.commit({ puts: [[0, testValue(0)], [1, testValue(1)], [2, testValue(2)], ...puts(0, 30)], deletes: [], durability: 'strict' });
    await b.commit({ puts: puts(30, 5), deletes: [testBlockId(3)], durability: 'relaxed' });

    const names = (await indexedDB.databases()).map((d) => d.name ?? '');
    expect(names).toContain(name);
    expect(names.filter((n) => n.includes(name))).toEqual([name]);

    const db = await rawOpen(name);
    try {
      expect([...db.objectStoreNames]).toEqual(['kv']);
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      expect(store.indexNames.length).toBe(0);
      expect(store.keyPath).toBeNull();
      expect(store.autoIncrement).toBe(false);
      const keys = await request(store.getAllKeys());
      expect(keys).toHaveLength(3 + 34);
      for (const key of keys) {
        expect(key === 0 || key === 1 || key === 2 || (typeof key === 'string' && /^[0-9a-f]{32}$/.test(key))).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('writes only the bytes of a view into `kv`, not the rest of its buffer', async () => {
    const name = freshName();
    const b = make(name);
    const big = new Uint8Array(64).fill(0xa5);
    big.set(testValue(1), 8);
    await b.commit({ puts: [[2, big.subarray(8, 24)], [testBlockId(1), big.subarray(8, 24)]], deletes: [], durability: 'strict' });

    const db = await rawOpen(name);
    try {
      const raw = await request(db.transaction('kv', 'readonly').objectStore('kv').getAll());
      expect(raw).toHaveLength(2);
      for (const value of raw as Uint8Array[]) {
        expect(value).toEqual(testValue(1));
        expect(value.buffer.byteLength).toBe(16);
        expect(new Uint8Array(value.buffer)).not.toContain(0xa5);
      }
    } finally {
      db.close();
    }
  });

  it('a commit of 5,000 puts and 2,000 deletes lands in one transaction', async () => {
    const b = make();
    await b.commit({ puts: puts(0, 2000), deletes: [], durability: 'relaxed' });
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    await b.commit({
      puts: puts(10_000, 5000),
      deletes: Array.from({ length: 2000 }, (_, i) => testBlockId(i)),
      durability: 'relaxed',
    });
    expect(spy.mock.calls.filter((call) => call[1] === 'readwrite')).toHaveLength(1);
    spy.mockRestore();
    expect(await b.count()).toBe(5000);
    expect(await b.getMany([testBlockId(0), testBlockId(10_000), testBlockId(14_999)])).toEqual([
      undefined,
      testValue(10_000),
      testValue(14_999),
    ]);
  });

  it('passes the durability option through', async () => {
    const b = make();
    await b.count(); // open first, so the spy sees only the commits
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    for (const durability of ['strict', 'relaxed'] as const) {
      await b.commit({ puts: [[2, testValue(1)]], deletes: [], durability });
      expect(spy.mock.lastCall?.[2]).toEqual({ durability });
      expect((spy.mock.results.at(-1)?.value as IDBTransaction).durability).toBe(durability);
    }
  });

  it('a browser without the durability option still commits', async () => {
    const b = make();
    await b.count();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with apply on its own receiver
    const real = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase['transaction']>
    ) {
      if (args.length > 2) throw new TypeError('options not supported');
      return real.apply(this, args);
    });
    const batch: CommitBatch = { puts: [[2, testValue(3)], [testBlockId(3), testValue(3)]], deletes: [], durability: 'strict' };
    await b.commit(batch);
    vi.restoreAllMocks();
    expect(await b.get(2)).toEqual(testValue(3));
    expect(await b.getMany([testBlockId(3)])).toEqual([testValue(3)]);
  });

  it('a versionchange from another connection closes it, and later calls reject without recreating the database', async () => {
    const name = freshName();
    const b = make(name);
    await b.commit({ puts: [[2, testValue(1)]], deletes: [], durability: 'strict' });
    await request(indexedDB.deleteDatabase(name));
    await expect(b.get(2)).rejects.toThrow(/deleted or upgraded by another connection/);
    await expect(b.commit({ puts: [[2, testValue(2)]], deletes: [], durability: 'strict' })).rejects.toThrow(/another connection/);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(name);
  });

  it('a closed backend rejects later calls', async () => {
    const b = make();
    await b.count();
    await b.close();
    await expect(b.count()).rejects.toThrow(/closed/);
  });
});
