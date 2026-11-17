// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// Crash matrix over the 200-transaction workload (2,000 under CIPHER_LONG), one block size. Per commit K: (a) K fails before writing; (b) K applies but reports failure;
// (b′) as (b) and the following root read fails too; (c) the instance is dropped at K and the store as of K − 1 and K is opened fresh. Browser: every tenth K.
import { describe, expect, it } from 'vitest';
import type { BlockId, CommitBatch, Slot, StorageBackend } from '../../src/backend/backend.ts';
import { FaultyBackend, InjectedFault } from '../../src/backend/faulty.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import type { BlockSize } from '../../src/format/codec.ts';
import { expectStoreEquals, fsOf, inBrowser, newKey, openStore, shared, type Opened } from './helpers.ts';
import { LONG, timeout } from '../long.ts';
import { lastLogging, runSteps, stepsHeld, STEPS, workload } from './workload.ts';

const QUICK = inBrowser;
const EVERY = QUICK ? 10 : 1;
const WORKLOAD = LONG ? workload(2000) : STEPS;

type FaultMode = 'a' | 'b' | 'b′';

/** Routes each commit whose number `at` accepts through a one-shot FaultyBackend, so one run fails many commits. */
class FaultsAt implements StorageBackend {
  readonly faulted: number[] = [];
  readonly #inner: StorageBackend;
  readonly #at: (n: number) => boolean;
  readonly #mode: FaultMode;
  #calls = 0;
  /** In mode b′, the FaultyBackend whose root read fails next. */
  #rootRead: FaultyBackend | null = null;

  constructor(inner: StorageBackend, mode: FaultMode, at: (n: number) => boolean) {
    this.#inner = inner;
    this.#mode = mode;
    this.#at = at;
  }

