// Throwaway spike code (issue #2): a note-taking shaped workload of its own.
import { PGlite } from '@electric-sql/pglite';
import type { PGliteOptions } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { live } from '@electric-sql/pglite/live';

export const extensions = { live, pg_trgm };

export const createPg = (fs: NonNullable<PGliteOptions['fs']>, opts: { relaxedDurability?: boolean } = {}) =>
  PGlite.create({ fs, extensions, ...opts });

export type Pg = Awaited<ReturnType<typeof createPg>>;

export const TABLES = ['doc_updates', 'doc_search', 'kv'] as const;

export const SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE TABLE doc_updates (
    id bigserial PRIMARY KEY,
    doc_id uuid NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX doc_updates_doc ON doc_updates (doc_id, id);
  CREATE TABLE doc_search (
    doc_id uuid PRIMARY KEY,
    title text NOT NULL,
    body text NOT NULL,
    meta jsonb NOT NULL DEFAULT '{}',
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || body)) STORED
  );
  CREATE INDEX doc_search_tsv ON doc_search USING gin (tsv);
  CREATE INDEX doc_search_title_trgm ON doc_search USING gin (title gin_trgm_ops);
  CREATE TABLE kv (key text PRIMARY KEY, value jsonb NOT NULL);
  CREATE FUNCTION spike_random_bytes(n int) RETURNS bytea LANGUAGE sql VOLATILE AS
    $$ SELECT decode(string_agg(md5(random()::text), ''), 'hex') FROM generate_series(1, (n + 15) / 16) $$;
`;

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(' ');
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(' ');

export const randomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  return out;
};

export interface DbSummary {
  counts: Record<string, number>;
  blobChecksum: string;
}

export async function summarize(pg: PGlite): Promise<DbSummary> {
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
    counts[t] = r.rows[0]?.n ?? -1;
  }
  const sum = await pg.query<{ s: string | null }>(
    `SELECT md5(string_agg(md5(data), ',' ORDER BY id)) AS s FROM doc_updates`,
  );
  return { counts, blobChecksum: sum.rows[0]?.s ?? '' };
}

export const walFile = async (pg: PGlite): Promise<string> =>
  (await pg.query<{ f: string }>('SELECT pg_walfile_name(pg_current_wal_insert_lsn()) AS f')).rows[0]?.f ?? '';

export interface WorkloadOptions {
  inserts: number;
  blobBytes: number;
  walSwitches: number;
}

export const FULL: WorkloadOptions = { inserts: 2000, blobBytes: 4096, walSwitches: 2 };

export interface WorkloadResult {
  beforeClose: DbSummary;
  afterReopen: DbSummary;
  walFiles: string[];
}

/**
 * initdb, the schema, inserts, updates, deletes, VACUUM, CHECKPOINT, writes until the WAL switches
 * segment `walSwitches` times, close, reopen. `open(reopen)` returns a started PGlite on the
 * filesystem under test; `mark` names the phase that the following operations belong to.
 */
export async function runWorkload(
  open: (reopen: boolean) => Promise<Pg>,
  mark: (phase: string) => void,
  opts: WorkloadOptions = FULL,
): Promise<WorkloadResult> {
  mark('initdb');
  let pg = await open(false);

  mark('schema');
  await pg.exec(SCHEMA);
  const liveCount = await pg.live.query<{ n: number }>('SELECT count(*)::int AS n FROM doc_search', [], () => undefined);

  const docs = Array.from({ length: 50 }, () => crypto.randomUUID());
  mark('insert');
  for (let i = 0; i < opts.inserts; i++) {
    const doc = docs[i % docs.length] ?? '';
    await pg.query('INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)', [doc, randomBytes(opts.blobBytes)]);
    if (i % 20 === 0) {
      await pg.query(
        `INSERT INTO doc_search (doc_id, title, body, meta) VALUES ($1, $2, $3, $4)
         ON CONFLICT (doc_id) DO UPDATE SET title = excluded.title, body = excluded.body, meta = excluded.meta`,
        [doc, words(4, i), words(60, i), JSON.stringify({ rev: i, tags: [words(1, i)] })],
      );
      await pg.query('INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
        `pref.${String(i % 30)}`,
        JSON.stringify({ i }),
      ]);
    }
  }

  mark('update');
  for (let i = 0; i < 200; i++) {
    await pg.query('UPDATE doc_search SET body = $2, meta = meta || $3 WHERE doc_id = $1', [
      docs[i % docs.length] ?? '',
      words(80, i + 1000),
      JSON.stringify({ edited: i }),
    ]);
  }
  mark('transaction');
  for (let i = 0; i < 20; i++) {
    await pg.transaction(async (tx) => {
      await tx.query('INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)', [docs[i] ?? '', randomBytes(opts.blobBytes)]);
      await tx.query('UPDATE kv SET value = $2 WHERE key = $1', [`pref.${String(i)}`, JSON.stringify({ tx: i })]);
    });
  }

  mark('delete');
  await pg.query('DELETE FROM doc_updates WHERE id % 4 = 0');
  await pg.query("DELETE FROM kv WHERE key LIKE 'pref.1%'");
  mark('vacuum');
  await pg.exec('VACUUM');
  mark('checkpoint');
  await pg.exec('CHECKPOINT');

  mark('wal-switch');
  const walFiles = [await walFile(pg)];
  for (let i = 0; walFiles.length <= opts.walSwitches; i++) {
    if (i > 2000) throw new Error('WAL did not switch segment');
    await pg.query('INSERT INTO doc_updates (doc_id, data) SELECT $1, spike_random_bytes($2) FROM generate_series(1, 64)', [
      docs[i % docs.length] ?? '',
      opts.blobBytes,
    ]);
    const f = await walFile(pg);
    if (f !== walFiles[walFiles.length - 1]) walFiles.push(f);
  }

  const beforeClose = await summarize(pg);
  await liveCount.unsubscribe();
  mark('close');
  await pg.close();

  mark('reopen');
  pg = await open(true);
  const afterReopen = await summarize(pg);
  mark('after-reopen');
  await pg.query('UPDATE kv SET value = $2 WHERE key = $1', ['pref.2', JSON.stringify({ reopened: true })]);
  mark('close');
  await pg.close();
  return { beforeClose, afterReopen, walFiles };
}
