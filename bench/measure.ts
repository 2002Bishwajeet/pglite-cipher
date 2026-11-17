// What the benchmark page (bench.ts) and the perf gates (test/perf/gates.browser.test.ts) measure: a
// note-taking shaped database built on plain IdbFs and on EncryptedFs over IndexedDB, timed the same
// way, with gates G1-G4 and G9 (bench/README.md).
import { IdbFs, PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { live } from '@electric-sql/pglite/live';
import { EncryptedFs, IndexedDbBackend, importKek, type BlockSize, type SyncStats } from '../src/index.ts';
import { PAGE } from '../src/fs/pool.ts';

export type Json = Record<string, unknown>;
export const MB = 1024 * 1024;
export const now = (): number => performance.now();
export const round = (x: number): number => Math.round(x * 100) / 100;
export const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const pct = (xs: readonly number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
};
export interface Stat {
  p50: number;
  p95: number;
  max: number;
  n: number;
}
export const stat = (xs: readonly number[]): Stat => ({ p50: round(pct(xs, 50)), p95: round(pct(xs, 95)), max: round(Math.max(...xs)), n: xs.length });

// ---- the workload (kept from the spike, so the numbers compare) -------------------------------

const extensions = { live, pg_trgm };
/** PGlite settings the memory levers (#48) vary: Postgres settings through `startParams`. */
export type PgOptions = Pick<PGliteOptions, 'relaxedDurability' | 'startParams'>;
export const createPg = (fs: NonNullable<PGliteOptions['fs']>, opts: PgOptions = {}) => PGlite.create({ fs, extensions, ...opts });
export type Pg = Awaited<ReturnType<typeof createPg>>;

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
  CREATE FUNCTION bench_random_bytes(n int) RETURNS bytea LANGUAGE sql VOLATILE AS
    $$ SELECT decode(string_agg(md5(random()::text), ''), 'hex') FROM generate_series(1, (n + 15) / 16) $$;
`;

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  return out;
};

const walFile = async (pg: PGlite): Promise<string> =>
  (await pg.query<{ f: string }>('SELECT pg_walfile_name(pg_current_wal_insert_lsn()) AS f')).rows[0]?.f ?? '';

/** The schema, 50 documents, and `mb` MB of 1 MB update blobs (the caller checkpoints). */
async function build(pg: Pg, mb: number): Promise<string[]> {
  await pg.exec(SCHEMA);
  const docs = Array.from({ length: 50 }, () => crypto.randomUUID());
  for (const [i, doc] of docs.entries()) {
    await pg.query('INSERT INTO doc_search (doc_id, title, body) VALUES ($1, $2, $3)', [doc, `note ${String(i)}`, 'a body of text']);
  }
  const rows = 10;
  const values = Array.from({ length: rows }, (_, i) => `($1, $${String(i + 2)})`).join(', ');
  for (let bytes = 0; bytes < mb * MB; bytes += rows * MB) {
    await pg.query(`INSERT INTO doc_updates (doc_id, data) VALUES ${values}`, [docs[0], ...Array.from({ length: rows }, () => randomBytes(MB))]);
  }
  return docs;
}

// ---- the two filesystems, instrumented the same way ------------------------------------------

interface Sync {
  ms: number;
  /** EncryptedFs only: `stats().lastSync` of a sync that had something to write. */
  stats?: SyncStats;
}

class PlainFs extends IdbFs {
  readonly syncs: Sync[] = [];
  openStartedAt = 0;
  override async initialSyncFs(): Promise<void> {
    this.openStartedAt = now();
    await super.initialSyncFs();
  }
  override async syncToFs(relaxed?: boolean): Promise<void> {
    const t = now();
    await super.syncToFs(relaxed);
    this.syncs.push({ ms: now() - t });
  }
}

/** Wall time with at least one call in flight; overlapping calls count once. */
class Busy {
  #inFlight = 0;
  #since = 0;
  ms = 0;
  async time<T>(call: () => Promise<T>): Promise<T> {
    if (this.#inFlight++ === 0) this.#since = now();
    try {
      return await call();
    } finally {
      if (--this.#inFlight === 0) this.ms += now() - this.#since;
    }
  }
}

// The open's blocks phase, split (bench only): IndexedDB page reads and WebCrypto decrypts.
const reading = new Busy();
const decrypting = new Busy();
const subtle = globalThis.crypto.subtle;
const decrypt = subtle.decrypt.bind(subtle);
subtle.decrypt = (...args: Parameters<SubtleCrypto['decrypt']>) => decrypting.time(() => decrypt(...args));
const timedBackend = (name: string): [IndexedDbBackend, IndexedDbBackend] => {
  const pair = IndexedDbBackend.pair(name);
  for (const b of pair) {
    const readRange = b.readRange.bind(b);
    b.readRange = (after, limit) => reading.time(() => readRange(after, limit));
  }
  return pair;
};

class TimedFs extends EncryptedFs {
  readonly syncs: Sync[] = [];
  openStartedAt = 0;
  /** IndexedDB read and decrypt time of the last open. */
  openSplit = { readMs: 0, decryptMs: 0 };
  override async initialSyncFs(): Promise<void> {
    this.openStartedAt = now();
    const r = reading.ms;
    const d = decrypting.ms;
    await super.initialSyncFs();
    this.openSplit = { readMs: reading.ms - r, decryptMs: decrypting.ms - d };
  }
  override async syncToFs(relaxed?: boolean): Promise<void> {
    const dirty = this.hasDirty();
    const t = now();
    await super.syncToFs(relaxed);
    const ms = now() - t;
    const stats = dirty ? this.stats().lastSync : null;
    this.syncs.push(stats ? { ms, stats } : { ms });
  }
}

// Every IndexedDB connection the page opens. A closed IdbFs PGlite leaves its IDBFS connection
// open, and deleteDatabase then blocks forever, so leftovers are closed before deleting.
const connections = new Set<IDBDatabase>();
const idbOpen = indexedDB.open.bind(indexedDB);
indexedDB.open = (name: string, version?: number) => {
  const r = version === undefined ? idbOpen(name) : idbOpen(name, version);
  r.addEventListener('success', () => {
    connections.add(r.result);
  });
  return r;
};
export const dropIdb = (name: string): Promise<void> => {
  for (const c of connections) {
    if (c.name !== name) continue;
    c.close();
    connections.delete(c);
  }
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => {
      resolve();
    };
    r.onerror = () => {
      reject(r.error ?? new Error(`deleteDatabase ${name} failed`));
    };
  });
};

/**
 * The IndexedDB records that hold blocks in the pair named `name` (both databases), counted raw, so
 * that with bench/patches/pack.patch it is the records, not the blocks (#83).
 */
async function blockRecords(name: string): Promise<number> {
  let n = 0;
  for (const db of [`${name}.a`, `${name}.b`]) {
    const open = indexedDB.open(db, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('kv'); // as IndexedDbBackend makes it
    };
    const conn = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(open.error ?? new Error(`open ${db} failed`));
      };
    });
    try {
      const count = conn.transaction('kv', 'readonly').objectStore('kv').count(IDBKeyRange.lowerBound(''));
      n += await new Promise<number>((resolve, reject) => {
        count.onsuccess = () => {
          resolve(count.result);
        };
        count.onerror = () => {
          reject(count.error ?? new Error(`count ${db} failed`));
        };
      });
    } finally {
      conn.close();
      connections.delete(conn);
    }
  }
  return n;
}

export const newKek = (): Promise<CryptoKey> => importKek(crypto.getRandomValues(new Uint8Array(32)));

export type Kind = 'plain' | 'encrypted';
type AnyFs = PlainFs | TimedFs;

// ---- one variant ---------------------------------------------------------------------------

interface Sample {
  ms: Stat;
  /** EncryptedFs: summed over the syncs of each run. */
  tableBlocks?: Stat;
  dataBlocks?: Stat;
  /** EncryptedFs: runs that created, grew, shrank, renamed, removed or chmodded a file under PGDATA. */
  fileChanges?: number;
  /** EncryptedFs: runs that wrote a table block although no file changed (G9; the owner's rule on #2). */
  tableBlocksWithoutFileChange?: number;
  /** EncryptedFs: the most table blocks a run wrote per file it changed (G9: at most 1). */
  maxTableBlocksPerChangedFile?: number;
  /** EncryptedFs: the `stats().lastSync` breakdown, summed per run. */
  lastSync?: { bytes: Stat; deletes: Stat; encryptMs: Stat; commitMs: Stat; repacked: number };
}

interface TreeFS {
  readdir(path: string): string[];
  lstat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
}

/** Every node under PGDATA: its path, mode and size (0 for a directory). */
function nodes(pg: Pg): Array<{ path: string; mode: number; size: number }> {
  const FS = (pg.Module as unknown as { FS: TreeFS }).FS;
  const out: Array<{ path: string; mode: number; size: number }> = [];
  const visit = (dir: string) => {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const path = `${dir}/${name}`;
      const { mode, size } = FS.lstat(path);
      const isDir = FS.isDir(mode);
      out.push({ path, mode, size: isDir ? 0 : size });
      if (isDir) visit(path);
    }
  };
  visit('/pglite/data');
  return out;
}

/** Bytes in files per top-level entry of the data directory (`base`, `global`, `pg_wal`, ...; files at the top count as `.`). */
const dirBytes = (pg: Pg): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const n of nodes(pg)) {
    const parts = n.path.slice('/pglite/data/'.length).split('/');
    const top = parts.length > 1 ? (parts[0] ?? '.') : '.';
    out[top] = (out[top] ?? 0) + n.size;
  }
  return out;
};
export const wasmBytes = (pg: PGlite): number => (pg.Module as unknown as { HEAPU8: Uint8Array }).HEAPU8.byteLength;

/** The data directory as a file map: path to mode and size. */
const tree = (pg: Pg): Map<string, string> => new Map(nodes(pg).map((n) => [n.path, `${String(n.mode)} ${String(n.size)}`]));

/** Files created, grown, shrunk, chmodded or removed between two file maps (a rename is two). */
const changedFiles = (before: Map<string, string>, after: Map<string, string>): number => {
  let n = 0;
  for (const [path, v] of after) if (before.get(path) !== v) n++;
  for (const path of before.keys()) if (!after.has(path)) n++;
  return n;
};

/** Runs `op` n times; the syncs each run makes are summed (one per query or exec). */
async function sample(fs: () => AnyFs, pg: () => Pg, n: number, op: (i: number) => Promise<unknown>, prep?: () => Promise<unknown>): Promise<Sample> {
  const ms: number[] = [];
  const sums = { tableBlocks: [] as number[], dataBlocks: [] as number[], bytes: [] as number[], deletes: [] as number[], encryptMs: [] as number[], commitMs: [] as number[] };
  let repacked = 0;
  let fileChanges = 0;
  let unexplained = 0;
  let perFile = 0;
  for (let i = 0; i < n; i++) {
    await prep?.();
    const f = fs();
    const from = f.syncs.length;
    const before = f instanceof TimedFs ? tree(pg()) : null;
    await op(i);
    const syncs = f.syncs.slice(from);
    ms.push(syncs.reduce((a, s) => a + s.ms, 0));
    if (f instanceof TimedFs && before) {
      const st = syncs.flatMap((s) => (s.stats ? [s.stats] : []));
      for (const k of ['tableBlocks', 'dataBlocks', 'bytes', 'deletes', 'encryptMs', 'commitMs'] as const) sums[k].push(st.reduce((a, s) => a + s[k], 0));
      if (st.some((s) => s.repacked)) repacked++;
      // A file change comes from the file-map diff, not from the table write.
      const changed = changedFiles(before, tree(pg()));
      const written = st.reduce((a, s) => a + s.tableBlocks, 0);
      if (changed > 0) {
        fileChanges++;
        perFile = Math.max(perFile, written / changed);
      } else if (written > 0) unexplained++;
    }
  }
  if (sums.tableBlocks.length === 0) return { ms: stat(ms) };
  return {
    ms: stat(ms),
    tableBlocks: stat(sums.tableBlocks),
    dataBlocks: stat(sums.dataBlocks),
    fileChanges,
    tableBlocksWithoutFileChange: unexplained,
    maxTableBlocksPerChangedFile: round(perFile),
    lastSync: { bytes: stat(sums.bytes), deletes: stat(sums.deletes), encryptMs: stat(sums.encryptMs), commitMs: stat(sums.commitMs), repacked },
  };
}

async function memory(pg: Pg): Promise<Json> {
  const p = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    memory?: { usedJSHeapSize: number };
  };
  const wasmHeapBytes = wasmBytes(pg);
  let unavailable = '';
  if (p.measureUserAgentSpecificMemory && crossOriginIsolated) {
    try {
      const r = await Promise.race([p.measureUserAgentSpecificMemory(), sleep(30_000).then(() => undefined)]);
      if (r) return { source: 'measureUserAgentSpecificMemory', bytes: r.bytes, wasmHeapBytes };
    } catch (e) {
      unavailable = errorText(e); // headless Chromium throws SecurityError
    }
  }
  if (p.memory) return { source: 'performance.memory + wasm heap', bytes: p.memory.usedJSHeapSize + wasmHeapBytes, wasmHeapBytes, ...(unavailable ? { measureUserAgentSpecificMemory: unavailable } : {}) };
  return { source: 'not available', wasmHeapBytes };
}

export interface OpenResult {
  ms: Stat;
  /** EncryptedFs: `stats().lastOpen` and the file table of the last open. */
  tableMs?: Stat;
  blocksMs?: Stat;
  /** EncryptedFs, bench only: wall time of the open with an IndexedDB page read in flight, and with a decrypt in flight (they overlap). */
  readMs?: Stat;
  decryptMs?: Stat;
  tableBlocks?: number;
  tableFill?: number;
  dataBlocks?: number;
  files?: number;
  subkeys?: number;
}

export interface VariantResult {
  buildMs: number;
  /** The data directory after the build and its checkpoint: nodes, and bytes in files (G3's "database"); bytes per top-level directory before and after that checkpoint. */
  dataDir: { nodes: number; bytes: number; dirs: Record<string, number>; dirsBeforeCheckpoint: Record<string, number> };
  /** The wasm memory after the build (it never shrinks while the instance lives). */
  wasmAfterBuild: number;
  /** Bytes per top-level directory of the data directory after the last open, beside G3. */
  dirsAfterOpen: Record<string, number>;
  /** G1: the sync after a one-row UPDATE. */
  g1: Sample;
  /** G1b: the sync after one 4 KB insert. */
  g1b: Sample;
  /** G4: the sync of a WAL segment switch, with the runs that really switched. */
  g4: Sample & { switched: number };
  /** G2: the open, from initialSyncFs to Postgres ready. */
  g2: OpenResult;
  /** G3: memory after the last open. */
  g3: Json;
  /** EncryptedFs, G9 over every sync of the workload (build, G1, G1b, G4). */
  g9?: { syncs: number; tableBlocks: Stat; tableToDataBlocks: Stat; repacked: number };
  /** EncryptedFs: IndexedDB records holding blocks, and the blocks (table and data), after the build and after G4 (#83: with `?pack=`, blocks ÷ records is the fill). */
  store?: { afterBuild: { records: number; blocks: number }; afterG4: { records: number; blocks: number } };
  /** EncryptedFs: the opens of the store alone (no plain open in between), the key operations, then the same opens after the rotation. */
  keys?: { changeKeyMs: number; verifyMs: number; verifyOk: boolean; rotateDataKeyMs: number; openBeforeRotation: OpenResult; openAfterRotation: OpenResult };
  /** EncryptedFs: the store's records read as the open reads its blocks, nothing decrypted, once per G2 open (#63), beside `g2.readMs`. */
  readsOnly?: { ms: Stat; page: number; records: number; bytes: number };
  /** EncryptedFs: why the key operations failed, if they did (then there is no `keys`). */
  keysError?: string;
}

/** The opens of one variant, collected. */
class Opens {
  readonly ms: number[] = [];
  readonly tableMs: number[] = [];
  readonly blocksMs: number[] = [];
  readonly readMs: number[] = [];
  readonly decryptMs: number[] = [];
  record(fs: AnyFs): void {
    this.ms.push(now() - fs.openStartedAt);
    if (!(fs instanceof TimedFs)) return;
    const o = fs.stats().lastOpen;
    if (o) {
      this.tableMs.push(o.tableMs);
      this.blocksMs.push(o.blocksMs);
    }
    this.readMs.push(fs.openSplit.readMs);
    this.decryptMs.push(fs.openSplit.decryptMs);
  }
  result(fs: AnyFs): OpenResult {
    if (!(fs instanceof TimedFs)) return { ms: stat(this.ms) };
    const s = fs.stats();
    return {
      ms: stat(this.ms),
      tableMs: stat(this.tableMs),
      blocksMs: stat(this.blocksMs),
      readMs: stat(this.readMs),
      decryptMs: stat(this.decryptMs),
      tableBlocks: s.table.blocks,
      tableFill: round(s.table.fill),
      dataBlocks: s.dataBlocks,
      files: s.files,
      subkeys: s.subkeys,
    };
  }
}

/** One variant's database after the build and the syncs; `pg` is usable while `open` is true. */
interface Built {
  kind: Kind;
  label: string;
  key: { kek: CryptoKey };
  make: () => AnyFs;
  pgOptions: PgOptions;
  fs: AnyFs;
  pg: Pg;
  open: boolean;
  part: Omit<VariantResult, 'g2' | 'g3' | 'dirsAfterOpen' | 'keys'>;
}

/** Builds an `mb` MB database on one filesystem and measures G1, G1b and G4 (and, encrypted, G9), `runs` times each. */
async function buildVariant(kind: Kind, name: string, mb: number, runs: number, log: (msg: string) => void, pgOptions: PgOptions, blockSize?: BlockSize): Promise<Built> {
  const label = `${kind} ${String(mb)} MB`;
  const key = { kek: await newKek() };
  const make = (): AnyFs => (kind === 'plain' ? new PlainFs(name) : new TimedFs({ backend: timedBackend(name), key: key.kek, mode: 'open-or-create', ...(blockSize ? { blockSize } : {}) }));
  const fs = make();
  const cur = () => fs;
  log(`${label}: build`);
  const t0 = now();
  const pg = await createPg(fs, pgOptions);
  const docs = await build(pg, mb);
  const dirsBeforeCheckpoint = dirBytes(pg);
  await pg.exec('CHECKPOINT');
  const buildMs = round(now() - t0);
  const wasmAfterBuild = wasmBytes(pg);
  const dir = nodes(pg);
  const dataDir = { nodes: dir.length, bytes: dir.reduce((n, f) => n + f.size, 0), dirs: dirBytes(pg), dirsBeforeCheckpoint };
  const storeNow = async () => {
    if (!(fs instanceof TimedFs)) return undefined;
    const s = fs.stats();
    return { records: await blockRecords(name), blocks: s.table.blocks + s.dataBlocks };
  };
  const afterBuild = await storeNow();

  log(`${label}: G1, G1b`);
  const g1 = await sample(cur, () => pg, runs, (i) => pg.query('UPDATE doc_search SET body = $2 WHERE doc_id = $1', [docs[1], `edit ${String(i)}`]));
  const g1b = await sample(cur, () => pg, runs, () => pg.query('INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)', [docs[2], randomBytes(4096)]));

  log(`${label}: G4`);
  // Untimed before each run: a CHECKPOINT (so old segments are recycled and memory stays bounded)
  // and the current segment's name, to count the runs that really switched.
  let switched = 0;
  let before = '';
  const countSwitch = async () => {
    if (before && (await walFile(pg)) !== before) switched++;
  };
  const g4s = await sample(
    cur,
    () => pg,
    runs,
    () => pg.exec(`SELECT pg_switch_wal(); INSERT INTO doc_updates (doc_id, data) VALUES ('${docs[3] ?? ''}', bench_random_bytes(4096));`),
    async () => {
      await countSwitch();
      await pg.exec('CHECKPOINT');
      before = await walFile(pg);
    },
  );
  await countSwitch();
  const g4 = { ...g4s, switched };
  const afterG4 = await storeNow();
  const store = afterBuild && afterG4 ? { afterBuild, afterG4 } : undefined;

  let g9: VariantResult['g9'];
  if (fs instanceof TimedFs) {
    const all = fs.syncs.flatMap((s) => (s.stats ? [s.stats] : []));
    g9 = {
      syncs: all.length,
      tableBlocks: stat(all.map((s) => s.tableBlocks)),
      tableToDataBlocks: stat(all.filter((s) => s.dataBlocks > 0).map((s) => s.tableBlocks / s.dataBlocks)),
      repacked: all.filter((s) => s.repacked).length,
    };
  }
  return { kind, label, key, make, pgOptions, fs, pg, open: true, part: { buildMs, dataDir, wasmAfterBuild, g1, g1b, g4, ...(g9 ? { g9 } : {}), ...(store ? { store } : {}) } };
}

/** Closes the variant's PGlite if it is open, opens the data again and records the open. */
async function reopen(v: Built, into: Opens): Promise<void> {
  await shut(v);
  v.fs = v.make();
  v.pg = await createPg(v.fs, v.pgOptions);
  v.open = true;
  into.record(v.fs);
}

async function shut(v: Built): Promise<void> {
  if (v.open) await v.pg.close();
  v.open = false;
}

/**
 * The open's blocks phase without the decrypts (#63): every record of the store named `name`, read
 * with the open's `readRange` pages and the next page in flight, nothing decrypted or copied. The
 * page is the open's, PAGE records, or 32 MiB of them at a larger block size (#63, stage B).
 */
async function readsOnly(name: string, blockSize: number): Promise<{ ms: number; page: number; records: number; bytes: number }> {
  const pair = IndexedDbBackend.pair(name);
  try {
    const backend = (await pair[0].isEmpty()) ? pair[1] : pair[0];
    const page = Math.min(PAGE, (32 * MB) / blockSize);
    let records = 0;
    let bytes = 0;
    const t = now();
    for (let next: Promise<Array<[string, Uint8Array]>> | null = backend.readRange(null, page); next; ) {
      const got: Array<[string, Uint8Array]> = await next;
      next = got.length < page ? null : backend.readRange((got[got.length - 1] as [string, Uint8Array])[0], page);
      records += got.length;
      for (const [, v] of got) bytes += v.byteLength;
    }
    return { ms: now() - t, page, records, bytes };
  } finally {
    for (const b of pair) await b.close();
  }
}

/**
 * Builds the same `mb` MB database on plain IdbFs and on EncryptedFs and measures G1, G1b and G4
 * `runs` times each; then G2, `opens` opens per variant, plain and encrypted interleaved, so that a
 * machine that speeds up or slows down meanwhile moves both alike, and each after an untimed open of
 * the same variant, so that no timed open follows the other's (#41); G3 after the last open of each,
 * with the other closed; and with `keys` the encrypted one's opens alone, the key operations on it,
 * then its opens after the rotation. Deletes both databases at the end.
 */
export async function runPair(mb: number, runs: number, log: (msg: string) => void, opts?: { opens?: number; keys?: boolean; onlyEncrypted?: false; pgOptions?: PgOptions; blockSize?: BlockSize }): Promise<{ plain: VariantResult; encrypted: VariantResult }>;
/** With `onlyEncrypted` the plain database is neither built nor opened and there is no `plain`. */
export async function runPair(mb: number, runs: number, log: (msg: string) => void, opts: { opens?: number; keys?: boolean; onlyEncrypted: true; pgOptions?: PgOptions; blockSize?: BlockSize }): Promise<{ plain: undefined; encrypted: VariantResult }>;
export async function runPair(mb: number, runs: number, log: (msg: string) => void, opts: { opens?: number; keys?: boolean; onlyEncrypted?: boolean; pgOptions?: PgOptions; blockSize?: BlockSize } = {}): Promise<{ plain: VariantResult | undefined; encrypted: VariantResult }> {
  const id = crypto.randomUUID();
  const names = { plain: `bench-plain-${String(mb)}-${id}`, encrypted: `bench-encrypted-${String(mb)}-${id}` };
  const n = opts.opens ?? runs;
  const pgOptions = opts.pgOptions ?? {};
  const built: Built[] = [];
  try {
    let p: Built | undefined;
    if (!opts.onlyEncrypted) {
      p = await buildVariant('plain', names.plain, mb, runs, log, pgOptions);
      built.push(p);
      await shut(p);
    }
    const e = await buildVariant('encrypted', names.encrypted, mb, runs, log, pgOptions, opts.blockSize);
    built.push(e);
    await shut(e);

    const g2 = { plain: new Opens(), encrypted: new Opens() };
    const g3: Record<Kind, Json> = { plain: {}, encrypted: {} };
    const dirsAfterOpen: Record<Kind, Record<string, number>> = { plain: {}, encrypted: {} };
    for (let i = 0; i < n; i++) {
      for (const v of p ? [p, e] : [e]) {
        log(`${v.label}: G2 open ${String(i + 1)} of ${String(n)}`);
        // With both variants, an untimed open of this one first, so that a timed open follows an
        // open of its own database, never the other's: on the iPad a plain open just before an
        // encrypted one made that open 8× slower (#41).
        if (p) await reopen(v, new Opens());
        await reopen(v, g2[v.kind]);
        if (i < n - 1) await shut(v);
        else {
          log(`${v.label}: G3 memory`);
          g3[v.kind] = await memory(v.pg);
          dirsAfterOpen[v.kind] = dirBytes(v.pg);
          if (v === p) await shut(v);
        }
      }
    }
    const plain: VariantResult | undefined = p && { ...p.part, g2: g2.plain.result(p.fs), g3: g3.plain, dirsAfterOpen: dirsAfterOpen.plain };
    const encrypted: VariantResult = { ...e.part, g2: g2.encrypted.result(e.fs), g3: g3.encrypted, dirsAfterOpen: dirsAfterOpen.encrypted };

    // A diagnostic beside g2.readMs: a failure here is logged, it does not cost the part its gates.
    try {
      await shut(e);
      const reads: Array<Awaited<ReturnType<typeof readsOnly>>> = [];
      for (let i = 0; i < n; i++) {
        log(`${e.label}: reads only ${String(i + 1)} of ${String(n)}`);
        reads.push(await readsOnly(names.encrypted, opts.blockSize ?? 65536));
      }
      const last = reads[reads.length - 1];
      if (last) encrypted.readsOnly = { ms: stat(reads.map((r) => r.ms)), page: last.page, records: last.records, bytes: last.bytes };
    } catch (err) {
      log(`${e.label}: reads only failed: ${errorText(err)}`);
    }

    if (opts.keys && e.fs instanceof TimedFs) {
      // A failure here (Chromium's quota for a second 256 KiB store, #63) is recorded, not thrown, so
      // that the part keeps G1 to G4.
      try {
        // The same opens as after the rotation, on the store as G2 opened it: without a plain open in
        // between, so that beside openAfterRotation they show what the rewrite alone changes (#41).
        const before = new Opens();
        for (let i = 0; i < n; i++) {
          log(`${e.label}: open before the rotation ${String(i + 1)} of ${String(n)}`);
          await reopen(e, before);
        }
        const openBeforeRotation = before.result(e.fs);
        log(`${e.label}: changeKey, verify, rotateDataKey`);
        const next = await newKek();
        let t = now();
        await e.fs.changeKey(next);
        const changeKeyMs = round(now() - t);
        e.key.kek = next;
        t = now();
        const verified = await e.fs.verify();
        const verifyMs = round(now() - t);
        t = now();
        await e.fs.rotateDataKey();
        const rotateDataKeyMs = round(now() - t);
        const after = new Opens();
        for (let i = 0; i < n; i++) {
          log(`${e.label}: open after the rotation ${String(i + 1)} of ${String(n)}`);
          await reopen(e, after);
        }
        encrypted.keys = { changeKeyMs, verifyMs, verifyOk: verified.ok, rotateDataKeyMs, openBeforeRotation, openAfterRotation: after.result(e.fs) };
      } catch (err) {
        encrypted.keysError = errorText(err);
      }
    }
    return { plain, encrypted };
  } finally {
    for (const v of built) await shut(v);
    log(`${String(mb)} MB: delete the databases`);
    if (!opts.onlyEncrypted) await dropIdb(`/pglite/${names.plain}`);
    for (const db of [`${names.encrypted}.a`, `${names.encrypted}.b`]) await dropIdb(db);
  }
}

/** The ratios the perf gates assert, all against the plain run of the same session. */
export const ratios = (plain: VariantResult, enc: VariantResult) => ({
  /** G1: encrypted p50 ÷ plain p50 of the one-row-update sync (gate ≤ 2). */
  g1: round(enc.g1.ms.p50 / plain.g1.ms.p50),
  /** G2: encrypted open p50 ÷ plain open p50 (gate ≤ 2). */
  g2: round(enc.g2.ms.p50 / plain.g2.ms.p50),
  /** G4: encrypted segment-switch sync p50 ÷ plain normal (one-row-update) sync p50 (gate ≤ 10). */
  g4: round(enc.g4.ms.p50 / plain.g1.ms.p50),
  /** For the record, not asserted: the same switch ÷ the encrypted normal sync. */
  g4ToEncryptedSync: round(enc.g4.ms.p50 / enc.g1.ms.p50),
  /** For the record, not asserted: the encrypted switch ÷ the plain switch. */
  g4ToPlainSwitch: round(enc.g4.ms.p50 / plain.g4.ms.p50),
  /** G9: file-table phase p50 ÷ encrypted open p50 (gate ≤ 0.05). */
  g9Open: Math.round(((enc.g2.tableMs?.p50 ?? NaN) / enc.g2.ms.p50) * 10_000) / 10_000,
});
