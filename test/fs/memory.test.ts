// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// A load holds at most two pages of ciphertext (the next is read while one decrypts). The counting backend zero-fills
// every page but the latest once the next read starts, so a load using an older page or a view into it fails.
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { BlockId, CommitBatch, Slot, StorageBackend } from '../../src/backend/backend.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { EncryptedFs } from '../../src/encryptedFs.ts';
import { CorruptStoreError } from '../../src/format/errors.ts';
import { newKey, openStore, rejection, shared } from './helpers.ts';

class CountingBackend implements StorageBackend {
  readonly maxHeld = { table: 0, blocks: 0 };
  readonly pages = { table: 0, blocks: 0 };
  readonly #inner: StorageBackend;
  /** Control: zero-fill a page as soon as it is returned. */
  readonly #dropAtOnce: boolean;
  #held: Uint8Array[][] = [];
  #inFlight = 0;

  constructor(inner: StorageBackend, { dropAtOnce = false } = {}) {
    this.#inner = inner;
    this.#dropAtOnce = dropAtOnce;
  }

  getMany(ids: BlockId[]): Promise<Array<Uint8Array | undefined>> {
    return this.#read('table', () => this.#inner.getMany(ids));
  }

  readRange(after: BlockId | null, limit: number): Promise<Array<[BlockId, Uint8Array]>> {
    return this.#read('blocks', () => this.#inner.readRange(after, limit));
  }

  async #read<T extends ReadonlyArray<Uint8Array | undefined | [BlockId, Uint8Array]>>(phase: 'table' | 'blocks', read: () => Promise<T>): Promise<T> {
    // A new read: every page returned before the latest is dropped now. A read in flight counts as held.
    for (const page of this.#held.slice(0, -1)) for (const v of page) v.fill(0);
    this.#held = this.#held.slice(-1);
    this.#inFlight++;
    this.#note(phase);
    const values = await read();
    this.#inFlight--;
    this.pages[phase]++;
    const page: Uint8Array[] = [];
    for (const v of values) {
      const bytes = Array.isArray(v) ? v[1] : v;
      if (bytes) page.push(bytes);
    }
    this.#held.push(page);
    this.#note(phase);
    if (this.#dropAtOnce) for (const v of page) v.fill(0);
    return values;
  }

  #note(phase: 'table' | 'blocks'): void {
    this.maxHeld[phase] = Math.max(this.maxHeld[phase], this.#held.length + this.#inFlight);
  }

  get = (slot: Slot) => this.#inner.get(slot);
  isEmpty = () => this.#inner.isEmpty();
  count = () => this.#inner.count();
  commit = (batch: CommitBatch) => this.#inner.commit(batch);
  clear = () => this.#inner.clear();
  close = () => this.#inner.close();
}

describe('memory shape', () => {
  for (const blockSize of [8192, 65536] as const) {
    it(`a load holds at most two pages of ciphertext at a time (${String(blockSize)}-byte blocks)`, async () => {
      const memory = new MemoryBackend();
      const key = await newKey();
      const a = await openStore({ backend: shared(memory), key, blockSize });
      await a.pg.exec(`CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT i, md5(i::text) FROM generate_series(1, 5000) i;`);
      await a.pg.close();

      const counting = new CountingBackend(shared(memory));
      const b = await openStore({ backend: counting, key, mode: 'open' });
      expect((await b.pg.query('SELECT count(*)::int AS n FROM t')).rows).toEqual([{ n: 5000 }]);
      expect(counting.pages.table).toBeGreaterThanOrEqual(1);
      expect(counting.pages.blocks).toBeGreaterThan(2);
      expect(counting.maxHeld).toEqual({ table: 1, blocks: 2 });
      await b.pg.close();

      const fs = new EncryptedFs({ backend: new CountingBackend(shared(memory), { dropAtOnce: true }), key, mode: 'open' });
      await rejection(PGlite.create({ fs }), CorruptStoreError);
    }, 120_000);
  }
});
