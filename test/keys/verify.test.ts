// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// verify() and verifyStore(): every tamper is reported by the damaged record's key and a reason, without throwing and without naming a path.
import { describe, expect, it } from 'vitest';
import type { RecordKey } from '../../src/backend/backend.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { toHex } from '../../src/format/bytes.ts';
import { WrongKeyError } from '../../src/format/errors.ts';
import { verifyStore, type VerifyProblem, type VerifyProgress, type VerifyResult } from '../../src/verify.ts';
import { BLOCK_SIZES, inspect, newKey, openStore, records, rejection, restore, sameRecords, shared } from '../fs/helpers.ts';

type Recs = Map<RecordKey, Uint8Array>;

const value = (recs: Recs, key: RecordKey) => recs.get(key) as Uint8Array;

describe('verify', () => {
  for (const blockSize of BLOCK_SIZES) {
    it(`reports every tamper case by key and reason, and never a path (${String(blockSize)}-byte blocks)`, async () => {
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
      await b.fs.syncToFs(false);
      const stats = b.fs.stats();
      const progress: VerifyProgress[] = [];
      const live = await b.fs.verify({ onProgress: (p) => progress.push(p) });
      expect(live).toEqual({ ok: true, files: stats.files, blocks: stats.dataBlocks, problems: [] });
      expect(progress.at(-1)).toMatchObject({ phase: 'blocks' });
      // Closing commits once more (PGlite removes a file).
      await b.pg.close();
      const recs = await records(memory);
      const closed = await verifyStore(memory, key);
      await rejection(verifyStore(memory, await newKey()), WrongKeyError);

      const { table, root } = await inspect(memory, key);
      expect(closed).toEqual({ ok: true, files: table.files.size, blocks: root.dataBlocks, problems: [] });
      const paths = [...table.files.values()].map((f) => f.path);
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
      const [t0, t1] = tableIds as [string, string];
      const d1 = toHex(f1.ids[0] as Uint8Array);
      const d2 = toHex(f2.ids[0] as Uint8Array);
      const [m0, m1] = multi.ids.map(toHex) as [string, string];
      const added = toHex(crypto.getRandomValues(new Uint8Array(16)));

      const swap = (r: Recs, x: RecordKey, y: RecordKey) => {
        const vx = value(r, x);
        r.set(x, value(r, y));
        r.set(y, vx);
      };
      const flip = (r: Recs, k: RecordKey, at: number) => {
        const v = value(r, k).slice();
        v[at] = (v[at] ?? 0) ^ 0x10;
        r.set(k, v);
      };
      const cases: Array<[string, (r: Recs) => void, VerifyProblem[], boolean]> = [
        ['a bit flipped in a data block', (r) => { flip(r, d1, 100); }, [{ key: d1, reason: 'data-block' }], false],
        ['two blocks of one file exchanged', (r) => { swap(r, m0, m1); }, [{ key: m0, reason: 'data-block' }, { key: m1, reason: 'data-block' }], false],
        ['blocks of two files exchanged', (r) => { swap(r, d1, d2); }, [{ key: d1, reason: 'data-block' }, { key: d2, reason: 'data-block' }], false],
        ['two table blocks exchanged', (r) => { swap(r, t0, t1); }, [{ key: t0, reason: 'table-block' }, { key: t1, reason: 'table-block' }], true],
        ['a data block deleted', (r) => { r.delete(d1); }, [{ key: d1, reason: 'missing' }], false],
        ['a table block deleted', (r) => { r.delete(t1); }, [{ key: t1, reason: 'missing' }], true],
        ['every block of one file deleted', (r) => { for (const id of multi.ids) r.delete(toHex(id)); }, multi.ids.map((id) => ({ key: toHex(id), reason: 'missing' as const })), false],
        // A replayed block opens: only the manifest, in the root, sees it.
        ['a data block replaced with its older value', (r) => { r.set(replayedData, value(older, replayedData)); }, [{ key: 2, reason: 'manifest' }], false],
        ['a table block replaced with its older value', (r) => { r.set(replayedTable, value(older, replayedTable)); }, [{ key: 2, reason: 'table-digest' }], true],
        ['a record added under a new random id', (r) => { r.set(added, value(r, d1).slice()); }, [{ key: added, reason: 'unlisted' }], false],
        ['header copy 0 damaged', (r) => { flip(r, 0, 120); }, [{ key: 0, reason: 'header-copy' }], false],
        ['header copy 1 deleted', (r) => { r.delete(1); }, [{ key: 1, reason: 'header-copy' }], false],
        ['the root damaged', (r) => { flip(r, 2, 100); }, [{ key: 2, reason: 'root' }], true],
        ['the root deleted', (r) => { r.delete(2); }, [{ key: 2, reason: 'root' }], true],
      ];
      const check = (name: string, result: VerifyResult, tableCase: boolean) => {
        expect(result.ok, name).toBe(false);
        if (tableCase) {
          expect(result, name).toMatchObject({ files: 0, blocks: 0 });
          expect(result.problems.some((p) => p.reason === 'data-block'), name).toBe(false);
        }
        const said = JSON.stringify(result);
        for (const path of paths) expect(said.includes(path), `${name}: ${path}`).toBe(false);
      };
      for (const [name, damage, want, tableCase] of cases) {
        const damaged = new Map(recs);
        damage(damaged);
        const backend = await restore(damaged);
        const seen: VerifyProgress[] = [];
        const result = await verifyStore(backend, key, { onProgress: (p) => seen.push(p) });
        expect(result.problems, name).toEqual(expect.arrayContaining(want));
        check(name, result, tableCase);
        expect(seen.every((p) => Object.keys(p).sort().join() === 'done,phase,total'), name).toBe(true);
        expect(sameRecords(await records(backend), damaged), name).toBe(true);
      }
      const rolled = new Map(recs);
      rolled.set(2, value(older, 2));
      const result = await verifyStore(await restore(rolled), key);
      check('the root replaced with its older value', result, true);
      expect(result.problems.length).toBeGreaterThan(0);
    }, 300_000);
  }
});
