// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// FaultyBackend: each injected fault, the recorded batches, and replay to "as of commit K".
import { describe, expect, it } from 'vitest';
import type { CommitBatch, StorageBackend } from '../../src/backend/backend.ts';
import { runBackendConformance, testBlockId, testValue } from '../../src/backend/conformance.ts';
import { FaultyBackend, InjectedFault } from '../../src/backend/faulty.ts';
import { IndexedDbBackend } from '../../src/backend/indexeddb.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { freshName } from './names.ts';

runBackendConformance('FaultyBackend with no faults', () => new FaultyBackend(new MemoryBackend()));

/** Sync k writes root k and block k, and deletes block k - 1. */
const sync = (k: number): CommitBatch => ({
  expectRoot: k === 1 ? null : testValue(k - 1),
  puts: [
    [2, testValue(k)],
    [testBlockId(k), testValue(k)],
  ],
  deletes: k === 1 ? [] : [testBlockId(k - 1)],
  durability: 'relaxed',
});

const contents = async (b: StorageBackend) => ({
  root: await b.get(2),
  blocks: await b.readRange(null, 1000),
  count: await b.count(),
});

const settled = (p: Promise<unknown>) =>
  Promise.race([
    p.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise((resolve) => setTimeout(resolve, 50, 'pending')),
  ]);

describe('FaultyBackend', () => {
  it('(a) before: the Nth commit rejects and writes nothing', async () => {
    const inner = new MemoryBackend();
    const b = new FaultyBackend(inner, { commit: { n: 2, mode: 'before' } });
    await b.commit(sync(1));
    await expect(b.commit(sync(2))).rejects.toBeInstanceOf(InjectedFault);
    expect(await contents(inner)).toEqual({ root: testValue(1), blocks: [[testBlockId(1), testValue(1)]], count: 2 });
    expect(b.committed).toHaveLength(1);
    await b.commit(sync(2));
    expect(await inner.get(2)).toEqual(testValue(2));
  });

  it('(b) after: the Nth commit applies, then rejects', async () => {
    const inner = new MemoryBackend();
    const b = new FaultyBackend(inner, { commit: { n: 2, mode: 'after' } });
    await b.commit(sync(1));
    await expect(b.commit(sync(2))).rejects.toBeInstanceOf(InjectedFault);
    expect(await contents(inner)).toEqual({ root: testValue(2), blocks: [[testBlockId(2), testValue(2)]], count: 2 });
    expect(b.committed).toHaveLength(2);
  });

  it('(c) hang: the Nth commit never settles and writes nothing; the store reopens as before', async () => {
    const name = freshName();
    const b = new FaultyBackend(new IndexedDbBackend(name), { commit: { n: 2, mode: 'hang' } });
    await b.commit(sync(1));
    expect(await settled(b.commit(sync(2)))).toBe('pending');
    const reopened = new IndexedDbBackend(name);
    expect(await contents(reopened)).toEqual({ root: testValue(1), blocks: [[testBlockId(1), testValue(1)]], count: 2 });
    await b.close();
    await reopened.close();
  });

  it('a failed commit reports a stale writer from the inner backend, and records nothing', async () => {
    const b = new FaultyBackend(new MemoryBackend());
    await b.commit(sync(1));
    await expect(b.commit(sync(3))).rejects.toThrow(/root changed/);
    expect(b.committed).toHaveLength(1);
  });

  it('the Nth get(2) rejects; other slots and other reads do not count', async () => {
    const b = new FaultyBackend(new MemoryBackend(), { rootRead: 2 });
    await b.commit(sync(1));
    expect(await b.get(2)).toEqual(testValue(1));
    expect(await b.get(0)).toBeUndefined();
    expect(await b.get(1)).toBeUndefined();
    await expect(b.get(2)).rejects.toBeInstanceOf(InjectedFault);
    expect(await b.get(2)).toEqual(testValue(1));
  });

  it('a fault on a commit and on a root read in one plan', async () => {
    const inner = new MemoryBackend();
    const b = new FaultyBackend(inner, { commit: { n: 1, mode: 'after' }, rootRead: 1 });
    await expect(b.commit(sync(1))).rejects.toBeInstanceOf(InjectedFault);
    await expect(b.get(2)).rejects.toBeInstanceOf(InjectedFault);
    expect(await inner.get(2)).toEqual(testValue(1));
  });

  it('replaying the first K recorded batches reproduces the state as of commit K', async () => {
    const b = new FaultyBackend(new MemoryBackend());
    const states = [await contents(b)];
    for (let k = 1; k <= 8; k++) {
      const batch = sync(k);
      await b.commit(batch);
      // The record is a copy: changing the caller's batch afterwards changes nothing.
      batch.puts[0]?.[1].fill(0xee);
      batch.puts.length = 0;
      states.push(await contents(b));
    }
    expect(b.committed).toHaveLength(8);
    for (let k = 0; k <= 8; k++) {
      const fresh = new MemoryBackend();
      await b.replayInto(fresh, k);
      expect(await contents(fresh)).toEqual(states[k]);
    }
    const idb = new IndexedDbBackend(freshName());
    await b.replayInto(idb, 5);
    expect(await contents(idb)).toEqual(states[5]);
    await idb.close();
  });
});