  commit(batch: CommitBatch): Promise<void> {
    const n = ++this.#calls;
    if (!this.#at(n)) return this.#inner.commit(batch);
    this.faulted.push(n);
    const once = new FaultyBackend(this.#inner, {
      commit: { n: 1, mode: this.#mode === 'a' ? 'before' : 'after' },
      ...(this.#mode === 'b′' ? { rootRead: 1 } : {}),
    });
    if (this.#mode === 'b′') this.#rootRead = once;
    return once.commit(batch);
  }

  get(slot: Slot): Promise<Uint8Array | undefined> {
    const once = slot === 2 ? this.#rootRead : null;
    if (once) {
      this.#rootRead = null;
      return once.get(slot);
    }
    return this.#inner.get(slot);
  }

  isEmpty = (): Promise<boolean> => this.#inner.isEmpty();
  count = (): Promise<number> => this.#inner.count();
  getMany = (ids: BlockId[]) => this.#inner.getMany(ids);
  readRange = (after: BlockId | null, limit: number) => this.#inner.readRange(after, limit);
  clear = (): Promise<void> => this.#inner.clear();
  close = (): Promise<void> => this.#inner.close();
}

async function expectNoOrphans(memory: StorageBackend, opened: Opened): Promise<void> {
  const { table, dataBlocks } = opened.fs.stats();
  expect(await memory.count()).toBe(3 + table.blocks + dataBlocks);
}

interface Recording {
  key: CryptoKey;
  faulty: FaultyBackend;
  before: number[];
  after: number[];
}

async function record(blockSize: BlockSize): Promise<Recording> {
  const key = await newKey();
  const faulty = new FaultyBackend(new MemoryBackend());
  const { pg } = await openStore({ backend: faulty, key, blockSize, mode: 'create' });
  const before: number[] = [];
  const after: number[] = [];
  let last = faulty.committed.length;
  await runSteps(
    pg,
    (_i, error) => {
      expect(error).toBeNull();
      before.push(last);
      last = faulty.committed.length;
      after.push(last);
    },
    WORKLOAD,
  );
  await pg.close();
  return { key, faulty, before, after };
}

async function faultRun(blockSize: BlockSize, mode: FaultMode, at: (n: number) => boolean): Promise<number[]> {
  const key = await newKey();
  const memory = new MemoryBackend();
  const backend = new FaultsAt(shared(memory), mode, at);
  let opened: Opened;
  try {
    opened = await openStore({ backend, key, blockSize, mode: 'create' });
  } catch (error) {
    // A sync during PGlite's start failed, so it does not start (it awaits that sync).
    expect(error).toBeInstanceOf(InjectedFault);
    expect(backend.faulted).toEqual([1]);
    if (mode === 'a') expect(await memory.isEmpty()).toBe(true);
    else {
      const reopened = await openStore({ backend: shared(memory), key, mode: 'open' });
      expect(await stepsHeld(reopened.pg, WORKLOAD)).toBe(0);
      await expectNoOrphans(memory, reopened);
      await reopened.pg.close();
    }
    return backend.faulted;
  }
  const { pg, fs } = opened;
  let checked = 0;
  await runSteps(
    pg,
    async (_i, error) => {
      if (error !== null) {
        // The sync of this step failed: Postgres committed it in memory, the next sync carries it.
        expect(error).toBeInstanceOf(InjectedFault);
        expect(mode).not.toBe('b');
        return;
      }
      if (backend.faulted.length > checked) {
        expect(fs.hasDirty()).toBe(false);
        await expectStoreEquals(memory, key, fsOf(pg));
        checked = backend.faulted.length;
      }
    },
    WORKLOAD,
  );
  await pg.close().catch((error: unknown) => {
    expect(error).toBeInstanceOf(InjectedFault);
  });
  const reopened = await openStore({ backend: shared(memory), key, mode: 'open' });
  expect(await stepsHeld(reopened.pg, WORKLOAD)).toBe(lastLogging(WORKLOAD.length, WORKLOAD));
  await expectNoOrphans(memory, reopened);
  await reopened.pg.close();
  return backend.faulted;
}

export function crashMatrix(blockSize: BlockSize): void {
  let recording: Promise<Recording> | null = null;
  const recorded = () => (recording ??= record(blockSize));
  const limit = timeout(inBrowser ? 1_200_000 : 900_000, 20);

  describe(`crash matrix at ${String(blockSize)}-byte blocks`, () => {
    it('(c) the store as of K − 1 and as of K commits opens to an acknowledged prefix', { timeout: limit }, async () => {
      const { key, faulty, before, after } = await recorded();
      const total = faulty.committed.length;
      const states = new Set<number>();
      for (let k = EVERY; k <= total; k += EVERY) states.add(k - 1).add(k);
      for (const s of states) {
        const target = new MemoryBackend();
        await faulty.replayInto(target, s);
        const opened = await openStore({ backend: shared(target), key, mode: 'open-or-create' });
        const m = await stepsHeld(opened.pg, WORKLOAD);
        const acked = lastLogging(after.filter((n) => n <= s).length, WORKLOAD);
        const started = before.filter((n) => n < s).length;
        expect(m, `state ${String(s)}`).toBeGreaterThanOrEqual(acked);
        expect(m, `state ${String(s)}`).toBeLessThanOrEqual(started);
        await expectNoOrphans(target, opened);
        await opened.pg.close();
      }
    });

    for (const mode of ['a', 'b', 'b′'] as const) {
      it(`(${mode}) the instance keeps working, and the store is whole after the next sync`, { timeout: limit }, async () => {
        const total = (await recorded()).faulty.committed.length;
        const faulted = new Set<number>();
        const runs: Array<(n: number) => boolean> = QUICK
          ? [(n) => n % 10 === 0]
          : [(n) => n === 1, (n) => n % 2 === 0, (n) => n % 2 === 1 && n > 1];
        for (const at of runs) for (const n of await faultRun(blockSize, mode, at)) faulted.add(n);
        for (let k = EVERY; k <= total; k += EVERY) expect(faulted.has(k), `commit ${String(k)}`).toBe(true);
      });
    }
  });
}
