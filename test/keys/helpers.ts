// Shared by the key tests: a base store, PGlite on a pair of backends, a backend whose commits can
// fail by number (through FaultyBackend), a journal of every write to a pair, and a database's
// tables by content.
import { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';
import type { BlockId, CommitBatch, RecordKey, Slot, StorageBackend } from '../../src/backend/backend.ts';
import { FaultyBackend } from '../../src/backend/faulty.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { EncryptedFs, type EncryptedFsOptions } from '../../src/encryptedFs.ts';
import type { BlockSize } from '../../src/format/codec.ts';
import { newKey, openStore, records, shared, template, type Opened } from '../fs/helpers.ts';

export interface Base {
  key: CryptoKey;
  recs: Map<RecordKey, Uint8Array>;
}

/** A store with a table `t` of `rows` rows, as records. */
export async function baseStore(blockSize: BlockSize, rows = 2000): Promise<Base> {
  const key = await newKey();
  const memory = new MemoryBackend();
  const { pg } = await openStore({ backend: shared(memory), key, blockSize });
  await pg.exec(`CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT i, md5(i::text) FROM generate_series(1, ${String(rows)}) i;`);
  await pg.close();
  return { key, recs: await records(memory) };
}

/**
 * PGlite on an EncryptedFs over a pair. Durability is relaxed, so queries do not wait for a sync a
 * rotation holds back. Two empty backends get a new store from the template.
 */
export async function openPair(
  pair: readonly [StorageBackend, StorageBackend],
  key: CryptoKey,
  options: Partial<EncryptedFsOptions> = {},
): Promise<Opened> {
  const fs = new EncryptedFs({ backend: pair, key, mode: 'open-or-create', ...options });
  const fresh = (await pair[0].isEmpty()) && (await pair[1].isEmpty());
  const pg = await PGlite.create({ fs, relaxedDurability: true, ...(fresh ? { loadDataDir: await template() } : {}) });
  return { pg, fs };
}

/** Every table of the public schema, by name, with a hash of its rows. */
export async function tablesOf(pg: PGlite): Promise<Record<string, string>> {
  const { rows } = await pg.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
  const out: Record<string, string> = {};
  for (const { name } of rows) {
    const r = await pg.query<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) AS h FROM "${name}" x`);
    out[name] = r.rows[0]?.h ?? '';
  }
  return out;
}

/** After an open: one store, with one record per table block and data block and nothing else; the other slot empty. */
export async function expectOneStore(pair: readonly [StorageBackend, StorageBackend], opened: Opened): Promise<StorageBackend> {
  const empty = [await pair[0].isEmpty(), await pair[1].isEmpty()];
  expect(empty.filter(Boolean).length).toBe(1);
  const store = pair[empty[0] ? 1 : 0];
  const { table, dataBlocks } = opened.fs.stats();
  expect(await store.count()).toBe(3 + table.blocks + dataBlocks);
  return store;
}

/** Commits counted across every backend that shares one counter; commit number `at` fails in `mode`. */
export interface FaultCounter {
  commits: number;
  at: number;
  mode: 'before' | 'after' | 'hang';
}

export class Faults implements StorageBackend {
  readonly #inner: StorageBackend;
  readonly #counter: FaultCounter;

  constructor(inner: StorageBackend, counter: FaultCounter) {
    this.#inner = inner;
    this.#counter = counter;
  }

  commit(batch: CommitBatch): Promise<void> {
    const counter = this.#counter;
    if (++counter.commits !== counter.at) return this.#inner.commit(batch);
    return new FaultyBackend(this.#inner, { commit: { n: 1, mode: counter.mode } }).commit(batch);
  }

  get = (slot: Slot) => this.#inner.get(slot);
  isEmpty = () => this.#inner.isEmpty();
  count = () => this.#inner.count();
  getMany = (ids: BlockId[]) => this.#inner.getMany(ids);
  readRange = (after: BlockId | null, limit: number) => this.#inner.readRange(after, limit);
  clear = () => this.#inner.clear();
  destroy = async () => {
    await this.#inner.destroy?.();
  };
  close = () => this.#inner.close();
}

/** A write to one slot of a pair: a commit, or a clear. */
export type Event = { slot: 0 | 1; batch: CommitBatch } | { slot: 0 | 1; clear: true };

const copyBatch = (batch: CommitBatch): CommitBatch => ({
  ...batch,
  ...(batch.expectRoot ? { expectRoot: batch.expectRoot.slice() } : {}),
  puts: batch.puts.map(([key, value]): [RecordKey, Uint8Array] => [key, value.slice()]),
  deletes: [...batch.deletes],
});

/** Logs every commit and clear that reaches `inner` into `journal`, in order; `after` runs once each commit is in. */
export class Logged implements StorageBackend {
  readonly #inner: StorageBackend;
  readonly #slot: 0 | 1;
  readonly #journal: Event[];
  readonly #after: ((batch: CommitBatch) => Promise<void>) | undefined;

  constructor(inner: StorageBackend, slot: 0 | 1, journal: Event[], after?: (batch: CommitBatch) => Promise<void>) {
    this.#inner = inner;
    this.#slot = slot;
    this.#journal = journal;
    this.#after = after;
  }

  async commit(batch: CommitBatch): Promise<void> {
    const copy = copyBatch(batch);
    await this.#inner.commit(batch);
    this.#journal.push({ slot: this.#slot, batch: copy });
    await this.#after?.(batch);
  }

  async clear(): Promise<void> {
    await this.#inner.clear();
    this.#journal.push({ slot: this.#slot, clear: true });
  }

  get = (slot: Slot) => this.#inner.get(slot);
  isEmpty = () => this.#inner.isEmpty();
  count = () => this.#inner.count();
  getMany = (ids: BlockId[]) => this.#inner.getMany(ids);
  readRange = (after: BlockId | null, limit: number) => this.#inner.readRange(after, limit);
  destroy = async () => {
    await this.#inner.destroy?.();
  };
  close = () => this.#inner.close();
}

/** Applies the first `k` events of a journal to `pair`: the stores as a kill after event `k` leaves them. */
export async function replay(journal: readonly Event[], k: number, pair: readonly [StorageBackend, StorageBackend]): Promise<void> {
  for (const event of journal.slice(0, k)) {
    const target = pair[event.slot];
    if ('clear' in event) await target.clear();
    else await target.commit(event.batch);
  }
}

/** Whether an IndexedDB database of this name exists. */
export async function databaseExists(name: string): Promise<boolean> {
  return (await indexedDB.databases()).some((d) => d.name === name);
}
