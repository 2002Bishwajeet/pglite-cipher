// changeKey: the same data key wrapped under a new KEK, in both header copies at once. The new key
// opens, the old does not; a failed commit leaves one key or the other, never a copy of each; and,
// documented, a copy of the old header still opens later copies of the store with the old key.
import { describe, expect, it } from 'vitest';
import { InjectedFault } from '../../src/backend/faulty.ts';
import { concat, type Bytes } from '../../src/format/bytes.ts';
import { CorruptStoreError, WrongKeyError } from '../../src/format/errors.ts';
import { openHeader } from '../../src/format/keys.ts';
import { newKey, openStore, records, rejection, restore, shared } from '../fs/helpers.ts';
import { baseStore, Faults, tablesOf, type Base, type FaultCounter } from './helpers.ts';

let stored: Promise<Base> | null = null;
/** One store for every test of this file, made on first use. */
const base = (): Promise<Base> => (stored ??= baseStore(65536, 500));

const rowsOf = async (pg: Awaited<ReturnType<typeof openStore>>['pg']) =>
  ((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM t')).rows[0] as { n: number }).n;

describe('changeKey', () => {
  it('the new key opens, the old gives WrongKeyError; only the header copies changed, and the data is intact', async () => {
    const { key, recs } = await base();
    const memory = await restore(recs);
    const { pg, fs } = await openStore({ backend: shared(memory), key, mode: 'open' });
    const want = await tablesOf(pg);
    await fs.syncToFs(false);
    const before = await records(memory);
    const next = await newKey();
    await fs.changeKey(next);
    const after = await records(memory);
    expect([...after.keys()]).toEqual([...before.keys()]);
    const changed = [...after.keys()].filter((k) => !(before.get(k) as Uint8Array).every((x, i) => x === after.get(k)?.[i]));
    expect(changed).toEqual([0, 1]);
    expect(after.get(0)).toEqual(after.get(1));
    // The instance keeps syncing under the new key.
    await pg.exec(`INSERT INTO t VALUES (-1, 'after')`);
    await pg.close();
    await rejection(openStore({ backend: shared(memory), key, mode: 'open' }), WrongKeyError);
    const re = await openStore({ backend: shared(memory), key: next, mode: 'open' });
    expect(await rowsOf(re.pg)).toBe(501);
    await re.pg.exec('DELETE FROM t WHERE id = -1');
    expect(await tablesOf(re.pg)).toEqual(want);
    // And again, from the instance that opened with the new key.
    const third = await newKey();
    await re.fs.changeKey(third);
    await re.pg.close();
    await rejection(openStore({ backend: shared(memory), key: next, mode: 'open' }), WrongKeyError);
    const last = await openStore({ backend: shared(memory), key: third, mode: 'open' });
    expect(await rowsOf(last.pg)).toBe(500);
    await last.pg.close();
  }, 120_000);

  it('replaces both copies or neither: at every FaultyBackend outcome slots 0 and 1 are identical', async () => {
    const { key, recs } = await base();
    for (const mode of ['before', 'after', 'hang'] as const) {
      const memory = await restore(recs);
      const counter: FaultCounter = { commits: 0, at: Infinity, mode };
      const { pg, fs } = await openStore({ backend: new Faults(shared(memory), counter), key, mode: 'open' });
      const old = (await memory.get(0)) as Bytes;
      const next = await newKey();
      counter.at = counter.commits + 1;
      const change = fs.changeKey(next);
      if (mode === 'hang') {
        // A kill during the commit: the store shows what it holds while the commit never ends.
        await expect.poll(() => counter.commits).toBe(counter.at);
        expect(await memory.get(0)).toEqual(await memory.get(1));
        expect(await memory.get(0)).toEqual(old);
        const reopened = await openStore({ backend: shared(await restore(await records(memory))), key, mode: 'open' });
        expect(await rowsOf(reopened.pg)).toBe(500);
        await reopened.pg.close();
        continue;
      }
      const outcome = await change.then(
        () => null,
        (e: unknown) => e,
      );
      const [copy0, copy1] = [await memory.get(0), await memory.get(1)];
      expect(copy0, mode).toEqual(copy1);
      // a: nothing was written and changeKey failed: the old key. b: the commit applied, and reading
      // slot 0 shows it: changeKey succeeded, the new key.
      const current = mode === 'before' ? key : next;
      const other = mode === 'before' ? next : key;
      if (mode === 'before') {
        expect(outcome).toBeInstanceOf(InjectedFault);
        expect(copy0).toEqual(old);
      } else {
        expect(outcome).toBeNull();
        expect(copy0).not.toEqual(old);
      }
      // Either way the instance keeps working.
      await pg.exec(`INSERT INTO t VALUES (-1, 'after')`);
      await pg.close();
      await rejection(openStore({ backend: shared(memory), key: other, mode: 'open' }), WrongKeyError);
      const reopened = await openStore({ backend: shared(memory), key: current, mode: 'open' });
      expect(await rowsOf(reopened.pg), mode).toBe(501);
      await reopened.pg.close();
    }
  }, 180_000);

  it('documented limit: a copy of the old header, with the old key, still opens a later copy of the store', async () => {
    const { key, recs } = await base();
    const memory = await restore(recs);
    const oldHeader = [(await memory.get(0)) as Bytes, (await memory.get(1)) as Bytes] as const;
    const { pg, fs } = await openStore({ backend: shared(memory), key, mode: 'open' });
    await fs.changeKey(await newKey());
    await pg.exec(`INSERT INTO t VALUES (-1, 'written after the key change')`);
    await pg.close();
    // Someone kept the old header and the old key, and copies the store later.
    const later = await records(memory);
    later.set(0, oldHeader[0]);
    later.set(1, oldHeader[1]);
    const thief = await openStore({ backend: shared(await restore(later)), key, mode: 'open' });
    expect((await thief.pg.query(`SELECT v FROM t WHERE id = -1`)).rows).toEqual([{ v: 'written after the key change' }]);
    await thief.pg.close();
  }, 120_000);

  it('the old header’s meta beside the new header’s wrap does not open, on a real store', async () => {
    const { key, recs } = await base();
    const memory = await restore(recs);
    const before = (await memory.get(0)) as Bytes;
    const { pg, fs } = await openStore({ backend: shared(memory), key, mode: 'open' });
    const next = await newKey();
    await fs.changeKey(next);
    await pg.close();
    const after = (await memory.get(0)) as Bytes;
    const cases: Array<[Bytes, CryptoKey]> = [
      [concat([after.subarray(0, 60), before.subarray(60)]), next],
      [concat([before.subarray(0, 60), after.subarray(60)]), key],
    ];
    for (const [spliced, kek] of cases) {
      await rejection(openHeader(kek, spliced, spliced.slice()), CorruptStoreError);
      const damaged = await records(memory);
      damaged.set(0, spliced);
      damaged.set(1, spliced.slice());
      await rejection(openStore({ backend: shared(await restore(damaged)), key: kek, mode: 'open' }), CorruptStoreError);
    }
  }, 120_000);
});
