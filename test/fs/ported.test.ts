// Scenarios ported from davidmuggleton/pglite-encrypted-fs (MIT, see THIRD_PARTY.md):
// test/integration/pglite-basic.test.ts and pglite-failure.test.ts, adapted to this API (a KEK and a
// backend in place of a passphrase and a directory). Its passphrase-only cases have no counterpart.
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { RecordKey } from '../../src/backend/backend.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { toHex } from '../../src/format/bytes.ts';
import { CorruptStoreError, IncompleteStoreError, WrongKeyError } from '../../src/format/errors.ts';
import { importKek } from '../../src/format/keys.ts';
import { idsOf, inspect, newKey, openStore, records, rejection, restore, shared } from './helpers.ts';

interface Store {
  memory: MemoryBackend;
  key: CryptoKey;
  db: PGlite;
}

async function fresh(): Promise<Store> {
  const memory = new MemoryBackend();
  const key = await newKey();
  const { pg } = await openStore({ backend: shared(memory), key });
  return { memory, key, db: pg };
}

const reopen = async ({ memory, key }: Pick<Store, 'memory' | 'key'>): Promise<PGlite> =>
  (await openStore({ backend: shared(memory), key, mode: 'open' })).pg;

/** The store's records after `damage`, opened under `key`: the open must reject with `type`. */
async function openDamaged(
  { memory, key }: Pick<Store, 'memory' | 'key'>,
  damage: (r: Map<RecordKey, Uint8Array>, controlId: string) => void,
  type: abstract new (...args: never[]) => Error,
): Promise<Error> {
  const recs = await records(memory);
  damage(recs, idsOf(await inspect(memory, key), 'global/pg_control')[0] as string);
  return rejection(openStore({ backend: shared(await restore(recs)), key, mode: 'open' }), type);
}

