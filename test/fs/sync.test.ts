// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Sync pipeline: serialised syncs, relaxed and strict durability, a second writer, and the three upstream PGlite bugs (issues 1191, 1065, 1063) this filesystem must not depend on.
import { describe, expect, it } from 'vitest';
import type { BlockId, CommitBatch, Slot, StorageBackend } from '../../src/backend/backend.ts';
import { FaultyBackend, type FaultPlan } from '../../src/backend/faulty.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { StaleWriterError } from '../../src/format/errors.ts';
import { fsOf, inBrowser, inspect, newKey, openStore, PGDATA, records, rejection, restore, shared } from './helpers.ts';

interface Attempt {
  batch: CommitBatch;
  ok: boolean;
}

class Recorder implements StorageBackend {
  readonly attempts: Attempt[] = [];
  readonly #inner: StorageBackend;
  #gate: { entered: () => void; release: Promise<void> } | null = null;

  constructor(inner: StorageBackend) {
    this.#inner = inner;
  }

  holdNext(release: Promise<void>): Promise<void> {
    return new Promise((entered) => {
      this.#gate = { entered, release };
    });
  }

  async commit(batch: CommitBatch): Promise<void> {
    const gate = this.#gate;
    this.#gate = null;
    if (gate) {
      gate.entered();
      await gate.release;
    }
    const attempt = { batch, ok: false };
    this.attempts.push(attempt);
    await this.#inner.commit(batch);
    attempt.ok = true;
  }

  get = (slot: Slot) => this.#inner.get(slot);
  isEmpty = () => this.#inner.isEmpty();
  count = () => this.#inner.count();
  getMany = (ids: BlockId[]) => this.#inner.getMany(ids);
  readRange = (after: BlockId | null, limit: number) => this.#inner.readRange(after, limit);
  clear = () => this.#inner.clear();
  close = () => this.#inner.close();
}

const released = () => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function rowsOf(memory: MemoryBackend, key: CryptoKey): Promise<number> {
  const { pg } = await openStore({ backend: shared(await restore(await records(memory))), key, mode: 'open' });
  const r = (await pg.query<{ n: number; max: number | null }>('SELECT count(*)::int AS n, max(id) AS max FROM t')).rows[0];
  await pg.close();
  expect(r?.max ?? 0).toBe(r?.n);
  return r?.n ?? 0;
}

async function unhandledDuring(fn: () => Promise<void>): Promise<number> {
  let count = 0;
  const onNode = () => {
    count++;
  };
  const onBrowser = (event: PromiseRejectionEvent) => {
    count++;
    event.preventDefault();
  };
  if (inBrowser) globalThis.addEventListener('unhandledrejection', onBrowser);
  else process.on('unhandledRejection', onNode);
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    if (inBrowser) globalThis.removeEventListener('unhandledrejection', onBrowser);
    else process.off('unhandledRejection', onNode);
  }
  return count;
}

