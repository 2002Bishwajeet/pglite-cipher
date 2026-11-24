// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Rotation crash matrix: for every k, the stores after a kill at write k open to the step-1 state before the switch commit, the catch-up snapshot after it, with one store and no orphan record.
// Browser: every tenth k and the two around the switch. CIPHER_LONG: a 100 MB store and every k.
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { CommitBatch } from '../../src/backend/backend.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { inBrowser, restore, shared } from '../fs/helpers.ts';
import { LONG, timeout } from '../long.ts';
import { baseStore, expectOneStore, Logged, openPair, replay, tablesOf, type Event } from './helpers.ts';

const rowsOf = async (pg: PGlite, table: string) =>
  ((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0] as { n: number }).n;

describe('rotation crash matrix', () => {
  it('a kill at any write of a rotation opens to a consistent database, and leaves one store', { timeout: timeout(1_200_000, 15) }, async () => {
    // 100,000 rows of 1,024 characters: about 100 MB of heap.
    const { key, recs } = await (LONG ? baseStore(8192, 100_000, 32) : baseStore(8192));
    const journal: Event[] = [];
    let pg: PGlite | null = null;
    let copying = true;
    let written = 0;
    const between = async (batch: CommitBatch) => {
      if (!copying || batch.puts.some(([k]) => typeof k === 'number')) return;
      await (pg as PGlite).exec(`INSERT INTO r VALUES (${String(++written)})`);
    };
    const pair = [new Logged(shared(await restore(recs)), 0, journal), new Logged(shared(new MemoryBackend()), 1, journal, between)] as const;
    const opened = await openPair(pair, key);
    pg = opened.pg;
    await pg.exec('CREATE TABLE r (i int PRIMARY KEY)');
    // Read before the sync: the first scan sets hint bits on every page, and those writes must not fall into the rotation.
    const base = await tablesOf(pg);
    await opened.fs.syncToFs(false);
    const start = journal.length;
    await opened.fs.rotateDataKey({
      onProgress: (p) => {
        if (p.phase === 'copy' && p.done === p.total) copying = false;
      },
    });
    expect(written).toBeGreaterThanOrEqual(3);
    const rotated = await tablesOf(pg);
    await pg.exec('INSERT INTO r VALUES (-1)');
    await opened.fs.syncToFs(false);
    const end = journal.length;
    await pg.close();

    // The switch: root put into the new store; step 8 then retires and clears the old one, then the sync.
    const rootOf = (e: Event | undefined) => (e !== undefined && 'batch' in e ? e.batch.puts.find(([k]) => k === 2)?.[1] : undefined);
    const switchAt = journal.findIndex((e, i) => i >= start && e.slot === 1 && rootOf(e) !== undefined) + 1;
    expect(switchAt).toBeGreaterThan(start);
    expect(journal[switchAt]).toMatchObject({ slot: 0, batch: { expectRoot: rootOf(journal[start]), deletes: [] } });
    expect(rootOf(journal[switchAt])).toBeDefined();
    expect(journal[switchAt + 1]).toEqual({ slot: 0, clear: true });
    expect(end).toBe(switchAt + 4);
    expect(journal[start]).toMatchObject({ slot: 0 });
    expect(journal.slice(start + 1, start + 2 + written).every((e) => e.slot === 1)).toBe(true);
    expect(end - start).toBeGreaterThanOrEqual(written + 5);

    const states: number[] = [];
    for (let k = start; k <= end; k++) if (LONG || !inBrowser || k % 10 === 0 || k === switchAt - 1 || k === switchAt) states.push(k);
    for (const k of states) {
      const stores = [await restore(recs), new MemoryBackend()] as const;
      await replay(journal, k, stores);
      const reopened = await openPair([shared(stores[0]), shared(stores[1])], key, { mode: 'open' });
      const want = k < switchAt ? base : rotated;
      const tables = await tablesOf(reopened.pg);
      if (k < end - 1) expect(tables, `state ${String(k)}`).toEqual(want);
      else expect(await rowsOf(reopened.pg, 'r'), `state ${String(k)}`).toBe(written + 1);
      await expectOneStore(stores, reopened);
      await reopened.pg.close();
    }
  });
});
