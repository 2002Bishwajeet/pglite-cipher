// The soak (CIPHER_LONG only): CIPHER_SOAK_MINUTES (30 by default) of a random workload on one store
// (inserts, updates, deletes, VACUUM, checkpoints, a table created and dropped, explicit syncs, close
// and reopen, injected commit failures), the same SQL on a shadow PGlite on MemoryFS. After every
// reopen: every table's checksum equals the shadow's, the store holds one record per table block and
// data block and nothing else, and the file table is at most twice as many blocks as a dense packing
// of the same files, plus 4. `trackingGaps` stays 0 throughout. A failure prints the seed and the
// last operations.
import { MemoryFS, PGlite } from '@electric-sql/pglite';
import { describe, expect, inject, it } from 'vitest';
import type { BlockId, CommitBatch, Slot, StorageBackend } from '../src/backend/backend.ts';
import { FaultyBackend, InjectedFault } from '../src/backend/faulty.ts';
import { MemoryBackend } from '../src/backend/memory.ts';
import { packEntries } from '../src/format/table.ts';
import { BLOCK_SIZES, inspect, newKey, openStore, template, type Opened } from './fs/helpers.ts';
import { tablesOf } from './keys/helpers.ts';
import { LONG } from './long.ts';

const MINUTES = inject('soakMinutes');
const SEED = inject('seed');

/** mulberry32: a small seeded generator, so a seed repeats the run. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Passes everything to `inner`; when armed, the next commit fails once, as FaultyBackend fails it. */
class Injector implements StorageBackend {
  armed: 'before' | 'after' | null = null;
  readonly #inner: StorageBackend;

  constructor(inner: StorageBackend) {
    this.#inner = inner;
  }

