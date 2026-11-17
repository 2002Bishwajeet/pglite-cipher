// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// In-memory backend with IndexedDB semantics: sorted blocks beside three slots, expectRoot check, atomic commits,
// values copied in and out.
import { StaleWriterError } from '../format/errors.ts';
import {
  invalidKey,
  isRecordKey,
  ROOT,
  rootMatches,
  type BlockId,
  type CommitBatch,
  type RecordKey,
  type Slot,
  type StorageBackend,
} from './backend.ts';

export class MemoryBackend implements StorageBackend {
  readonly #slots: Array<Uint8Array | undefined> = [undefined, undefined, undefined];
  readonly #blocks = new Map<BlockId, Uint8Array>();
  #ids: BlockId[] = [];
  #closed = false;

  isEmpty(): Promise<boolean> {
    return this.#run(() => this.#count() === 0);
  }

  count(): Promise<number> {
    return this.#run(() => this.#count());
  }

  get(slot: Slot): Promise<Uint8Array | undefined> {
    return this.#run(() => this.#slots[slot]?.slice());
  }

  getMany(ids: BlockId[]): Promise<Array<Uint8Array | undefined>> {
    return this.#run(() => ids.map((id) => this.#blocks.get(id)?.slice()));
  }

  readRange(after: BlockId | null, limit: number): Promise<Array<[BlockId, Uint8Array]>> {
    return this.#run(() => {
      const start = after === null ? 0 : this.#firstAbove(after);
      return this.#ids
        .slice(start, start + Math.max(0, limit))
        .map((id): [BlockId, Uint8Array] => [id, (this.#blocks.get(id) as Uint8Array).slice()]);
    });
  }

  commit(batch: CommitBatch): Promise<void> {
    return this.#run(() => {
      // Every check runs before the first change.
      if (!rootMatches(this.#slots[ROOT], batch.expectRoot)) {
        throw new StaleWriterError('commit: the root changed since this writer read it');
      }
      if (!batch.deletes.every(isRecordKey) || !batch.puts.every(([key]) => isRecordKey(key))) throw invalidKey();
      const puts = batch.puts.map(([key, value]): [RecordKey, Uint8Array] => [key, value.slice()]);
      for (const key of batch.deletes) this.#delete(key);
      for (const [key, value] of puts) this.#put(key, value);
    });
  }

  clear(): Promise<void> {
    return this.#run(() => {
      this.#slots.fill(undefined);
      this.#blocks.clear();
      this.#ids = [];
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  #run<T>(fn: () => T): Promise<T> {
    return new Promise((resolve) => {
      if (this.#closed) throw new Error('MemoryBackend: the backend is closed');
      resolve(fn());
    });
  }

  #count(): number {
    return this.#slots.filter((v) => v !== undefined).length + this.#blocks.size;
  }

  #put(key: RecordKey, value: Uint8Array): void {
    if (typeof key === 'number') {
      this.#slots[key] = value;
      return;
    }
    if (!this.#blocks.has(key)) this.#ids.splice(this.#firstAbove(key), 0, key);
    this.#blocks.set(key, value);
  }

  #delete(key: RecordKey): void {
    if (typeof key === 'number') {
      this.#slots[key] = undefined;
      return;
    }
    if (this.#blocks.delete(key)) this.#ids.splice(this.#firstAbove(key) - 1, 1);
  }

  #firstAbove(id: BlockId): number {
    let lo = 0;
    let hi = this.#ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.#ids[mid] as BlockId) <= id) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
