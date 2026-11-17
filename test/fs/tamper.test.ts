// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// Every tampering with stored records is detected at open: modified, swapped, moved, deleted, added, replayed records and a deleted file.
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { RecordKey } from '../../src/backend/backend.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { toHex } from '../../src/format/bytes.ts';
import { CorruptStoreError } from '../../src/format/errors.ts';
import { BLOCK_SIZES, inspect, newKey, openStore, records, rejection, restore, sameRecords, shared, WatchedFs } from './helpers.ts';

type Recs = Map<RecordKey, Uint8Array>;

const value = (recs: Recs, key: RecordKey) => recs.get(key) as Uint8Array;

describe('tamper', () => {
  for (const blockSize of BLOCK_SIZES) {
    it(`detects every kind of tampering at ${String(blockSize)}-byte blocks`, async () => {
      const key = await newKey();
      const memory = new MemoryBackend();
      const a = await openStore({ backend: shared(memory), key, blockSize });
      await a.pg.exec(`
        CREATE TABLE a (id int PRIMARY KEY, v text);
        INSERT INTO a SELECT i, repeat(md5(i::text), 4) FROM generate_series(1, 3000) i;
        CREATE TABLE b (id int PRIMARY KEY, v text);
        INSERT INTO b SELECT i, md5(i::text) FROM generate_series(1, 500) i;
      `);
      await a.pg.close();
      const older = await records(memory);
      const b = await openStore({ backend: shared(memory), key, mode: 'open' });
      await b.pg.exec(`UPDATE a SET v = 'changed' WHERE id % 50 = 0; INSERT INTO b SELECT i, md5(i::text) FROM generate_series(501, 3000) i;`);
      await b.pg.close();
      const recs = await records(memory);

      const { table, root } = await inspect(memory, key);
      const tableIds = root.tableIds.map(toHex);
      const files = [...table.files.values()].filter((f) => f.ids.length > 0);
      const multi = files.find((f) => f.ids.length >= 2);
      const [f1, f2] = files;
      if (!multi || !f1 || !f2) throw new Error('the store needs files with blocks');
      const dataIds = new Set(files.flatMap((f) => f.ids.map(toHex)));
      const changed = (ids: Iterable<string>) => [...ids].find((id) => older.has(id) && !sameRecords(new Map([[id, value(older, id)]]), new Map([[id, value(recs, id)]])));
      const replayedData = changed(dataIds);
      const replayedTable = changed(tableIds);
      if (replayedData === undefined || replayedTable === undefined) throw new Error('no record was rewritten in place');
      expect(tableIds.length).toBeGreaterThanOrEqual(2);

      const swap = (r: Recs, x: RecordKey, y: RecordKey) => {
        const vx = value(r, x);
        r.set(x, value(r, y));
        r.set(y, vx);
      };
      const [t0, t1] = tableIds as [string, string];
      const d1 = toHex(f1.ids[0] as Uint8Array);
      const cases: Array<[string, (r: Recs) => void, boolean]> = [
        ['a bit flipped in a data block', (r) => { const v = value(r, d1).slice(); v[100] = (v[100] ?? 0) ^ 0x10; r.set(d1, v); }, false],
        ['two blocks of one file exchanged', (r) => { swap(r, toHex(multi.ids[0] as Uint8Array), toHex(multi.ids[1] as Uint8Array)); }, false],
        ['blocks of two files exchanged', (r) => { swap(r, d1, toHex(f2.ids[0] as Uint8Array)); }, false],
        ['two table blocks exchanged', (r) => { swap(r, t0, t1); }, true],
        ['a data block deleted', (r) => { r.delete(d1); }, false],
        ['a table block deleted', (r) => { r.delete(t1); }, true],
        ['every block of one file deleted', (r) => { for (const id of multi.ids) r.delete(toHex(id)); }, false],
        ['a data block replaced with its older value', (r) => { r.set(replayedData, value(older, replayedData)); }, false],
        ['a table block replaced with its older value', (r) => { r.set(replayedTable, value(older, replayedTable)); }, true],
        ['the root replaced with its older value', (r) => { r.set(2, value(older, 2)); }, false],
        ['a record added under a new random id', (r) => { r.set(toHex(crypto.getRandomValues(new Uint8Array(16))), value(r, d1).slice()); }, false],
      ];
      for (const [name, damage, tableCase] of cases) {
        const damaged = new Map(recs);
        damage(damaged);
        const backend = await restore(damaged);
        const fs = new WatchedFs({ backend: shared(backend), key, mode: 'open' });
        const error = await rejection(PGlite.create({ fs }), CorruptStoreError);
        expect(error.name, name).toBe('CorruptStoreError');
        expect(sameRecords(await records(backend), damaged), name).toBe(true);
        // A damaged file table is refused before anything is built from it.
        if (tableCase) expect(fs.created, name).toEqual([]);
      }
    }, 180_000);
  }
});