  commit(batch: CommitBatch): Promise<void> {
    const mode = this.armed;
    if (mode === null) return this.#inner.commit(batch);
    this.armed = null;
    return new FaultyBackend(this.#inner, { commit: { n: 1, mode } }).commit(batch);
  }

  get = (slot: Slot): Promise<Uint8Array | undefined> => this.#inner.get(slot);
  getMany = (ids: BlockId[]) => this.#inner.getMany(ids);
  readRange = (after: BlockId | null, limit: number) => this.#inner.readRange(after, limit);
  isEmpty = (): Promise<boolean> => this.#inner.isEmpty();
  count = (): Promise<number> => this.#inner.count();
  clear = (): Promise<void> => this.#inner.clear();
  // Shared by every instance of the run: closing one leaves the records.
  close = (): Promise<void> => Promise.resolve();
}

const SCHEMA = `
  CREATE TABLE a (id int PRIMARY KEY, v text NOT NULL, n int NOT NULL);
  CREATE INDEX a_n ON a (n);
  CREATE TABLE b (id int PRIMARY KEY, v text NOT NULL);
`;

describe.runIf(LONG)('soak', () => {
  it(`${String(MINUTES)} minutes of random work match a shadow database`, { timeout: (MINUTES + 30) * 60_000 }, async () => {
    const random = generator(SEED);
    const int = (n: number) => Math.floor(random() * n);
    const recent: string[] = [];
    const note = (line: string) => {
      recent.push(line);
      if (recent.length > 40) recent.shift();
    };
    const context = () => `seed ${String(SEED)}; the last operations:\n${recent.join('\n')}`;

    const memory = new MemoryBackend();
    const injector = new Injector(memory);
    const key = await newKey();
    const blockSize = BLOCK_SIZES[int(BLOCK_SIZES.length)] ?? 65536;
    note(`block size ${String(blockSize)}`);
    const shadow = await PGlite.create({ fs: new MemoryFS(), loadDataDir: await template() });
    let enc: Opened = await openStore({ backend: injector, key, blockSize, mode: 'create' });

    const tolerate = (error: unknown) => {
      // A failed sync: Postgres committed in memory, and the next sync carries it.
      if (!(error instanceof InjectedFault)) throw error;
      note('  its sync failed (injected)');
    };
    const both = async (sql: string) => {
      note(sql.trim());
      await shadow.exec(sql);
      await enc.pg.exec(sql).catch(tolerate);
    };
    const check = async () => {
      expect(await tablesOf(enc.pg), context()).toEqual(await tablesOf(shadow));
      const { table, dataBlocks } = enc.fs.stats();
      expect(await memory.count(), context()).toBe(3 + table.blocks + dataBlocks);
      const { table: files, ctx } = await inspect(memory, key);
      const dense = packEntries(files.files.values(), ctx.meta.blockSize).length;
      expect(table.blocks, `${context()}\ntable blocks ${String(table.blocks)}, dense ${String(dense)}`).toBeLessThanOrEqual(2 * dense + 4);
    };
    let reopens = 0;
    const reopen = async () => {
      note('close and reopen');
      injector.armed = null;
      await enc.pg.close();
      enc = await openStore({ backend: injector, key, mode: 'open' });
      reopens++;
      await check();
    };

    await both(SCHEMA);
    const ops: Array<[number, () => Promise<void>]> = [
      [30, () => {
        const lo = int(5000);
        return both(
          `INSERT INTO a SELECT g, repeat(md5((g + ${String(int(1e6))})::text), ${String(1 + int(100))}), ${String(int(100))} FROM generate_series(${String(lo)}, ${String(lo + int(50))}) g ON CONFLICT (id) DO UPDATE SET v = excluded.v, n = excluded.n`,
        );
      }],
      [10, () => both(`INSERT INTO b VALUES (${String(int(20_000))}, md5('${String(int(1e6))}')) ON CONFLICT (id) DO UPDATE SET v = excluded.v`)],
      [15, () => both(`UPDATE a SET n = n + 1, v = left(v, ${String(1 + int(3000))}) WHERE id % ${String(2 + int(40))} = ${String(int(2))}`)],
      [10, () => both(`DELETE FROM a WHERE id % ${String(5 + int(45))} = ${String(int(5))}`)],
      [5, () => both(`DELETE FROM b WHERE id % ${String(2 + int(20))} = 0`)],
      [3, () => both(['VACUUM', 'VACUUM a', 'VACUUM b'][int(3)] as string)],
      [2, () => both('VACUUM FULL a')],
      [3, () => both('CHECKPOINT')],
      [2, () => both(`CREATE TABLE IF NOT EXISTS c (id int, v text); INSERT INTO c SELECT g, md5(g::text) FROM generate_series(1, ${String(int(3000))}) g`)],
      [2, () => both('DROP TABLE IF EXISTS c')],
      [1, () => both('BEGIN; DELETE FROM a; DELETE FROM b; ROLLBACK;')],
      [6, async () => {
        const strict = random() < 0.5;
        note(`sync (${strict ? 'strict' : 'relaxed'})`);
        await enc.fs.syncToFs(!strict).catch(tolerate);
      }],
      [5, () => {
        injector.armed = random() < 0.5 ? 'before' : 'after';
        note(`the next commit fails ${injector.armed} writing`);
        return Promise.resolve();
      }],
      [2, reopen],
    ];
    const total = ops.reduce((n, [w]) => n + w, 0);
    const pick = () => {
      let r = int(total);
      for (const [w, op] of ops) {
        if (r < w) return op;
        r -= w;
      }
      throw new Error('unreachable');
    };

    const end = Date.now() + MINUTES * 60_000;
    let count = 0;
    while (Date.now() < end) {
      await pick()();
      count++;
      expect(enc.fs.stats().trackingGaps, context()).toBe(0);
    }
    await reopen();
    console.log(`soak: seed ${String(SEED)}, ${String(blockSize)}-byte blocks, ${String(count)} operations, ${String(reopens)} reopens`);
    await enc.pg.close();
    await shadow.close();
  });
});
