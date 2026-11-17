// A PGlite instance on EncryptedFs survives close and reopen with all data; pg_trgm and live work.
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { live, type PGliteWithLive } from '@electric-sql/pglite/live';
import { describe, expect, it } from 'vitest';
import { IndexedDbBackend } from '../../src/backend/indexeddb.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import type { StorageBackend } from '../../src/backend/backend.ts';
import type { OpenProgress } from '../../src/encryptedFs.ts';
import { BLOCK_SIZES, newKey, openStore, shared } from './helpers.ts';

const extensions = { live, pg_trgm };

const SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE TABLE notes (id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX notes_title_trgm ON notes USING GIN (title gin_trgm_ops);
  INSERT INTO notes (title, body) SELECT 'note title ' || i, repeat('lorem ipsum ', 50) || i FROM generate_series(1, 300) i;
`;

const stores: Array<[string, () => () => StorageBackend]> = [
  [
    'MemoryBackend',
    () => {
      const memory = new MemoryBackend();
      return () => shared(memory);
    },
  ],
  [
    'IndexedDbBackend',
    () => {
      const name = `roundtrip-${crypto.randomUUID()}`;
      return () => new IndexedDbBackend(name);
    },
  ],
];

describe('round trip', () => {
  for (const [name, makeStore] of stores) {
    it(`creates with initdb, closes and reopens with mode "open" (${name})`, async () => {
      const key = await newKey();
      const connect = makeStore();
      const a = await openStore({ backend: connect(), key, mode: 'create', initdb: true, pglite: { extensions } });
      await a.pg.exec(SCHEMA);
      expect(a.fs.stats().trackingGaps).toBe(0);
      await a.pg.close();

      const b = await openStore({ backend: connect(), key, mode: 'open', pglite: { extensions } });
      const { rows } = await b.pg.query<{ n: number }>('SELECT count(*)::int AS n FROM notes');
      expect(rows[0]?.n).toBe(300);
      const similar = await b.pg.query<{ title: string }>(`SELECT title FROM notes WHERE title % 'note title 42' ORDER BY similarity(title, 'note title 42') DESC LIMIT 1`);
      expect(similar.rows[0]?.title).toBe('note title 42');
      const counts: number[] = [];
      const liveQuery = await (b.pg as unknown as PGliteWithLive).live.query<{ n: number }>('SELECT count(*)::int AS n FROM notes', [], (r) => {
        counts.push(r.rows[0]?.n ?? -1);
      });
      await b.pg.exec(`INSERT INTO notes (title, body) VALUES ('one more', 'x')`);
      await expect.poll(() => counts.at(-1)).toBe(301);
      await liveQuery.unsubscribe();
      expect(b.fs.stats().trackingGaps).toBe(0);
      await b.pg.close();
    }, 120_000);
  }

  for (const blockSize of BLOCK_SIZES) {
    it(`round-trips at ${String(blockSize)}-byte blocks`, async () => {
      const key = await newKey();
      const memory = new MemoryBackend();
      const a = await openStore({ backend: shared(memory), key, blockSize });
      await a.pg.exec(`CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT i, md5(i::text) FROM generate_series(1, 2000) i;`);
      const before = (await a.pg.query('SELECT md5(string_agg(v, \',\' ORDER BY id)) AS h FROM t')).rows[0];
      await a.pg.close();
      const stored = (await memory.count()) - 3;
      const progress: OpenProgress[] = [];
      const b = await openStore({ backend: shared(memory), key, mode: 'open', onProgress: (p) => progress.push(p) });
      expect((await b.pg.query('SELECT md5(string_agg(v, \',\' ORDER BY id)) AS h FROM t')).rows[0]).toEqual(before);
      expect([...new Set(progress.map((p) => p.phase))]).toEqual(['table', 'blocks']);
      const last = progress.at(-1) as OpenProgress;
      expect(last.done).toBe(last.total);
      expect(last.total).toBe(stored);
      expect(b.fs.stats().lastOpen).not.toBeNull();
      await b.pg.close();
    }, 120_000);
  }
});
