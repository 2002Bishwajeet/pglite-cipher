// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// Scenarios ported from davidmuggleton/pglite-encrypted-fs (MIT, see THIRD_PARTY.md), adapted to a KEK and a backend.
// Its passphrase-only cases have no counterpart.
import type { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
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
  it('both of two tables read back after a reopen (the baseline of its sibling-corruption case)', async () => {
    // Its corruption half has no counterpart: here any damaged record refuses the whole open.
    const s = await fresh();
    await s.db.exec('CREATE TABLE table_a (id INTEGER); INSERT INTO table_a VALUES (1), (2), (3);');
    await s.db.exec('CREATE TABLE table_b (id INTEGER); INSERT INTO table_b VALUES (10), (20), (30);');
    await s.db.close();
    const db = await reopen(s);
    expect((await db.query('SELECT count(*)::int AS count FROM table_a')).rows).toEqual([{ count: 3 }]);
    expect((await db.query('SELECT count(*)::int AS count FROM table_b')).rows).toEqual([{ count: 3 }]);
    await db.close();
  }, 60_000);
});

describe('ported: pglite-pgvector (an extension with its own index access methods)', () => {
  const withVector = { pglite: { extensions: { vector } } };
  const freshVector = async (): Promise<Store> => {
    const memory = new MemoryBackend();
    const key = await newKey();
    const { pg } = await openStore({ backend: shared(memory), key, ...withVector });
    await pg.exec('CREATE EXTENSION IF NOT EXISTS vector');
    return { memory, key, db: pg };
  };
  const reopenVector = async ({ memory, key }: Pick<Store, 'memory' | 'key'>): Promise<PGlite> =>
    (await openStore({ backend: shared(memory), key, mode: 'open', ...withVector })).pg;
  // Deterministic in place of its Math.random(): the same points on every engine.
  const point = (i: number, dims = 3) => `[${Array.from({ length: dims }, (_, d) => Math.abs(Math.sin(i * 7 + d * 13)).toFixed(6)).join(',')}]`;
  const ids = (rows: unknown[]) => rows.map((r) => (r as { id: number }).id);

  it('installs vector, stores a vector column, and orders by L2, cosine and inner-product distance', async () => {
    const { db } = await freshVector();
    expect((await db.query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`)).rows).toHaveLength(1);
    await db.exec(`CREATE TABLE docs (id INTEGER, embedding vector(3)); INSERT INTO docs VALUES (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0.9,0.1,0]'), (4, '[2,0,0]');`);
    expect((await db.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'docs' AND column_name = 'embedding'`)).rows).toHaveLength(1);
    expect(ids((await db.query(`SELECT id FROM docs WHERE id < 4 ORDER BY embedding <-> '[1,0,0]' LIMIT 2`)).rows)).toEqual([1, 3]);
    expect(ids((await db.query(`SELECT id FROM docs WHERE id < 4 ORDER BY embedding <=> '[1,0,0]' LIMIT 2`)).rows)).toEqual([1, 3]);
    expect(ids((await db.query(`SELECT id FROM docs WHERE id <> 3 ORDER BY embedding <#> '[1,0,0]' LIMIT 2`)).rows)).toEqual([4, 1]);
    await db.close();
  }, 60_000);

  it('builds IVFFlat and HNSW indexes, and a search scans the HNSW index', async () => {
    const { db } = await freshVector();
    await db.exec('CREATE TABLE items (id INTEGER, embedding vector(3))');
    for (let i = 0; i < 100; i++) await db.exec(`INSERT INTO items VALUES (${String(i)}, '${point(i)}')`);
    await db.exec('CREATE INDEX items_ivfflat ON items USING ivfflat (embedding vector_l2_ops) WITH (lists = 10)');
    await db.exec('CREATE INDEX items_hnsw ON items USING hnsw (embedding vector_l2_ops) WITH (m = 16, ef_construction = 64)');
    expect((await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'items' ORDER BY 1`)).rows).toEqual([{ indexname: 'items_hnsw' }, { indexname: 'items_ivfflat' }]);
    await db.exec('DROP INDEX items_ivfflat; SET enable_seqscan = off; SET hnsw.ef_search = 40;');
    const plan = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT id FROM items ORDER BY embedding <-> '[0.5,0.5,0.5]' LIMIT 5`)).rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('items_hnsw');
    expect((await db.query(`SELECT id FROM items ORDER BY embedding <-> '[0.5,0.5,0.5]' LIMIT 5`)).rows).toHaveLength(5);
    await db.close();
  }, 60_000);

  it('vector rows, the extension and an HNSW index survive a restart, and the search works after it', async () => {
    const s = await freshVector();
    await s.db.exec('CREATE TABLE persist (id INTEGER, embedding vector(3))');
    for (let i = 0; i < 50; i++) await s.db.exec(`INSERT INTO persist VALUES (${String(i)}, '${point(i)}')`);
    await s.db.exec(`INSERT INTO persist VALUES (100, '[1,0,0]'); CREATE INDEX persist_hnsw ON persist USING hnsw (embedding vector_l2_ops);`);
    await s.db.exec('SET enable_seqscan = off');
    const before = ids((await s.db.query(`SELECT id FROM persist ORDER BY embedding <-> '[0.5,0.5,0.5]' LIMIT 3`)).rows);
    await s.db.close();
    const db = await reopenVector(s);
    expect((await db.query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`)).rows).toHaveLength(1);
    expect((await db.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'persist_hnsw'`)).rows).toHaveLength(1);
    expect((await db.query('SELECT count(*)::int AS count FROM persist')).rows).toEqual([{ count: 51 }]);
    await db.exec('SET enable_seqscan = off');
    expect(ids((await db.query(`SELECT id FROM persist ORDER BY embedding <-> '[0.5,0.5,0.5]' LIMIT 3`)).rows)).toEqual(before);
    expect(ids((await db.query(`SELECT id FROM persist ORDER BY embedding <-> '[1,0,0]' LIMIT 1`)).rows)).toEqual([100]);
    await db.exec(`INSERT INTO persist VALUES (101, '[1,1,1]')`);
    await db.close();
  }, 60_000);

  it('1536-dimension vectors survive a restart and are found by similarity', async () => {
    const s = await freshVector();
    await s.db.exec('CREATE TABLE openai_embeddings (id INTEGER, embedding vector(1536))');
    const v1 = point(1, 1536);
    await s.db.query('INSERT INTO openai_embeddings VALUES (1, $1), (2, $2)', [v1, point(2, 1536)]);
    await s.db.close();
    const db = await reopenVector(s);
    expect((await db.query('SELECT count(*)::int AS count FROM openai_embeddings')).rows).toEqual([{ count: 2 }]);
    expect(ids((await db.query('SELECT id FROM openai_embeddings ORDER BY embedding <-> $1 LIMIT 1', [v1])).rows)).toEqual([1]);
    await db.close();
  }, 60_000);
});