describe('ported: pglite-basic', () => {
  it('creates a table and inserts data', async () => {
    const { db } = await fresh();
    await db.exec('CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
    await db.exec(`INSERT INTO users (name) VALUES ('alice'), ('bob')`);
    expect((await db.query('SELECT name FROM users ORDER BY id')).rows).toEqual([{ name: 'alice' }, { name: 'bob' }]);
    await db.close();
  }, 60_000);

  it('data survives close and reopen', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE persist_test (id SERIAL PRIMARY KEY, data TEXT)');
    await s.db.exec(`INSERT INTO persist_test (data) VALUES ('persistent')`);
    await s.db.close();
    const db2 = await reopen(s);
    expect((await db2.query('SELECT data FROM persist_test')).rows).toEqual([{ data: 'persistent' }]);
    await db2.close();
  }, 60_000);

  it('schema survives restart', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE schema_test (id INTEGER PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW(), metadata JSONB)');
    await s.db.close();
    const db2 = await reopen(s);
    await db2.exec(`INSERT INTO schema_test (id, metadata) VALUES (1, '{"key": "value"}')`);
    expect((await db2.query('SELECT id, metadata FROM schema_test')).rows).toEqual([{ id: 1, metadata: { key: 'value' } }]);
    await db2.close();
  }, 60_000);

  it('indexes survive restart', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE indexed_test (id INTEGER, name TEXT); CREATE INDEX idx_name ON indexed_test(name);');
    await s.db.exec(`INSERT INTO indexed_test VALUES (1, 'alice'), (2, 'bob')`);
    await s.db.close();
    const db2 = await reopen(s);
    await db2.exec('SET enable_seqscan = off');
    expect((await db2.query(`SELECT * FROM indexed_test WHERE name = 'bob'`)).rows).toEqual([{ id: 2, name: 'bob' }]);
    await db2.close();
  }, 60_000);

  it('sequences survive restart', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE seq_test (id SERIAL PRIMARY KEY, data TEXT)');
    await s.db.exec(`INSERT INTO seq_test (data) VALUES ('first'), ('second')`);
    await s.db.close();
    const db2 = await reopen(s);
    await db2.exec(`INSERT INTO seq_test (data) VALUES ('third')`);
    expect((await db2.query(`SELECT id FROM seq_test WHERE data = 'third'`)).rows).toEqual([{ id: 3 }]);
    await db2.close();
  }, 60_000);

  it('survives multiple restart cycles', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE multi_restart (id SERIAL PRIMARY KEY, cycle INTEGER)');
    await s.db.exec('INSERT INTO multi_restart (cycle) VALUES (1)');
    await s.db.close();
    for (const cycle of [2, 3]) {
      const db = await reopen(s);
      await db.exec(`INSERT INTO multi_restart (cycle) VALUES (${String(cycle)})`);
      await db.close();
    }
    const db = await reopen(s);
    expect((await db.query('SELECT cycle FROM multi_restart ORDER BY cycle')).rows).toEqual([{ cycle: 1 }, { cycle: 2 }, { cycle: 3 }]);
    await db.close();
  }, 60_000);

  it('SELECT with WHERE, JOIN, ORDER BY', async () => {
    const { db } = await fresh();
    await db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount INTEGER);
      INSERT INTO users VALUES (1, 'alice'), (2, 'bob');
      INSERT INTO orders VALUES (1, 1, 100), (2, 1, 200), (3, 2, 50);
    `);
    const result = await db.query<{ name: string; total: number }>(
      'SELECT u.name, SUM(o.amount)::int AS total FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY total DESC',
    );
    expect(result.rows).toEqual([{ name: 'alice', total: 300 }, { name: 'bob', total: 50 }]);
    await db.close();
  }, 60_000);

  it('UPDATE single and multiple rows, DELETE with conditions, NULL values', async () => {
    const { db } = await fresh();
    await db.exec(`
      CREATE TABLE update_test (id INTEGER PRIMARY KEY, status TEXT);
      INSERT INTO update_test VALUES (1, 'pending'), (2, 'pending'), (3, 'done');
    `);
    await db.exec(`UPDATE update_test SET status = 'processing' WHERE id = 1`);
    expect((await db.query('SELECT status FROM update_test WHERE id = 1')).rows).toEqual([{ status: 'processing' }]);
    await db.exec(`UPDATE update_test SET status = 'archived' WHERE status = 'pending'`);
    expect((await db.query(`SELECT id FROM update_test WHERE status = 'archived'`)).rows).toEqual([{ id: 2 }]);

    await db.exec(`CREATE TABLE delete_test (id INTEGER, category TEXT); INSERT INTO delete_test VALUES (1, 'a'), (2, 'b'), (3, 'a'), (4, 'b');`);
    await db.exec(`DELETE FROM delete_test WHERE category = 'a'`);
    expect((await db.query('SELECT count(*)::int AS count FROM delete_test')).rows).toEqual([{ count: 2 }]);

    await db.exec(`CREATE TABLE null_test (id INTEGER, value TEXT); INSERT INTO null_test VALUES (1, 'not null'), (2, NULL);`);
    expect((await db.query('SELECT * FROM null_test ORDER BY id')).rows).toEqual([{ id: 1, value: 'not null' }, { id: 2, value: null }]);
    await db.close();
  }, 60_000);

  it('a committed transaction persists, a rolled-back one does not', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE tx (id INTEGER, data TEXT)');
    await s.db.transaction(async (tx) => {
      await tx.exec(`INSERT INTO tx VALUES (1, 'committed')`);
    });
    await expect(
      s.db.transaction(async (tx) => {
        await tx.exec(`INSERT INTO tx VALUES (2, 'rolled back')`);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    await s.db.close();
    const db2 = await reopen(s);
    expect((await db2.query('SELECT id, data FROM tx')).rows).toEqual([{ id: 1, data: 'committed' }]);
    await db2.close();
  }, 60_000);

  it('data types survive a reopen: text, integers, floats, numeric, boolean, timestamp, JSONB, bytea, arrays', async () => {
    const s = await fresh();
    const binary = Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    await s.db.exec(`
      CREATE TABLE types (t TEXT, v VARCHAR(100), i INTEGER, b BIGINT, f FLOAT, n NUMERIC(10,2), active BOOLEAN,
        ts TIMESTAMP, data JSONB, bin BYTEA, nums INTEGER[], tags TEXT[]);
    `);
    await s.db.query(
      `INSERT INTO types VALUES ('hello', 'world', 42, 9223372036854775807, 3.14159, 123.45, true,
        '2024-01-15 10:30:00', '{"name": "test", "values": [1, 2, 3]}', $1, '{1,2,3}', '{"a","b","c"}')`,
      [binary],
    );
    await s.db.close();
    const db2 = await reopen(s);
    const row = (await db2.query<Record<string, unknown>>('SELECT * FROM types')).rows[0] ?? {};
    expect(row).toMatchObject({ t: 'hello', v: 'world', i: 42, b: 9223372036854775807n, n: '123.45', active: true });
    expect(row.f).toBeCloseTo(3.14159, 4);
    expect(row.ts).toBeInstanceOf(Date);
    expect(row.data).toEqual({ name: 'test', values: [1, 2, 3] });
    expect(row.bin).toEqual(binary);
    expect(row.nums).toEqual([1, 2, 3]);
    expect(row.tags).toEqual(['a', 'b', 'c']);
    expect((await db2.query(`SELECT data->>'name' AS name FROM types`)).rows).toEqual([{ name: 'test' }]);
    await db2.close();
  }, 60_000);

  it('large text fields and many rows survive a reopen', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE large_text (content TEXT); CREATE TABLE many_rows (id INTEGER, value TEXT);');
    await s.db.query('INSERT INTO large_text VALUES ($1)', ['x'.repeat(100 * 1024)]);
    for (let i = 0; i < 1000; i += 100) {
      const values = Array.from({ length: 100 }, (_, j) => `(${String(i + j)}, 'value${String(i + j)}')`);
      await s.db.exec(`INSERT INTO many_rows VALUES ${values.join(',')}`);
    }
    await s.db.close();
    const db2 = await reopen(s);
    expect((await db2.query('SELECT length(content) AS len FROM large_text')).rows).toEqual([{ len: 100 * 1024 }]);
    expect((await db2.query('SELECT count(*)::int AS count FROM many_rows')).rows).toEqual([{ count: 1000 }]);
    await db2.close();
  }, 60_000);

  it('stored values do not contain the inserted text', async () => {
    const s = await fresh();
    const secret = 'ported-secret-value-0123456789';
    await s.db.exec(`CREATE TABLE secrets (data TEXT); INSERT INTO secrets VALUES ('${secret}');`);
    await s.db.close();
    const needle = new TextEncoder().encode(secret);
    const contains = (v: Uint8Array) => v.some((_, i) => needle.every((b, j) => v[i + j] === b));
    expect([...(await records(s.memory)).values()].filter(contains)).toEqual([]);
  }, 60_000);
});

describe('ported: pglite-failure', () => {
  it('a wrong key gives WrongKeyError, with no key material in the message', async () => {
    const s = await fresh();
    await s.db.exec(`CREATE TABLE secret (data TEXT); INSERT INTO secret VALUES ('sensitive information');`);
    await s.db.close();
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const hex = toHex(raw);
    const error = await rejection(openStore({ backend: shared(s.memory), key: await importKek(raw.slice()), mode: 'open' }), WrongKeyError);
    expect(error.message.toLowerCase()).not.toContain(hex);
    expect(error.message).not.toContain('sensitive information');
  }, 60_000);

  it('a tampered page (pg_control) is refused at open', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE corrupt_test (id INTEGER, data TEXT)');
    for (let i = 0; i < 100; i++) await s.db.exec(`INSERT INTO corrupt_test VALUES (${String(i)}, '${'x'.repeat(100)}')`);
    await s.db.close();
    // A byte in the sealed bytes, and a byte in the nonce.
    for (const at of [100, 2]) {
      await openDamaged(s, (r, id) => {
        const v = (r.get(id) as Uint8Array).slice();
        v[at] = (v[at] ?? 0) ^ 0xff;
        r.set(id, v);
      }, CorruptStoreError);
    }
  }, 60_000);

  it('a truncated block is refused at open', async () => {
    const s = await fresh();
    await s.db.exec(`CREATE TABLE partial_test (id INTEGER, data TEXT); INSERT INTO partial_test VALUES (1, '${'x'.repeat(1000)}');`);
    await s.db.close();
    await openDamaged(s, (r, id) => r.set(id, (r.get(id) as Uint8Array).slice(0, 100)), CorruptStoreError);
  }, 60_000);

  it('a missing header is refused at open', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE t (id INTEGER)');
    await s.db.close();
    await openDamaged(s, (r) => {
      r.delete(0);
      r.delete(1);
    }, IncompleteStoreError);
  }, 60_000);

  it('handles rapid close and reopen without corruption', async () => {
    const s = await fresh();
    await s.db.exec('CREATE TABLE rapid_test (id SERIAL, data TEXT)');
    await s.db.close();
    for (let i = 0; i < 5; i++) {
      const db = await reopen(s);
      await db.exec(`INSERT INTO rapid_test (data) VALUES ('cycle ${String(i)}')`);
      await db.close();
    }
    const db = await reopen(s);
    expect((await db.query('SELECT count(*)::int AS count FROM rapid_test')).rows).toEqual([{ count: 5 }]);
    await db.close();
  }, 60_000);

  it('handles an empty database, and growth that forces new pages', async () => {
    const s = await fresh();
    await s.db.close();
    const db = await reopen(s);
    expect((await db.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
    await db.exec('CREATE TABLE growth_test (id INTEGER, data TEXT)');
    for (let i = 0; i < 100; i++) await db.exec(`INSERT INTO growth_test VALUES (${String(i)}, '${'x'.repeat(1000)}')`);
    await db.close();
    const db2 = await reopen(s);
    expect((await db2.query('SELECT count(*)::int AS count FROM growth_test')).rows).toEqual([{ count: 100 }]);
    await db2.close();
  }, 60_000);
});
