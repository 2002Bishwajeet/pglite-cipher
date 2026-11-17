// The behaviour every StorageBackend must have, as one vitest suite: `runBackendConformance(name, () => new MyBackend())`.
import { afterEach, describe, expect, it } from 'vitest';
import { StaleWriterError } from '../format/errors.ts';
import type { BlockId, CommitBatch, RecordKey, Slot, StorageBackend } from './backend.ts';

export const testBlockId = (n: number): BlockId =>
  (Math.imul(n, 0x9e3779b1) >>> 0).toString(16).padStart(8, '0').repeat(4);

export const testValue = (n: number, length = 16): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i < 4 ? n >>> (8 * i) : n) & 0xff);

const batch = (puts: Array<[RecordKey, Uint8Array]>, deletes: RecordKey[] = [], extra: Partial<CommitBatch> = {}): CommitBatch => ({
  puts,
  deletes,
  durability: 'relaxed',
  ...extra,
});

const allBlocks = async (backend: StorageBackend, page = 1000): Promise<Array<[BlockId, Uint8Array]>> => {
  const out: Array<[BlockId, Uint8Array]> = [];
  for (;;) {
    const got = await backend.readRange(out.at(-1)?.[0] ?? null, page);
    out.push(...got);
    if (got.length < page) return out;
  }
};

const slots = async (backend: StorageBackend) =>
  Promise.all(([0, 1, 2] as Slot[]).map((slot) => backend.get(slot)));

