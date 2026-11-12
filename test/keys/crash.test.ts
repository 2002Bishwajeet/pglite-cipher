// The rotation crash matrix. One rotation over a pair is recorded write by write (every commit and
// clear, on both stores, in order), with rows written between the batches of the copy, and one sync
// after. For every k the stores as a kill after write k leaves them are opened: the database is the
// state of step 1 before the switch commit, the catch-up snapshot after it (with the rows written
// during the rotation), and the open leaves one store, with no record nobody owns. In the browser,
// every tenth k and the two around the switch.
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { CommitBatch } from '../../src/backend/backend.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { inBrowser, restore, shared } from '../fs/helpers.ts';
import { baseStore, expectOneStore, Logged, openPair, replay, tablesOf, type Event } from './helpers.ts';

const rowsOf = async (pg: PGlite, table: string) =>
  ((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0] as { n: number }).n;

describe('rotation crash matrix', () => {
  it('a kill at any write of a rotation opens to a consistent database, and leaves one store', { timeout: 1_200_000 }, async () => {
    const { key, recs } = await baseStore(8192);
    const journal: Event[] = [];
    let pg: PGlite | null = null;
    let copying = true;
    let written = 0;
    // Into the new store, between the batches of the copy: a row each.
    const between = async (batch: CommitBatch) => {
      if (!copying || batch.puts.some(([k]) => typeof k === 'number')) return;
      await (pg as PGlite).exec(`INSERT INTO r VALUES (${String(++written)})`);
    };
    const pair = [new Logged(shared(await restore(recs)), 0, journal), new Logged(shared(new MemoryBackend()), 1, journal, between)] as const;
    const opened = await openPair(pair, key);
    pg = opened.pg;
    await pg.exec('CREATE TABLE r (i int PRIMARY KEY)');
    await opened.fs.syncToFs(false);
    const base = await tablesOf(pg);
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

    // The switch: the root put into the new store. Then step 8 clears the old one, and the sync follows.
    const switchAt = journal.findIndex((e, i) => i >= start && e.slot === 1 && 'batch' in e && e.batch.puts.some(([k]) => k === 2)) + 1;
    expect(switchAt).toBeGreaterThan(start);
    expect(journal[switchAt]).toEqual({ slot: 0, clear: true });
    expect(end).toBe(switchAt + 2);
    // Step 2's mark on the old store, then the header copies and the copy's batches on the new one,
    // then at least the catch-up's table, the switch, step 8's clear and the sync.
    expect(journal[start]).toMatchObject({ slot: 0 });
    expect(journal.slice(start + 1, start + 2 + written).every((e) => e.slot === 1)).toBe(true);
    expect(end - start).toBeGreaterThanOrEqual(written + 5);

    const states: number[] = [];
    for (let k = start; k <= end; k++) if (!inBrowser || k % 10 === 0 || k === switchAt - 1 || k === switchAt) states.push(k);
    for (const k of states) {
      const stores = [await restore(recs), new MemoryBackend()] as const;
      await replay(journal, k, stores);
      const reopened = await openPair([shared(stores[0]), shared(stores[1])], key, { mode: 'open' });
      const want = k < switchAt ? base : rotated;
      const tables = await tablesOf(reopened.pg);
      if (k < end) expect(tables, `state ${String(k)}`).toEqual(want);
      else expect(await rowsOf(reopened.pg, 'r'), `state ${String(k)}`).toBe(written + 1);
      await expectOneStore(stores, reopened);
      await reopened.pg.close();
    }
  });
});
