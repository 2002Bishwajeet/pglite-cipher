// rotateDataKey: new data key, every record resealed into a fresh store, then a switch. Data survives; nothing of the new store opens under the old key or shares an id with the old;
// the old store is gone; writes made meanwhile are kept; a fault at any commit loses nothing.
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { BlockId, CommitBatch, Slot, StorageBackend } from '../../src/backend/backend.ts';
import { InjectedFault } from '../../src/backend/faulty.ts';
import { IndexedDbBackend } from '../../src/backend/indexeddb.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import type { RotateProgress } from '../../src/encryptedFs.ts';
import { toHex, type Bytes } from '../../src/format/bytes.ts';
import { CorruptStoreError, IncompleteStoreError, StaleWriterError, StoreExistsError } from '../../src/format/errors.ts';
import { openBlock, openRoot, openTable, type RecordContext } from '../../src/format/records.ts';
import { packEntries } from '../../src/format/table.ts';
import { freshName } from '../backend/names.ts';
import {
  expectStoreEquals,
  fsOf,
  inBrowser,
  inspect,
  newKey,
  openStore,
  records,
  rejection,
  restore,
  sameRecords,
  shared,
  type Opened,
} from '../fs/helpers.ts';
import { baseStore, databaseExists, expectOneStore, Faults, openPair, tablesOf, type FaultCounter } from './helpers.ts';

const rowCount = async (pg: PGlite, table: string) =>
  ((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0] as { n: number }).n;

/** A kill: a commit putting the root (`root`) or a clear (`clear`) waits for `release()`, then fails writing nothing. */
class Hang implements StorageBackend {
  hung = false;
  readonly #inner: StorageBackend;
  readonly #when: { root?: boolean; clear?: boolean };
  #release = (): void => undefined;
  readonly #released = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  constructor(inner: StorageBackend, when: { root?: boolean; clear?: boolean }) {
    this.#inner = inner;
    this.#when = when;
  }

  release(): void {
    this.#release();
  }

  async #hang(): Promise<never> {
    this.hung = true;
    await this.#released;
    throw new InjectedFault('killed');
  }

  commit(batch: CommitBatch): Promise<void> {
    return this.#when.root === true && batch.puts.some(([key]) => key === 2) ? this.#hang() : this.#inner.commit(batch);
  }

  clear(): Promise<void> {
    return this.#when.clear === true ? this.#hang() : this.#inner.clear();
  }

  get = (slot: Slot) => this.#inner.get(slot);
  isEmpty = () => this.#inner.isEmpty();
  count = () => this.#inner.count();
  getMany = (ids: BlockId[]) => this.#inner.getMany(ids);
  readRange = (after: BlockId | null, limit: number) => this.#inner.readRange(after, limit);
  close = () => this.#inner.close();
}

class AfterCommit implements StorageBackend {
  readonly #inner: StorageBackend;
  readonly #after: (batch: CommitBatch) => Promise<void>;

  constructor(inner: StorageBackend, after: (batch: CommitBatch) => Promise<void>) {
    this.#inner = inner;
    this.#after = after;
  }

  async commit(batch: CommitBatch): Promise<void> {
    await this.#inner.commit(batch);
    await this.#after(batch);
  }

  get = (slot: Slot) => this.#inner.get(slot);
  isEmpty = () => this.#inner.isEmpty();
  count = () => this.#inner.count();
  getMany = (ids: BlockId[]) => this.#inner.getMany(ids);
  readRange = (after: BlockId | null, limit: number) => this.#inner.readRange(after, limit);
  clear = () => this.#inner.clear();
  close = () => this.#inner.close();
}

/** Zero-fills commit block values once in, and each page once the next read starts: a rotation using either later fails. `early` (control) zero-fills before passing on. */
class Zeroing implements StorageBackend {
  maxPuts = 0;
  maxHeld = 0;
  readonly #inner: StorageBackend;
  readonly #early: boolean;
  #held: Uint8Array[] = [];
  #inFlight = 0;

  constructor(inner: StorageBackend, { early = false } = {}) {
    this.#inner = inner;
    this.#early = early;
  }