export function runBackendConformance(name: string, makeBackend: () => StorageBackend | Promise<StorageBackend>): void {
  describe(`${name}: StorageBackend conformance`, () => {
    let open: StorageBackend[] = [];
    const fresh = async () => {
      const backend = await makeBackend();
      open.push(backend);
      return backend;
    };
    afterEach(async () => {
      for (const backend of open) {
        await backend.clear();
        await backend.close();
      }
      open = [];
    });

    it('starts empty', async () => {
      const b = await fresh();
      expect(await b.isEmpty()).toBe(true);
      expect(await b.count()).toBe(0);
      expect(await slots(b)).toEqual([undefined, undefined, undefined]);
      expect(await b.readRange(null, 10)).toEqual([]);
    });

    it('round-trips the three slots and blocks', async () => {
      const b = await fresh();
      const ids = [0, 1, 2, 3, 4].map(testBlockId);
      await b.commit(
        batch([
          [0, testValue(100)],
          [1, testValue(101, 40)],
          [2, testValue(102, 3)],
          ...ids.map((id, i): [BlockId, Uint8Array] => [id, testValue(i, 64)]),
        ]),
      );
      expect(await slots(b)).toEqual([testValue(100), testValue(101, 40), testValue(102, 3)]);
      expect(await b.getMany(ids)).toEqual(ids.map((_, i) => testValue(i, 64)));
      await b.commit(batch([[2, testValue(7)], [ids[0] as BlockId, testValue(8)]], [], { durability: 'strict' }));
      expect(await b.get(2)).toEqual(testValue(7));
      expect(await b.getMany([ids[0] as BlockId])).toEqual([testValue(8)]);
    });

    it('keeps its own copy of what was written', async () => {
      const b = await fresh();
      const value = testValue(1);
      await b.commit(batch([[2, value], [testBlockId(1), value]]));
      value.fill(0xee);
      expect(await b.get(2)).toEqual(testValue(1));
      expect(await b.getMany([testBlockId(1)])).toEqual([testValue(1)]);
    });

    it('stores only the bytes of a view, not the rest of its buffer', async () => {
      const b = await fresh();
      const big = new Uint8Array(64).fill(0xa5);
      big.set(testValue(1), 8);
      const view = big.subarray(8, 24);
      await b.commit(batch([[2, view], [testBlockId(1), view]]));
      const got = [await b.get(2), ...(await b.getMany([testBlockId(1)])), ...(await b.readRange(null, 10)).map(([, v]) => v)];
      expect(got).toHaveLength(3);
      for (const value of got) {
        expect(value).toEqual(testValue(1));
        expect(value?.buffer.byteLength).toBe(16);
        expect(new Uint8Array(value?.buffer ?? new ArrayBuffer(0))).not.toContain(0xa5);
      }
    });

    it('getMany returns values in the order asked, undefined for a missing id (1 id)', async () => {
      const b = await fresh();
      expect(await b.getMany([testBlockId(9)])).toEqual([undefined]);
      await b.commit(batch([[testBlockId(9), testValue(9)]]));
      expect(await b.getMany([testBlockId(9)])).toEqual([testValue(9)]);
      expect(await b.getMany([])).toEqual([]);
    });

    it('getMany returns values in the order asked, undefined for a missing id (2,000 ids)', async () => {
      const b = await fresh();
      await b.commit(batch(Array.from({ length: 1000 }, (_, i): [BlockId, Uint8Array] => [testBlockId(2 * i), testValue(2 * i)])));
      const asked = Array.from({ length: 2000 }, (_, i) => (i * 7919) % 2000);
      const got = await b.getMany(asked.map(testBlockId));
      expect(got).toHaveLength(2000);
      expect(got).toEqual(asked.map((n) => (n % 2 === 0 ? testValue(n) : undefined)));
    });

    it('readRange returns blocks in ascending id order, resumes exactly after any id, never returns a slot', async () => {
      const b = await fresh();
      const ids = Array.from({ length: 50 }, (_, i) => testBlockId(i));
      await b.commit(
        batch([
          [0, testValue(1000)],
          [1, testValue(1001)],
          [2, testValue(1002)],
          ...ids.map((id, i): [BlockId, Uint8Array] => [id, testValue(i)]),
        ]),
      );
      const sorted = [...ids].sort();
      const value = (id: BlockId) => testValue(ids.indexOf(id));
      expect(await b.readRange(null, 100)).toEqual(sorted.map((id) => [id, value(id)]));
      for (const limit of [1, 7, 50]) {
        const pages = await allBlocks(b, limit);
        expect(pages.map(([id]) => id)).toEqual(sorted);
      }
      for (const [i, after] of sorted.entries()) {
        expect((await b.readRange(after, 3)).map(([id]) => id)).toEqual(sorted.slice(i + 1, i + 4));
      }
      const absent = testBlockId(10_000);
      expect((await b.readRange(absent, 100)).map(([id]) => id)).toEqual(sorted.filter((id) => id > absent));
      expect(await b.readRange('ffffffffffffffffffffffffffffffff', 10)).toEqual([]);
      expect(await b.readRange(null, 0)).toEqual([]);
    });

    it('deletes remove exactly the listed keys, and deleting an absent key succeeds', async () => {
      const b = await fresh();
      const ids = Array.from({ length: 10 }, (_, i) => testBlockId(i));
      await b.commit(batch([[0, testValue(0)], [1, testValue(1)], [2, testValue(2)], ...ids.map((id, i): [BlockId, Uint8Array] => [id, testValue(i)])]));
      await b.commit(batch([], [1, ids[3] as BlockId, ids[7] as BlockId, testBlockId(500)]));
      expect(await slots(b)).toEqual([testValue(0), undefined, testValue(2)]);
      expect((await allBlocks(b)).map(([id]) => id)).toEqual(ids.filter((_, i) => i !== 3 && i !== 7).sort());
      expect(await b.count()).toBe(10);
      await b.commit(batch([], [1, testBlockId(500)]));
      const empty = await fresh();
      await empty.commit(batch([], [0, 1, 2, testBlockId(1)]));
      expect(await empty.isEmpty()).toBe(true);
    });

    it('a put and a delete of the same key in one batch leaves the put', async () => {
      const b = await fresh();
      await b.commit(batch([[2, testValue(1)], [testBlockId(1), testValue(1)]]));
      await b.commit(
        batch(
          [
            [2, testValue(2)],
            [testBlockId(1), testValue(2)],
            [testBlockId(2), testValue(2)],
          ],
          [2, testBlockId(1), testBlockId(2)],
        ),
      );
      expect(await b.get(2)).toEqual(testValue(2));
      expect(await b.getMany([testBlockId(1), testBlockId(2)])).toEqual([testValue(2), testValue(2)]);
    });

    it('a batch with a failing expectRoot changes nothing and rejects with StaleWriterError', async () => {
      const b = await fresh();
      const root = testValue(1);
      await b.commit(batch([[0, testValue(0)], [2, root], [testBlockId(1), testValue(1)]]));
      const before = { slots: await slots(b), blocks: await allBlocks(b) };
      const wrong = [testValue(2), root.subarray(0, 15), new Uint8Array([...root, 0]), null];
      for (const expectRoot of wrong) {
        await expect(
          b.commit(batch([[0, testValue(9)], [2, testValue(9)], [testBlockId(2), testValue(9)]], [testBlockId(1)], { expectRoot })),
        ).rejects.toBeInstanceOf(StaleWriterError);
        expect({ slots: await slots(b), blocks: await allBlocks(b) }).toEqual(before);
      }
      await b.commit(batch([[2, testValue(3)]], [], { expectRoot: root.slice() }));
      expect(await b.get(2)).toEqual(testValue(3));
    });

    it('expectRoot null passes only when slot 2 is absent', async () => {
      const b = await fresh();
      await b.commit(batch([[0, testValue(0)]], [], { expectRoot: null }));
      await b.commit(batch([[2, testValue(2)]], [], { expectRoot: null }));
      await expect(b.commit(batch([[2, testValue(3)]], [], { expectRoot: null }))).rejects.toBeInstanceOf(StaleWriterError);
      expect(await b.get(2)).toEqual(testValue(2));
      await b.commit(batch([], [2]));
      await b.commit(batch([[2, testValue(4)]], [], { expectRoot: null }));
      expect(await b.get(2)).toEqual(testValue(4));
      await b.commit(batch([], [2]));
      await expect(b.commit(batch([[1, testValue(5)]], [], { expectRoot: testValue(4) }))).rejects.toBeInstanceOf(StaleWriterError);
      expect(await b.get(1)).toBeUndefined();
    });

    it('a batch is all or nothing: an invalid last put leaves nothing from the batch visible', async () => {
      const b = await fresh();
      await b.commit(batch([[2, testValue(1)], [testBlockId(1), testValue(1)]]));
      const before = { slots: await slots(b), blocks: await allBlocks(b) };
      const invalid: unknown[] = ['not-a-block-id', 3, testBlockId(1).toUpperCase(), `${testBlockId(1)}0`];
      for (const key of invalid) {
        const puts: Array<[RecordKey, Uint8Array]> = [
          [0, testValue(9)],
          [2, testValue(9)],
          ...Array.from({ length: 20 }, (_, i): [BlockId, Uint8Array] => [testBlockId(100 + i), testValue(i)]),
          [key as RecordKey, testValue(9)],
        ];
        await expect(b.commit(batch(puts, [testBlockId(1)], { expectRoot: testValue(1) }))).rejects.toThrow();
        expect({ slots: await slots(b), blocks: await allBlocks(b) }).toEqual(before);
        expect(await b.count()).toBe(2);
      }
      await expect(b.commit(batch([[0, testValue(9)]], [testBlockId(1), 'nope']))).rejects.toThrow();
      expect({ slots: await slots(b), blocks: await allBlocks(b) }).toEqual(before);
    });

    it('count is the number of slots plus blocks; isEmpty is true only with zero records', async () => {
      const b = await fresh();
      await b.commit(batch([[1, testValue(1)]]));
      expect(await b.count()).toBe(1);
      expect(await b.isEmpty()).toBe(false);
      await b.commit(batch([[testBlockId(1), testValue(1)]], [1]));
      expect(await b.count()).toBe(1);
      expect(await b.isEmpty()).toBe(false);
      await b.commit(batch([[0, testValue(0)], [2, testValue(2)], ...[2, 3, 4].map((n): [BlockId, Uint8Array] => [testBlockId(n), testValue(n)])]));
      expect(await b.count()).toBe(6);
      await b.commit(batch([], [0, 2, testBlockId(1), testBlockId(2), testBlockId(3), testBlockId(4)]));
      expect(await b.count()).toBe(0);
      expect(await b.isEmpty()).toBe(true);
    });

    it('clear empties it', async () => {
      const b = await fresh();
      await b.commit(batch([[0, testValue(0)], [1, testValue(1)], [2, testValue(2)], [testBlockId(1), testValue(1)]]));
      await b.clear();
      expect(await b.isEmpty()).toBe(true);
      expect(await b.count()).toBe(0);
      expect(await slots(b)).toEqual([undefined, undefined, undefined]);
      expect(await b.readRange(null, 10)).toEqual([]);
      await b.commit(batch([[2, testValue(5)]], [], { expectRoot: null }));
      expect(await b.get(2)).toEqual(testValue(5));
    });
  });
}