describe('sync', () => {
  it('with relaxed durability, writes made during a slow commit wait for the next sync', async () => {
    const memory = new MemoryBackend();
    const key = await newKey();
    const recorder = new Recorder(shared(memory));
    const { pg, fs } = await openStore({ backend: recorder, key, pglite: { relaxedDurability: true } });
    await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text)');
    await fs.syncToFs(false);
    const gate = released();
    const entered = recorder.holdNext(gate.promise);
    await pg.exec(`INSERT INTO t SELECT i, md5(i::text) FROM generate_series(1, 10) i`);
    await entered;
    for (let i = 11; i <= 30; i++) await pg.exec(`INSERT INTO t VALUES (${String(i)}, 'later')`);
    const done = recorder.attempts.length;
    gate.release();
    await expect.poll(() => recorder.attempts.length > done && recorder.attempts[done]?.ok).toBe(true);
    const asOfCommit = new MemoryBackend();
    for (const a of recorder.attempts.slice(0, done + 1)) await asOfCommit.commit(a.batch);
    expect(await rowsOf(asOfCommit, key)).toBe(10);
    await fs.syncToFs(false);
    expect(await rowsOf(memory, key)).toBe(30);
    await pg.close();
  }, 60_000);

  it('a second writer: the first to commit wins, the other stops syncing and leaves no record', async () => {
    const memory = new MemoryBackend();
    const key = await newKey();
    const first = await openStore({ backend: shared(memory), key });
    await first.pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text)');
    await first.pg.close();

    const fatal: Error[] = [];
    const recorder = new Recorder(shared(memory));
    const b = await openStore({ backend: recorder, key, mode: 'open', onFatal: (e) => fatal.push(e) });
    // A opens after B and commits at its start: B's view of the store is now old.
    const a = await openStore({ backend: shared(memory), key, mode: 'open' });
    const before = new Set((await records(memory)).keys());
    await rejection(b.pg.exec(`INSERT INTO t VALUES (2, 'from b')`), StaleWriterError);
    expect(fatal.map((e) => e.name)).toEqual(['StaleWriterError']);
    fsOf(b.pg).writeFile(`${PGDATA}/b-file`, new Uint8Array(100));
    await rejection(b.fs.syncToFs(false), StaleWriterError);
    await b.fs.syncToFs(true);
    expect(fatal).toHaveLength(1);
    const drawnByB = recorder.attempts
      .filter((t) => !t.ok)
      .flatMap((t) => t.batch.puts.map(([k]) => k))
      .filter((k) => !before.has(k));
    expect(drawnByB.length).toBeGreaterThan(0);
    await b.pg.close();

    await a.pg.exec(`INSERT INTO t VALUES (1, 'from a')`);
    await a.pg.close();
    const keys = new Set((await records(memory)).keys());
    expect(drawnByB.filter((k) => keys.has(k))).toEqual([]);
    const c = await openStore({ backend: shared(memory), key, mode: 'open' });
    expect((await c.pg.query('SELECT id, v FROM t ORDER BY id')).rows).toEqual([{ id: 1, v: 'from a' }]);
    await c.pg.close();
  }, 60_000);

  it('#1191: two syncs called while the first is in flight both settle after the second one’s changes', async () => {
    const memory = new MemoryBackend();
    const key = await newKey();
    const recorder = new Recorder(shared(memory));
    const { pg, fs } = await openStore({ backend: recorder, key });
    const FS = fsOf(pg);
    const gate = released();
    const entered = recorder.holdNext(gate.promise);
    FS.writeFile(`${PGDATA}/first`, new Uint8Array(10).fill(1));
    const p1 = fs.syncToFs();
    await entered;
    FS.writeFile(`${PGDATA}/second`, new Uint8Array(10).fill(2));
    const p2 = fs.syncToFs();
    gate.release();
    const paths = async () => [...(await inspect(memory, key)).table.files.values()].map((f) => f.path);
    await p1;
    expect(await paths()).toContain('second');
    await p2;
    expect(fs.hasDirty()).toBe(false);
    await pg.close();
  }, 60_000);

  it('#1191: a sync called in any tick while the running one finishes still commits its changes', async () => {
    const { pg, fs } = await openStore({ backend: shared(new MemoryBackend()), key: await newKey() });
    const FS = fsOf(pg);
    await fs.syncToFs();
    for (let k = 0; k <= 20; k++) {
      // Nothing is dirty: this sync is microtasks only, and the late call lands k ticks into it.
      const first = fs.syncToFs();
      let tick = Promise.resolve();
      for (let i = 0; i < k; i++) tick = tick.then(() => undefined);
      const late = tick.then(() => {
        FS.writeFile(`${PGDATA}/late-${String(k)}`, new Uint8Array(10).fill(k));
        return fs.syncToFs();
      });
      await Promise.all([first, late]);
      expect(fs.hasDirty(), `k = ${String(k)}`).toBe(false);
    }
    await pg.close();
  }, 60_000);

  it('#1065: a transaction left unsynced is visible through hasDirty() and persisted by syncToFs()', async () => {
    const memory = new MemoryBackend();
    const key = await newKey();
    const { pg, fs } = await openStore({ backend: shared(memory), key });
    await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text)');
    await pg.transaction(async (tx) => {
      await tx.query(`INSERT INTO t SELECT i, 'tx' FROM generate_series(1, 5) i`);
    });
    if (fs.hasDirty()) await fs.syncToFs();
    expect(fs.hasDirty()).toBe(false);
    // A copy of the store as it is now, without the sync that close would make.
    expect(await rowsOf(memory, key)).toBe(5);
    await pg.close();
  }, 60_000);

  it('#1063: a failed background sync is no unhandled rejection, and the next sync persists everything', async () => {
    const memory = new MemoryBackend();
    const key = await newKey();
    const plan: FaultPlan = {};
    const faulty = new FaultyBackend(shared(memory), plan);
    const recorder = new Recorder(faulty);
    const { pg, fs } = await openStore({ backend: recorder, key, pglite: { relaxedDurability: true } });
    await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text)');
    await fs.syncToFs(false);
    const unhandled = await unhandledDuring(async () => {
      plan.commit = { n: recorder.attempts.length + 1, mode: 'before' };
      await pg.exec(`INSERT INTO t SELECT i, 'x' FROM generate_series(1, 5) i`);
      await expect.poll(() => recorder.attempts.some((a) => !a.ok)).toBe(true);
      expect(fs.hasDirty()).toBe(true);
      await pg.exec(`INSERT INTO t SELECT i, 'y' FROM generate_series(6, 9) i`);
      await fs.syncToFs(false);
    });
    expect(unhandled).toBe(0);
    expect(fs.hasDirty()).toBe(false);
    expect(await rowsOf(memory, key)).toBe(9);
    await pg.close();
  }, 60_000);

  it('syncToFs(false) commits strict, syncToFs(true) relaxed, and closeFs strict', async () => {
    const recorder = new Recorder(shared(new MemoryBackend()));
    const { pg, fs } = await openStore({ backend: recorder, key: await newKey() });
    const FS = fsOf(pg);
    const last = () => recorder.attempts.at(-1)?.batch.durability;
    FS.writeFile(`${PGDATA}/strict`, new Uint8Array(1));
    await fs.syncToFs(false);
    expect(last()).toBe('strict');
    FS.writeFile(`${PGDATA}/relaxed`, new Uint8Array(1));
    await fs.syncToFs(true);
    expect(last()).toBe('relaxed');
    FS.writeFile(`${PGDATA}/on-close`, new Uint8Array(1));
    const n = recorder.attempts.length;
    await pg.close();
    expect(recorder.attempts.length).toBeGreaterThan(n);
    expect(last()).toBe('strict');
  }, 60_000);

  const commitsOf = (recorder: Recorder, from: number) => recorder.attempts.slice(from).map((a) => [a.batch.durability, a.ok]);

  it('a strict sync during a relaxed one waits for it, then commits strict before it resolves', async () => {
    const recorder = new Recorder(shared(new MemoryBackend()));
    const { pg, fs } = await openStore({ backend: recorder, key: await newKey() });
    const FS = fsOf(pg);
    const from = recorder.attempts.length;
    const gate = released();
    const entered = recorder.holdNext(gate.promise);
    FS.writeFile(`${PGDATA}/relaxed`, new Uint8Array(10).fill(1));
    const relaxed = fs.syncToFs(true);
    await entered;
    const strict = fs.syncToFs(false).then(() => commitsOf(recorder, from));
    gate.release();
    expect(await strict).toEqual([
      ['relaxed', true],
      ['strict', true],
    ]);
    await relaxed;
    await pg.close();
  }, 60_000);

  it('closeFs during a relaxed sync waits for it, then commits strict', async () => {
    const recorder = new Recorder(shared(new MemoryBackend()));
    const { pg, fs } = await openStore({ backend: recorder, key: await newKey(), pglite: { relaxedDurability: true } });
    const FS = fsOf(pg);
    await fs.syncToFs(false);
    const from = recorder.attempts.length;
    const gate = released();
    const entered = recorder.holdNext(gate.promise);
    FS.writeFile(`${PGDATA}/relaxed`, new Uint8Array(10).fill(1));
    void fs.syncToFs(true);
    await entered;
    const closeFs = fs.closeFs.bind(fs);
    const closing = released();
    fs.closeFs = () => {
      closing.release();
      return closeFs();
    };
    const closed = pg.close();
    await closing.promise;
    gate.release();
    await closed;
    const commits = commitsOf(recorder, from);
    expect(commits[0]).toEqual(['relaxed', true]);
    expect(commits.at(-1)).toEqual(['strict', true]);
  }, 60_000);

  it('strict syncs that one strict commit covers add no commit each', async () => {
    const recorder = new Recorder(shared(new MemoryBackend()));
    const { pg, fs } = await openStore({ backend: recorder, key: await newKey() });
    const FS = fsOf(pg);
    const from = recorder.attempts.length;
    const gate = released();
    const entered = recorder.holdNext(gate.promise);
    FS.writeFile(`${PGDATA}/relaxed`, new Uint8Array(10).fill(1));
    const relaxed = fs.syncToFs(true);
    await entered;
    const strict = [fs.syncToFs(false), fs.syncToFs(false), fs.syncToFs(false)];
    gate.release();
    await Promise.all([relaxed, ...strict]);
    await Promise.all([fs.syncToFs(false), fs.syncToFs(false)]);
    expect(commitsOf(recorder, from)).toEqual([
      ['relaxed', true],
      ['strict', true],
    ]);
    await pg.close();
  }, 60_000);
});