  async commit(batch: CommitBatch): Promise<void> {
    // Block values only: header and root are the slots the filesystem keeps.
    const blocks = batch.puts.filter(([key]) => typeof key === 'string').map(([, value]) => value);
    this.maxPuts = Math.max(this.maxPuts, blocks.length);
    if (this.#early) for (const v of blocks) v.fill(0);
    await this.#inner.commit(batch);
    for (const v of blocks) v.fill(0);
  }

  getMany(ids: BlockId[]): Promise<Array<Uint8Array | undefined>> {
    return this.#read(() => this.#inner.getMany(ids), (values) => values.filter((v): v is Uint8Array => v !== undefined));
  }

  readRange(after: BlockId | null, limit: number): Promise<Array<[BlockId, Uint8Array]>> {
    return this.#read(() => this.#inner.readRange(after, limit), (page) => page.map(([, v]) => v));
  }

  async #read<T>(read: () => Promise<T>, values: (result: T) => Uint8Array[]): Promise<T> {
    for (const v of this.#held) v.fill(0);
    this.#held = [];
    this.#inFlight++;
    const result = await read();
    this.#inFlight--;
    this.#held = values(result);
    this.maxHeld = Math.max(this.maxHeld, (this.#held.length > 0 ? 1 : 0) + this.#inFlight);
    return result;
  }

  get = (slot: Slot) => this.#inner.get(slot);
  isEmpty = () => this.#inner.isEmpty();
  count = () => this.#inner.count();
  clear = () => this.#inner.clear();
  close = () => this.#inner.close();
}

/** While `writes.on`, runs `before(n)` ahead of the n-th commit or clear; the write waits for it. */
class Before implements StorageBackend {
  readonly #inner: StorageBackend;
  readonly #writes: { n: number; on: boolean };
  readonly #before: (n: number) => Promise<void>;

  constructor(inner: StorageBackend, writes: { n: number; on: boolean }, before: (n: number) => Promise<void>) {
    this.#inner = inner;
    this.#writes = writes;
    this.#before = before;
  }

  async commit(batch: CommitBatch): Promise<void> {
    if (this.#writes.on) await this.#before(++this.#writes.n);
    await this.#inner.commit(batch);
  }

  async clear(): Promise<void> {
    if (this.#writes.on) await this.#before(++this.#writes.n);
    await this.#inner.clear();
  }

  get = (slot: Slot) => this.#inner.get(slot);
  isEmpty = () => this.#inner.isEmpty();
  count = () => this.#inner.count();
  getMany = (ids: BlockId[]) => this.#inner.getMany(ids);
  readRange = (after: BlockId | null, limit: number) => this.#inner.readRange(after, limit);
  close = () => this.#inner.close();
}

describe('rotateDataKey', () => {
  it('rotates into the empty slot of a pair: a new data key, no shared id, a packed table, the old store gone', async () => {
    const { key, recs } = await baseStore(8192);
    const a = await restore(recs);
    const b = new MemoryBackend();
    const before = await inspect(a, key);
    const oldIds = new Set([...recs.keys()].filter((k) => typeof k === 'string'));
    const { pg, fs } = await openPair([shared(a), shared(b)], key);
    const want = await tablesOf(pg);
    const progress: RotateProgress[] = [];
    await fs.rotateDataKey({ onProgress: (p) => progress.push(p) });
    expect(await a.isEmpty()).toBe(true);
    expect([...new Set(progress.map((p) => p.phase))]).toEqual(['copy', 'catch-up', 'verify']);
    await expectStoreEquals(b, key, fsOf(pg));

    const after = await inspect(b, key);
    expect(after.ctx.meta.keyId).toBe(before.ctx.meta.keyId + 1);
    expect(after.ctx.meta.storeId).not.toEqual(before.ctx.meta.storeId);
    const stored = await records(b);
    for (const id of stored.keys()) if (typeof id === 'string') expect(oldIds.has(id), id).toBe(false);
    // The counter restarted with the new key: about one encryption per record.
    const { encryptions } = fs.stats();
    expect(encryptions).toBeGreaterThanOrEqual(stored.size - 2);
    expect(encryptions).toBeLessThan(stored.size + 50);

    const oldKey: RecordContext = { subkeys: before.ctx.subkeys, meta: after.ctx.meta, encryptions: 0 };
    await rejection(openRoot(oldKey, stored.get(2) as Bytes), CorruptStoreError);
    await openRoot(after.ctx, stored.get(2) as Bytes);
    for (const id of after.root.tableIds) {
      await rejection(openTable(oldKey, id, stored.get(toHex(id)) as Bytes), CorruptStoreError);
    }
    for (const f of after.table.files.values()) {
      for (const [index, id] of f.ids.entries()) {
        const value = stored.get(toHex(id)) as Bytes;
        await rejection(openBlock(oldKey, id, f.fileId, index, value), CorruptStoreError);
        await openBlock(after.ctx, id, f.fileId, index, value);
      }
    }
    const inOrder = after.blocks.flatMap((block) => block.entries).filter((e) => e.kind === 'file');
    const files = inOrder.map((e) => after.table.files.get(toHex(e.fileId)) as NonNullable<ReturnType<typeof after.table.files.get>>);
    expect(packEntries(files, 8192).length).toBe(after.root.tableIds.length);
    await pg.close();

    const re = await openPair([shared(a), shared(b)], key);
    expect(await tablesOf(re.pg)).toEqual(want);
    await expectOneStore([a, b], re);
    await re.fs.rotateDataKey();
    expect(await b.isEmpty()).toBe(true);
    expect((await inspect(a, key)).ctx.meta.keyId).toBe(before.ctx.meta.keyId + 2);
    await re.pg.close();
    const third = await openPair([shared(a), shared(b)], key);
    expect(await tablesOf(third.pg)).toEqual(want);
    await third.pg.close();
  }, 240_000);

  it('IndexedDbBackend.pair: the databases <name>.a and <name>.b; after a rotation the old one is gone', async () => {
    const name = freshName();
    const key = await newKey();
    const { pg, fs } = await openPair(IndexedDbBackend.pair(name), key, { mode: 'create' });
    await pg.exec(`CREATE TABLE n (i int); INSERT INTO n SELECT generate_series(1, 100);`);
    expect(await databaseExists(`${name}.a`)).toBe(true);
    await fs.rotateDataKey();
    expect(await databaseExists(`${name}.a`)).toBe(false);
    expect(await databaseExists(`${name}.b`)).toBe(true);
    await pg.close();
    const re = await openPair(IndexedDbBackend.pair(name), key, { mode: 'open' });
    expect(await rowCount(re.pg, 'n')).toBe(100);
    await re.pg.close();
  }, 120_000);

  it('a single backend rotates into backendFactory’s; openOrigin lets an open finish or undo an interrupted rotation', async () => {
    const { key, recs } = await baseStore(65536);
    const one = await restore(recs);
    const two = new MemoryBackend();
    const { pg, fs } = await openStore({ backend: shared(one), key, mode: 'open' });
    await rejection(fs.rotateDataKey(), TypeError);
    await rejection(fs.rotateDataKey({ backendFactory: () => ({ name: 'one', backend: shared(one) }) }), StoreExistsError);
    await fs.rotateDataKey({ backendFactory: () => ({ name: 'two', backend: shared(two) }) });
    expect(await one.isEmpty()).toBe(true);
    await pg.exec(`INSERT INTO t VALUES (-1, 'after')`);
    await pg.close();
    const reopened = await openStore({ backend: shared(two), key, mode: 'open' });
    expect(await rowCount(reopened.pg, 't')).toBe(2001);
    await reopened.pg.close();

    for (const at of ['switch', 'delete'] as const) {
      const old = await restore(recs);
      const next = new MemoryBackend();
      const own = new Hang(shared(old), { clear: at === 'delete' });
      const target = new Hang(shared(next), { root: at === 'switch' });
      const run = await openStore({ backend: own, key, mode: 'open' });
      await run.pg.exec(`INSERT INTO t VALUES (-1, 'before the rotation')`);
      const rotation = run.fs.rotateDataKey({ backendFactory: () => ({ name: 'next', backend: target }) });
      await expect.poll(() => own.hung || target.hung, { timeout: 60_000 }).toBe(true);
      const [copyOld, copyNext] = [await restore(await records(old)), await restore(await records(next))];
      own.release();
      target.release();
      await rotation.catch(() => undefined);
      await run.pg.close();

      const untouched = await records(copyOld);
      await rejection(openStore({ backend: shared(copyOld), key, mode: 'open' }), IncompleteStoreError);
      expect(sameRecords(await records(copyOld), untouched)).toBe(true);
      const names: string[] = [];
      const openOrigin = (name: string): StorageBackend => {
        names.push(name);
        return shared(copyNext);
      };
      const resumed = await openStore({ backend: shared(copyOld), key, mode: 'open', openOrigin });
      expect(names).toEqual(['next']);
      expect(await rowCount(resumed.pg, 't')).toBe(2001);
      expect(await (at === 'switch' ? copyNext : copyOld).isEmpty(), at).toBe(true);
      await resumed.pg.close();
    }
  }, 240_000);

  it('the fuzzy copy is repaired: rows updated between every batch of the copy', async () => {
    const { key, recs } = await baseStore(8192, 5000);
    const a = await restore(recs);
    const b = new MemoryBackend();
    let pg: PGlite | null = null;
    let copying = true;
    let batches = 0;
    const target = new AfterCommit(shared(b), async (batch) => {
      if (!copying || batch.puts.some(([k]) => typeof k === 'number')) return;
      batches++;
      await (pg as PGlite).exec(
        `UPDATE t SET v = 'batch ${String(batches)}' WHERE id % 13 = ${String(batches % 13)}; INSERT INTO t VALUES (${String(100_000 + batches)}, 'new');`,
      );
    });
    const opened = await openPair([shared(a), target], key);
    pg = opened.pg;
    await opened.fs.rotateDataKey({
      onProgress: (p) => {
        if (p.phase === 'copy' && p.done === p.total) copying = false;
      },
    });
    expect(batches).toBeGreaterThanOrEqual(3);
    expect(opened.fs.hasDirty()).toBe(false);
    await expectStoreEquals(b, key, fsOf(opened.pg));
    const live = await tablesOf(opened.pg);
    await opened.pg.close();
    const re = await openPair([shared(a), shared(b)], key);
    expect(await tablesOf(re.pg)).toEqual(live);
    expect(await rowCount(re.pg, 't')).toBe(5000 + batches);
    await re.pg.close();
  }, 240_000);

  it('writes during a rotation: after the switch and one more sync, a reopen has all of them', async () => {
    const { key, recs } = await baseStore(8192, 5000);
    const a = await restore(recs);
    const b = new MemoryBackend();
    const { pg, fs } = await openPair([shared(a), shared(b)], key);
    await pg.exec('CREATE TABLE w (i int PRIMARY KEY)');
    let n = 0;
    let finished = 0;
    const atCopy: number[] = [];
    const queries: Array<Promise<void>> = [];
    // Queries start at each step and are never awaited (a timer loop fails: Chromium runs no timer until the rotation ends).
    await fs.rotateDataKey({
      onProgress: (p) => {
        if (p.phase === 'copy') atCopy.push(finished);
        queries.push(pg.exec(`INSERT INTO w VALUES (${String(++n)})`).then(() => {
          finished++;
        }));
      },
    });
    await Promise.all(queries);
    expect((atCopy.at(-1) ?? 0) - (atCopy[0] ?? 0)).toBeGreaterThan(0);
    await fs.syncToFs(false);
    expect(fs.hasDirty()).toBe(false);
    const re = await openPair([shared(await restore(await records(a))), shared(await restore(await records(b)))], key);
    expect(await rowCount(re.pg, 'w')).toBe(n);
    await re.pg.close();
    await pg.close();
  }, 240_000);

  it('holds at most one batch of ciphertext: commits of at most 512 blocks, one page read at a time', async () => {
    const { key, recs } = await baseStore(8192, 5000);
    const a = await restore(recs);
    const b = new MemoryBackend();
    const zeroing = new Zeroing(shared(b));
    const { pg, fs } = await openPair([shared(a), zeroing], key);
    const want = await tablesOf(pg);
    await fs.rotateDataKey();
    expect(zeroing.maxPuts).toBeLessThanOrEqual(512);
    expect(zeroing.maxPuts).toBeGreaterThan(256);
    expect(zeroing.maxHeld).toBe(1);
    await pg.close();
    const re = await openPair([shared(a), shared(b)], key);
    expect(await tablesOf(re.pg)).toEqual(want);
    await re.pg.close();

    // Control: values damaged before they are stored fail the read-back, and the old store stays.
    const c = await restore(recs);
    const control = await openPair([shared(c), new Zeroing(new MemoryBackend(), { early: true })], key);
    await rejection(control.fs.rotateDataKey(), CorruptStoreError);
    await control.pg.exec(`INSERT INTO t VALUES (-1, 'after')`);
    await control.pg.close();
    const kept = await openPair([shared(c), shared(new MemoryBackend())], key);
    expect(await rowCount(kept.pg, 't')).toBe(5001);
    await kept.pg.close();
  }, 240_000);

  for (const mode of ['before', 'after'] as const) {
    it(`a fault (${mode} writing) at any commit of a rotation, on either store: nothing is lost, no orphan remains`, async () => {
      const { key, recs } = await baseStore(65536);
      const run = async (at: number): Promise<{ rejected: boolean; commits: number }> => {
        const a = await restore(recs);
        const b = new MemoryBackend();
        const counter: FaultCounter = { commits: 0, at: Infinity, mode };
        const { pg, fs } = await openPair([new Faults(shared(a), counter), new Faults(shared(b), counter)], key);
        await pg.exec(`INSERT INTO t VALUES (-1, 'before')`);
        await fs.syncToFs(false);
        counter.commits = 0;
        counter.at = at;
        const outcome = await fs.rotateDataKey().then(
          () => null,
          (e: unknown) => e,
        );
        if (outcome !== null) expect((outcome as Error).name, `commit ${String(at)}`).toBe('InjectedFault');
        const commits = counter.commits;
        await pg.exec(`INSERT INTO t VALUES (-2, 'after')`);
        expect(fs.stats().trackingGaps).toBe(0);
        await pg.close();
        const re = await openPair([shared(a), shared(b)], key);
        expect(await rowCount(re.pg, 't'), `commit ${String(at)}`).toBe(2002);
        await expectOneStore([a, b], re);
        await re.pg.close();
        return { rejected: outcome !== null, commits };
      };
      const { rejected, commits: total } = await run(Infinity);
      expect(rejected).toBe(false);
      expect(total).toBeGreaterThanOrEqual(6);
      const every = inBrowser ? 10 : 1;
      for (let at = 1; at <= total; at += every) {
        const outcome = await run(at);
        // A failed commit before the switch fails the rotation, except the mark and the switch, which a root read settles as applied.
        // The last (retiring) fails nothing: the old store stays marked and reopen finishes.
        if (mode === 'before') expect(outcome.rejected, `commit ${String(at)}`).toBe(at !== total);
        else expect(outcome.rejected, `commit ${String(at)}`).toBe(at !== 1 && at < total - 1);
      }
    }, 900_000);
  }

  it('a second instance that opens the pair before any write of a rotation: one of the two keeps a store, the other stops, nothing is lost', async () => {
    const { key, recs } = await baseStore(65536);
    const run = async (at: number): Promise<number> => {
      const a = await restore(recs);
      const b = new MemoryBackend();
      const writes = { n: 0, on: false };
      const second: { opening: Promise<Opened> | null } = { opening: null };
      const before = async (n: number) => {
        if (n !== at) return;
        second.opening = openPair([shared(a), shared(b)], key, { mode: 'open' });
        await second.opening.catch(() => undefined);
      };
      const first = await openPair([new Before(shared(a), writes, before), new Before(shared(b), writes, before)], key);
      await first.pg.exec(`INSERT INTO t VALUES (-1, 'before')`);
      await first.fs.syncToFs(false);
      writes.on = true;
      const rotation = await first.fs.rotateDataKey().then(
        () => null,
        (e: unknown) => e,
      );
      writes.on = false;
      const label = `write ${String(at)}`;
      // Fails at read-back if the other instance deleted the new store, at the switch or step 8 if it took the old root.
      if (rotation !== null) expect([StaleWriterError, CorruptStoreError].some((type) => rotation instanceof type), label).toBe(true);
      const up: Array<{ opened: Opened; id: number }> = [{ opened: first, id: -2 }];
      if (second.opening) {
        const opened = await second.opening.then(
          (o) => o,
          (e: unknown) => {
            expect(e, label).toBeInstanceOf(StaleWriterError);
            return null;
          },
        );
        if (opened) up.push({ opened, id: -3 });
      }
      // Each instance still up writes a row and syncs it: exactly one of them can.
      const synced: number[] = [];
      for (const { opened, id } of up) {
        await opened.pg.exec(`INSERT INTO t VALUES (${String(id)}, 'after')`);
        const ok = await opened.fs.syncToFs(false).then(
          () => true,
          (e: unknown) => {
            expect(e, label).toBeInstanceOf(StaleWriterError);
            return false;
          },
        );
        if (ok) synced.push(id);
      }
      expect(synced, label).toHaveLength(1);
      for (const { opened } of up) await opened.pg.close();

      const re = await openPair([shared(a), shared(b)], key, { mode: 'open' });
      const ids = (await re.pg.query<{ id: number }>('SELECT id FROM t WHERE id < 0 ORDER BY id')).rows.map((r) => r.id);
      expect(ids, label).toEqual([synced[0], -1]);
      expect(await rowCount(re.pg, 't'), label).toBe(2002);
      await expectOneStore([a, b], re);
      await re.pg.close();
      return writes.n;
    };
    const total = await run(Infinity);
    expect(total).toBeGreaterThanOrEqual(7);
    for (let at = 1; at <= total; at++) await run(at);
  }, 900_000);

  it('an instance idle while another rotated the pair: its changeKey and its rotateDataKey reject with StaleWriterError and delete nothing', async () => {
    const { key, recs } = await baseStore(65536);
    for (const operation of ['changeKey', 'rotateDataKey'] as const) {
      const a = await restore(recs);
      const b = new MemoryBackend();
      const idle = await openPair([shared(a), shared(b)], key, { mode: 'open' });
      const first = await openPair([shared(a), shared(b)], key, { mode: 'open' });
      await first.pg.exec(`INSERT INTO t VALUES (-1, 'rotated')`);
      await first.fs.rotateDataKey();
      await first.pg.close();
      const rotated = await records(b);
      await rejection(operation === 'changeKey' ? idle.fs.changeKey(await newKey()) : idle.fs.rotateDataKey(), StaleWriterError);
      expect(await a.isEmpty(), operation).toBe(true);
      expect(sameRecords(await records(b), rotated), operation).toBe(true);
      await idle.pg.close();
      const re = await openPair([shared(a), shared(b)], key, { mode: 'open' });
      expect(await rowCount(re.pg, 't'), operation).toBe(2001);
      await expectOneStore([a, b], re);
      await re.pg.close();
    }
  }, 240_000);

  it('a rotation undone by a second instance, which then rotates the pair itself: the first fails and deletes nothing, the second’s store stays whole', async () => {
    const { key, recs } = await baseStore(65536);
    const run = async (at: number): Promise<number> => {
      const a = await restore(recs);
      const b = new MemoryBackend();
      const writes = { n: 0, on: false };
      const second: { opened: Opened | null } = { opened: null };
      const before = async (n: number) => {
        if (n !== at) return;
        const opened = await openPair([shared(a), shared(b)], key, { mode: 'open' });
        second.opened = opened;
        await opened.pg.exec(`INSERT INTO t VALUES (-3, 'second')`);
        await opened.fs.rotateDataKey();
      };
      const first = await openPair([new Before(shared(a), writes, before), new Before(shared(b), writes, before)], key);
      await first.pg.exec(`INSERT INTO t VALUES (-1, 'before')`);
      await first.fs.syncToFs(false);
      writes.on = true;
      const rotation = await first.fs.rotateDataKey().then(
        () => null,
        (e: unknown) => e,
      );
      writes.on = false;
      const up = second.opened;
      if (up === null) {
        await first.pg.close();
        return writes.n;
      }
      const label = `write ${String(at)}`;
      expect(rotation, label).toBeInstanceOf(StaleWriterError);
      await first.pg.exec(`INSERT INTO t VALUES (-2, 'lost')`);
      await rejection(first.fs.syncToFs(false), StaleWriterError);
      await up.pg.exec(`INSERT INTO t VALUES (-4, 'second, after')`);
      await up.fs.syncToFs(false);
      await first.pg.close();
      await up.pg.close();

      const re = await openPair([shared(a), shared(b)], key, { mode: 'open' });
      const ids = (await re.pg.query<{ id: number }>('SELECT id FROM t WHERE id < 0 ORDER BY id')).rows.map((r) => r.id);
      expect(ids, label).toEqual([-4, -3, -1]);
      await expectOneStore([a, b], re);
      await re.pg.close();
      return writes.n;
    };
    const total = await run(Infinity);
    expect(total).toBeGreaterThanOrEqual(7);
    for (let at = 1; at <= total - 2; at++) await run(at);
  }, 900_000);

  it('an open beside a store with no root or no header, which an undone rotation can leave, deletes that one', async () => {
    const { key, recs } = await baseStore(65536);
    for (const [cut, leftFirst] of [
      [[2], true],
      [[0, 1], false],
    ] as const) {
      const store = await restore(recs);
      const left = await restore(recs);
      await left.commit({ puts: [], deletes: [...cut], durability: 'strict' });
      const pair = leftFirst ? ([left, store] as const) : ([store, left] as const);
      const re = await openPair([shared(pair[0]), shared(pair[1])], key, { mode: 'open' });
      expect(await rowCount(re.pg, 't')).toBe(2000);
      expect(await left.isEmpty()).toBe(true);
      await expectOneStore(pair, re);
      await re.pg.close();
    }
  }, 240_000);
});

