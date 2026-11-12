// The open state machine: every store state against every mode. A failed open throws its own error,
// changes nothing in the backend, creates nothing in MEMFS, and so never lets PGlite run initdb.
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import type { RecordKey, StorageBackend } from '../../src/backend/backend.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import type { OpenMode } from '../../src/encryptedFs.ts';
import type { Bytes } from '../../src/format/bytes.ts';
import {
  CorruptStoreError,
  CryptoSelfTestError,
  IncompleteStoreError,
  StoreExistsError,
  StoreMissingError,
  UnsupportedFormatError,
  WrongKeyError,
} from '../../src/format/errors.ts';
import { openHeader } from '../../src/format/keys.ts';
import { resetSelfTest } from '../../src/testing.ts';
import {
  headerWithVersion,
  newKey,
  openStore,
  PGDATA,
  records,
  rejection,
  resealRoot,
  restore,
  sameRecords,
  shared,
  WatchedFs,
} from './helpers.ts';

type ErrorType = abstract new (...args: never[]) => Error;
const MODES: readonly OpenMode[] = ['open', 'create', 'open-or-create'];

const put = (b: MemoryBackend, key: RecordKey, value: Uint8Array) => b.commit({ puts: [[key, value]], deletes: [], durability: 'relaxed' });
const del = (b: MemoryBackend, ...keys: RecordKey[]) => b.commit({ puts: [], deletes: keys, durability: 'relaxed' });

async function baseStore(): Promise<{ key: CryptoKey; recs: Map<RecordKey, Uint8Array> }> {
  const memory = new MemoryBackend();
  const key = await newKey();
  const { pg } = await openStore({ backend: shared(memory), key });
  await pg.exec(`CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t VALUES (1, 'one'), (2, 'two');`);
  await pg.close();
  return { key, recs: await records(memory) };
}

/** Opens in `mode` and expects `type`; the backend must be byte-identical and MEMFS untouched. */
async function expectRefused(memory: MemoryBackend, key: CryptoKey, mode: OpenMode, type: ErrorType): Promise<Error> {
  const before = await records(memory);
  const fs = new WatchedFs({ backend: shared(memory), key, mode });
  const error = await rejection(PGlite.create({ fs }), type);
  expect(sameRecords(await records(memory), before)).toBe(true);
  expect(fs.created).toEqual([]);
  expect(fs.moduleFs?.analyzePath(`${PGDATA}/PG_VERSION`).exists).toBe(false);
  return error;
}

