// Real engine: a note-taking workload on a PGlite whose MEMFS carries the tracker, with the model
// store fed only by its snapshots. After every query batch the model must equal PGDATA. Then the
// database is reopened from the model store alone, through loadState.
import { MemoryFS, PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { live } from '@electric-sql/pglite/live';
import { describe, expect, it } from 'vitest';
import { installTracker, type Tracker } from '../../src/tracker/tracker.ts';
import { ModelStore, checkModel, type TestFS } from './harness.ts';

const PGDATA = '/pglite/data';
const B = 8192;

/** MemoryFS with the tracker on PGDATA; with `from`, PGDATA is first rebuilt from that model store. */
class TrackedFS extends MemoryFS {
  tracker: Tracker | undefined;
  /** The module's FS, kept: `pg.Module` is gone after close. */
  emfs: TestFS | undefined;
  readonly #from: ModelStore | undefined;

  constructor(from?: ModelStore) {
    super();
    this.#from = from;
  }

  override async init(pg: PGlite, opts: Parameters<MemoryFS['init']>[1]) {
    const { emscriptenOpts } = await super.init(pg, opts);
    const install = (mod: { FS: unknown }) => {
      const fs = mod.FS as TestFS;
      this.emfs = fs;
      this.tracker = installTracker(fs, fs.filesystems.MEMFS, PGDATA, B);
    };
    return { emscriptenOpts: { ...emscriptenOpts, preRun: [...(emscriptenOpts.preRun ?? []), install] } };
  }

  override initialSyncFs(): Promise<void> {
    if (this.#from && this.emfs && this.tracker) {
      rebuild(this.emfs, this.#from);
      this.tracker.loadState(this.#from.storedFiles());
    }
    return Promise.resolve();
  }

  /** Snapshot, apply to the model store, commit; then the model must equal PGDATA. */
  sync(model: ModelStore): void {
    const { tracker, emfs } = this;
    if (!tracker || !emfs) throw new Error('tracker not installed');
    const snap = tracker.snapshot();
    model.apply(snap);
    tracker.commit(snap);
    checkModel(emfs, PGDATA, model);
    expect(tracker.stats.trackingGaps).toBe(0);
  }
}

/** What an open does: every stored node written back under PGDATA. */
function rebuild(fs: TestFS, model: ModelStore): void {
  fs.mkdirTree(PGDATA);
  fs.chmod(PGDATA, 0o700);
  const depth = (path: string) => path.split('/').length;
  const files = [...model.files.values()].sort((a, b) => depth(a.inode.path) - depth(b.inode.path));
  for (const file of files) {
    const { path, type, mode, target } = file.inode;
    const full = `${PGDATA}/${path}`;
    if (type === 'directory') fs.mkdir(full, mode & 0o7777);
    else if (type === 'symlink') fs.symlink(target ?? '', full);
    else {
      fs.writeFile(full, model.read(file));
      fs.chmod(full, mode & 0o7777);
    }
  }
}

const SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE TABLE doc_updates (id SERIAL PRIMARY KEY, doc_id UUID NOT NULL, blob BYTEA NOT NULL);
  CREATE INDEX doc_updates_doc ON doc_updates (doc_id);
  CREATE TABLE doc_search (
    doc_id UUID PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, meta JSONB NOT NULL, tsv TSVECTOR NOT NULL
  );
  CREATE INDEX doc_search_tsv ON doc_search USING GIN (tsv);
  CREATE INDEX doc_search_trgm ON doc_search USING GIN (title gin_trgm_ops);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value JSONB NOT NULL);
`;

// n rows of 4 KB of incompressible bytes (256 md5 digests).
const insertBlobs = (n: number) => `
  INSERT INTO doc_updates (doc_id, blob)
  SELECT gen_random_uuid(),
         decode((SELECT string_agg(md5(random()::text || g::text || i::text), '') FROM generate_series(1, 256) g), 'hex')
  FROM generate_series(1, ${String(n)}) i;
`;

const SEARCH = `
  INSERT INTO doc_search
  SELECT gen_random_uuid(), 'note title ' || i, repeat('lorem ipsum dolor ', 30) || i,
         jsonb_build_object('i', i, 'tags', jsonb_build_array('a', 'b')), to_tsvector('english', 'note body ' || i)
  FROM generate_series(1, 500) i;
`;

const UPDATES = `
  UPDATE doc_updates SET blob = decode(md5(blob::text) || md5(id::text), 'hex') WHERE id % 7 = 0;
  UPDATE doc_search SET body = body || ' edited', tsv = to_tsvector('english', body || ' edited')
    WHERE (meta->>'i')::int % 3 = 0;
  UPDATE kv SET value = jsonb_set(value, '{v}', to_jsonb((value->>'v')::int + 1));
`;

const DELETES = `
  DELETE FROM doc_updates WHERE id % 5 = 0;
  DELETE FROM doc_search WHERE (meta->>'i')::int % 10 = 0;
  DELETE FROM kv WHERE key LIKE 'key-1%';
`;

const DIGEST = `
  SELECT (SELECT count(*) FROM doc_updates)::int AS blobs,
         (SELECT md5(string_agg(md5(blob), '' ORDER BY id)) FROM doc_updates) AS blob_hash,
         (SELECT count(*) FROM doc_search WHERE tsv @@ to_tsquery('english', 'edited'))::int AS edited,
         (SELECT count(*) FROM doc_search WHERE title % 'note title 42')::int AS similar,
         (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM kv) AS kv_hash
`;

async function walSegment(pg: PGlite): Promise<number> {
  const { rows } = await pg.query<{ f: string }>('SELECT pg_walfile_name(pg_current_wal_lsn()) AS f');
  return parseInt(rows[0]?.f.slice(8) ?? '', 16);
}

describe('tracker on the real engine', () => {
  it(
    'the model store equals PGDATA after every query batch, and reopens',
    async () => {
      const model = new ModelStore(B);

      const fs = new TrackedFS();
      const pg = await PGlite.create({ fs, extensions: { live, pg_trgm } });
      const batch = async (run: () => Promise<unknown>) => {
        await run();
        fs.sync(model);
      };
      fs.sync(model); // initdb and startup

      await batch(() => pg.exec(SCHEMA));
      const counts: number[] = [];
      const liveQuery = await pg.live.query<{ n: number }>('SELECT count(*)::int AS n FROM doc_search', [], (r) => {
        counts.push(r.rows[0]?.n ?? -1);
      });
      fs.sync(model);
      for (let i = 0; i < 10; i++) await batch(() => pg.exec(insertBlobs(200)));
      await batch(() => pg.exec(SEARCH));
      await batch(() => pg.exec(`INSERT INTO kv SELECT 'key-' || i, jsonb_build_object('v', i) FROM generate_series(1, 300) i`));
      await batch(() => pg.exec(UPDATES));
      await batch(() => pg.exec(DELETES));
      await batch(() => pg.exec('VACUUM'));
      await batch(() => pg.exec('CHECKPOINT'));
      const first = await walSegment(pg);
      for (let i = 0; (await walSegment(pg)) < first + 2; i++) {
        if (i === 100) throw new Error('the WAL did not switch segment twice');
        await batch(() => pg.exec(insertBlobs(500)));
      }
      await batch(() => pg.exec('CHECKPOINT')); // recycles the old segments
      const digest = (await pg.query(DIGEST)).rows[0];
      await liveQuery.unsubscribe();
      expect(counts.at(-1)).toBe(450);
      await pg.close();
      fs.sync(model); // the shutdown checkpoint

      const reopened = new TrackedFS(model);
      const pg2 = await PGlite.create({ fs: reopened, extensions: { live, pg_trgm } });
      reopened.sync(model);
      expect((await pg2.query(DIGEST)).rows[0]).toEqual(digest);
      await pg2.exec(insertBlobs(50));
      reopened.sync(model);
      await pg2.close();
      reopened.sync(model);
    },
    600_000,
  );
});
