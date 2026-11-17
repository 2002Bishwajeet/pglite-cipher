// An overwrite writes blocks and the root only, a rename table blocks only, and a vanished block takes its record with it.
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { fsOf, idsOf, inspect, newKey, openStore, PGDATA, records, shared, type Opened } from './helpers.ts';

const B = 8192;

const blockIds = async (memory: MemoryBackend) =>
  new Set([...(await records(memory)).keys()].filter((k): k is string => typeof k === 'string'));

async function store(): Promise<{ memory: MemoryBackend; key: CryptoKey } & Opened> {
  const memory = new MemoryBackend();
  const key = await newKey();
  const opened = await openStore({ backend: shared(memory), key, blockSize: B });
  await opened.pg.exec(`
    CREATE TABLE t (id int PRIMARY KEY, v text);
    INSERT INTO t SELECT i, md5(i::text) FROM generate_series(1, 20) i;
    CHECKPOINT;
  `);
  return { memory, key, ...opened };
}

describe('the packed layout', () => {
  it('a one-row UPDATE overwrites blocks under the ids they have, and writes no table block', async () => {
    const { memory, pg, fs } = await store();
    const before = await blockIds(memory);
    await pg.exec(`UPDATE t SET v = 'changed' WHERE id = 7`);
    const sync = fs.stats().lastSync;
    expect(sync?.dataBlocks).toBeGreaterThan(0);
    expect(sync?.tableBlocks).toBe(0);
    expect(sync?.deletes).toBe(0);
    expect(await blockIds(memory)).toEqual(before);
    await pg.close();
  }, 60_000);

  it('an insert that extends a relation adds ids and writes a table block', async () => {
    const { memory, key, pg, fs } = await store();
    const path = (await pg.query<{ p: string }>(`SELECT pg_relation_filepath('t') AS p`)).rows[0]?.p ?? '';
    const blocksBefore = idsOf(await inspect(memory, key), path).length;
    const before = await blockIds(memory);
    await pg.exec(`INSERT INTO t SELECT i, repeat(md5(i::text), 8) FROM generate_series(21, 200) i`);
    const after = await blockIds(memory);
    expect(idsOf(await inspect(memory, key), path).length).toBeGreaterThan(blocksBefore);
    expect([...before].every((id) => after.has(id))).toBe(true);
    expect(after.size).toBeGreaterThan(before.size);
    expect(fs.stats().lastSync?.tableBlocks).toBeGreaterThanOrEqual(1);
    await pg.close();
  }, 60_000);

  it('renaming a 16 MB file writes table blocks and no data block', async () => {
    const { memory, key, pg, fs } = await store();
    const FS = fsOf(pg);
    FS.writeFile(`${PGDATA}/big-file`, new Uint8Array(16 * 1024 * 1024).fill(7));
    await fs.syncToFs(false);
    const ids = idsOf(await inspect(memory, key), 'big-file');
    expect(ids.length).toBe((16 * 1024 * 1024) / B);
    const before = await blockIds(memory);
    FS.rename(`${PGDATA}/big-file`, `${PGDATA}/renamed-file`);
    await fs.syncToFs(false);
    const sync = fs.stats().lastSync;
    expect(sync?.dataBlocks).toBe(0);
    expect(sync?.tableBlocks).toBeGreaterThanOrEqual(1);
    expect(idsOf(await inspect(memory, key), 'renamed-file')).toEqual(ids);
    expect(await blockIds(memory)).toEqual(before);
    await pg.close();
  }, 60_000);

  it('DROP TABLE and a checkpoint remove the dropped files’ records', async () => {
    const { memory, key, pg } = await store();
    await pg.exec(`CREATE TABLE gone (id int PRIMARY KEY, v text); INSERT INTO gone SELECT i, repeat('x', 500) FROM generate_series(1, 2000) i;`);
    const { rows } = await pg.query<{ p: string }>(
      `SELECT pg_relation_filepath(c.oid) AS p FROM pg_class c WHERE c.relname IN ('gone', 'gone_pkey')`,
    );
    const ins = await inspect(memory, key);
    const dropped = rows.flatMap(({ p }) => idsOf(ins, p));
    expect(dropped.length).toBeGreaterThan(100);
    const count = await memory.count();
    await pg.exec('DROP TABLE gone');
    await pg.exec('CHECKPOINT');
    const after = await blockIds(memory);
    expect(dropped.filter((id) => after.has(id))).toEqual([]);
    expect(await memory.count()).toBeLessThan(count);
    await pg.close();
  }, 60_000);

  it('a truncate removes exactly the ids of the cut indexes', async () => {
    const { memory, key, pg, fs } = await store();
    const FS = fsOf(pg);
    FS.writeFile(`${PGDATA}/cut-file`, new Uint8Array(10 * B).fill(3));
    await fs.syncToFs(false);
    const ids = idsOf(await inspect(memory, key), 'cut-file');
    const before = await blockIds(memory);
    FS.truncate(`${PGDATA}/cut-file`, 3 * B + 100);
    await fs.syncToFs(false);
    const after = await blockIds(memory);
    expect([...before].filter((id) => !after.has(id)).sort()).toEqual(ids.slice(4).sort());
    expect([...after].filter((id) => !before.has(id))).toEqual([]);
    expect(fs.stats().lastSync?.deletes).toBe(6);
    expect(idsOf(await inspect(memory, key), 'cut-file')).toEqual(ids.slice(0, 4));
    await pg.close();
  }, 60_000);
});