describe('the open state machine', () => {
  it('a failed crypto self-test stops the open before the backend is touched', async () => {
    const memory = new MemoryBackend();
    const calls: string[] = [];
    const counted = new Proxy(memory, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as StorageBackend;
    const { subtle } = globalThis.crypto;
    const encrypt = subtle.encrypt.bind(subtle);
    vi.spyOn(subtle, 'encrypt').mockImplementation(async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      const out = new Uint8Array(await encrypt(...args));
      out[0] = (out[0] ?? 0) ^ 1;
      return out.buffer;
    });
    resetSelfTest();
    try {
      const key = await newKey();
      for (const mode of MODES) {
        const fs = new WatchedFs({ backend: counted, key, mode });
        await rejection(PGlite.create({ fs }), CryptoSelfTestError);
        expect(fs.created).toEqual([]);
      }
      expect(calls).toEqual([]);
      expect(await memory.isEmpty()).toBe(true);
    } finally {
      vi.restoreAllMocks();
      resetSelfTest();
    }
  }, 60_000);

  it('an empty backend: "open" refuses, "create" and "open-or-create" create', async () => {
    const key = await newKey();
    await expectRefused(new MemoryBackend(), key, 'open', StoreMissingError);
    for (const mode of ['create', 'open-or-create'] as const) {
      const memory = new MemoryBackend();
      const { pg } = await openStore({ backend: shared(memory), key, mode });
      expect((await pg.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
      await pg.close();
      expect(await memory.isEmpty()).toBe(false);
    }
  }, 60_000);

  it('a store that opens: "open" and "open-or-create" load it, "create" refuses', async () => {
    const { key, recs } = await baseStore();
    await expectRefused(await restore(recs), key, 'create', StoreExistsError);
    for (const mode of ['open', 'open-or-create'] as const) {
      const { pg } = await openStore({ backend: shared(await restore(recs)), key, mode });
      expect((await pg.query('SELECT v FROM t ORDER BY id')).rows).toEqual([{ v: 'one' }, { v: 'two' }]);
      await pg.close();
    }
  }, 60_000);

  it('a load is seen creating the tree (the watch the refusals rely on works)', async () => {
    const { key, recs } = await baseStore();
    const fs = new WatchedFs({ backend: shared(await restore(recs)), key, mode: 'open' });
    const pg = await PGlite.create({ fs });
    expect(fs.created).toContain(`${PGDATA}/PG_VERSION`);
    await pg.close();
  }, 60_000);

  it('a wrong key: WrongKeyError ("create": StoreExistsError), and the backend is unchanged', async () => {
    const { recs } = await baseStore();
    const other = await newKey();
    for (const mode of MODES) {
      await expectRefused(await restore(recs), other, mode, mode === 'create' ? StoreExistsError : WrongKeyError);
    }
  }, 60_000);

  const damages: Array<[string, (b: MemoryBackend, key: CryptoKey) => Promise<void>, ErrorType]> = [
    ['both header copies deleted', (b) => del(b, 0, 1), IncompleteStoreError],
    ['slot 2 deleted', (b) => del(b, 2), IncompleteStoreError],
    ['state "populating"', (b, key) => resealRoot(b, key, (r) => ({ ...r, state: 'populating' })), IncompleteStoreError],
    ['state "rotating"', (b, key) => resealRoot(b, key, (r) => ({ ...r, state: 'rotating' })), IncompleteStoreError],
    [
      'both header values truncated',
      async (b) => {
        const h = (await b.get(0)) as Uint8Array;
        await put(b, 0, h.slice(0, 167));
        await put(b, 1, h.slice(0, 167));
      },
      CorruptStoreError,
    ],
    [
      'the header copies overwritten with different random bytes',
      async (b) => {
        await put(b, 0, crypto.getRandomValues(new Uint8Array(168)));
        await put(b, 1, crypto.getRandomValues(new Uint8Array(168)));
      },
      CorruptStoreError,
    ],
    [
      'a root that does not open',
      async (b) => {
        const root = ((await b.get(2)) as Uint8Array).slice();
        root[100] = (root[100] ?? 0) ^ 1;
        await put(b, 2, root);
      },
      CorruptStoreError,
    ],
    [
      'a header that says format version 2',
      async (b, key) => {
        const header = await headerWithVersion(b, key, 2);
        await put(b, 0, header);
        await put(b, 1, header);
      },
      UnsupportedFormatError,
    ],
  ];

  for (const [name, damage, type] of damages) {
    it(`never initdb over data: ${name} gives ${type.name} in every mode`, async () => {
      const { key, recs } = await baseStore();
      for (const mode of MODES) {
        const memory = await restore(recs);
        await damage(memory, key);
        const error = await expectRefused(memory, key, mode, type);
        if (error instanceof IncompleteStoreError) expect(error.rotation).toBe(name.includes('rotating'));
      }
    }, 60_000);
  }

  it('repairs a damaged header copy at the next sync', async () => {
    const { key, recs } = await baseStore();
    const memory = await restore(recs);
    const copy0 = ((await memory.get(0)) as Uint8Array).slice();
    copy0[120] = (copy0[120] ?? 0) ^ 1;
    await put(memory, 0, copy0);
    const { pg, fs } = await openStore({ backend: shared(memory), key, mode: 'open' });
    await fs.syncToFs(false);
    const [c0, c1] = [(await memory.get(0)) as Bytes, (await memory.get(1)) as Bytes];
    expect(c0).toEqual(c1);
    for (const copy of [c0, c1]) expect((await openHeader(key, copy, copy)).headerRepairNeeded).toBe(false);
    expect(fs.hasDirty()).toBe(false);
    await pg.close();
  }, 60_000);

  it('does not detect a whole-store rollback: an earlier full copy opens with the older data', async () => {
    const { key, recs } = await baseStore();
    const memory = await restore(recs);
    const { pg } = await openStore({ backend: shared(memory), key, mode: 'open' });
    await pg.exec(`INSERT INTO t VALUES (3, 'three')`);
    await pg.close();
    const rolledBack = await openStore({ backend: shared(await restore(recs)), key, mode: 'open' });
    expect((await rolledBack.pg.query('SELECT count(*)::int AS n FROM t')).rows).toEqual([{ n: 2 }]);
    await rolledBack.pg.close();
  }, 60_000);
});
