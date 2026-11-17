// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// A backend wrapper that fails on purpose, for crash tests. Exported as `pglite-cipher/testing`.
import type { BlockId, CommitBatch, RecordKey, Slot, StorageBackend } from './backend.ts';
import { ROOT } from './backend.ts';

export interface FaultPlan {
  /**
   * Which commit fails (1 = the first), and how: `before` rejects and writes nothing; `after` applies, then rejects;
   * `hang` never settles and writes nothing (a killed process).
   */
  commit?: { n: number; mode: 'before' | 'after' | 'hang' };
  /** Which `get(2)` call rejects (1 = the first). */
  rootRead?: number;
}

export class InjectedFault extends Error {
  override name = 'InjectedFault';
}

const copy = (batch: CommitBatch): CommitBatch => ({
  ...batch,
  ...(batch.expectRoot ? { expectRoot: batch.expectRoot.slice() } : {}),
  puts: batch.puts.map(([key, value]): [RecordKey, Uint8Array] => [key, value.slice()]),
  deletes: [...batch.deletes],
});

export class FaultyBackend implements StorageBackend {
  readonly committed: CommitBatch[] = [];
  readonly #inner: StorageBackend;
  readonly #plan: FaultPlan;
  #commits = 0;
  #rootReads = 0;

  constructor(inner: StorageBackend, plan: FaultPlan = {}) {
    this.#inner = inner;
    this.#plan = plan;
  }

  /** The state as of a crash after commit `k`. */
  async replayInto(target: StorageBackend, k: number): Promise<void> {
    for (const batch of this.committed.slice(0, k)) await target.commit(batch);
  }

  async commit(batch: CommitBatch): Promise<void> {
    const n = ++this.#commits;
    const mode = this.#plan.commit?.n === n ? this.#plan.commit.mode : null;
    if (mode === 'before') throw new InjectedFault(`commit ${String(n)} failed before writing`);
    if (mode === 'hang') return new Promise<never>(() => undefined);
    const recorded = copy(batch);
    await this.#inner.commit(batch);
    this.committed.push(recorded);
    if (mode === 'after') throw new InjectedFault(`commit ${String(n)} failed after writing`);
  }

  get(slot: Slot): Promise<Uint8Array | undefined> {
    if (slot === ROOT && ++this.#rootReads === this.#plan.rootRead) {
      return Promise.reject(new InjectedFault(`root read ${String(this.#rootReads)} failed`));
    }
    return this.#inner.get(slot);
  }

  isEmpty(): Promise<boolean> {
    return this.#inner.isEmpty();
  }

  count(): Promise<number> {
    return this.#inner.count();
  }

  getMany(ids: BlockId[]): Promise<Array<Uint8Array | undefined>> {
    return this.#inner.getMany(ids);
  }

  readRange(after: BlockId | null, limit: number): Promise<Array<[BlockId, Uint8Array]>> {
    return this.#inner.readRange(after, limit);
  }

  clear(): Promise<void> {
    return this.#inner.clear();
  }

  async destroy(): Promise<void> {
    await this.#inner.destroy?.();
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}
