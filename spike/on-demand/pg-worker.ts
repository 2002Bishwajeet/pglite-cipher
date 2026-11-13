// Throwaway spike code (issue #47): the PG worker. Runs PGlite on the on-demand filesystem of fs.ts
// (the bridge to io-worker.ts) or on idb://, builds the database of docs/research/opfs-on-demand.md
// 1.2, opens it, runs the queries and reports what the data directory costs in memory; also probes
// the features and the sync access handle limit. Driven by part.ts.
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { OnDemandFs, type OnDemandStats } from './fs.ts';

interface Req {
  id: number;
  op: string;
  args: Record<string, unknown>;
}
interface FsNode {
  contents?: unknown;
}
interface MiniFS {
  readdir(path: string): string[];
  lstat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  lookupPath(path: string, opts: { follow: boolean }): { path: string; node: FsNode };
}

const MB = 1024 * 1024;
const now = () => performance.now();
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const scope = self as unknown as { postMessage(msg: unknown): void; onmessage: ((ev: MessageEvent) => void) | null };

let pg: PGlite | undefined;
let odfs: OnDemandFs | undefined;
const fsOf = (p: PGlite) => (p.Module as unknown as { FS: MiniFS }).FS;
const live = () => {
  if (!pg) throw new Error('not open');
  return pg;
};

/** Bytes MEMFS holds in JS typed arrays (capacity, as allocated); the on-demand mount holds none. */
function memfsBytes(FS: MiniFS, path: string): number {
  let total = 0;
  for (const name of FS.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const p = path === '/' ? `/${name}` : `${path}/${name}`;
    if (p === '/dev' || p === '/proc') continue;
    const st = FS.lstat(p);
    if (FS.isDir(st.mode)) total += memfsBytes(FS, p);
    else {
      const { contents } = FS.lookupPath(p, { follow: false }).node;
      if (ArrayBuffer.isView(contents)) total += contents.byteLength;
    }
  }
  return total;
}

/** Sum of file sizes in the data directory, whichever filesystem holds it. */
function fileBytes(FS: MiniFS, path: string): number {
  let total = 0;
  for (const name of FS.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const p = `${path}/${name}`;
    const st = FS.lstat(p);
    if (FS.isDir(st.mode)) total += fileBytes(FS, p);
    else if (FS.isFile(st.mode)) total += st.size;
  }
  return total;
}

const dataDirBytes = (p: PGlite) => {
  const FS = fsOf(p);
  return fileBytes(FS, FS.lookupPath('/pglite/data', { follow: true }).path);
};

async function dbBytes(p: PGlite): Promise<number> {
  const r = await p.query<{ b: string }>('select pg_database_size(current_database())::text as b');
  return Number(r.rows[0]?.b);
}

const mem = (p: PGlite) => ({ wasmBytes: (p.Module as unknown as { HEAPU8: Uint8Array }).HEAPU8.byteLength, memfsBytes: memfsBytes(fsOf(p), '/') });

const round = (x: number) => Math.round(x * 1000) / 1000;
const fsStats = (): OnDemandStats | null => (odfs ? { ...odfs.stats } : null);
/** What the on-demand filesystem did between two fsStats() snapshots, with the mean time per read and write. */
function fsDelta(before: OnDemandStats | null) {
  const after = fsStats();
  if (!before || !after) return null;
  const d = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, round(v - before[k as keyof OnDemandStats])])) as unknown as OnDemandStats;
  return { ...d, treeBytes: after.treeBytes, readMeanMs: d.reads ? round(d.readMs / d.reads) : null, writeMeanMs: d.writes ? round(d.writeMs / d.writes) : null };
}

/** PGlite options: the on-demand filesystem (sab and port from part.ts) or idb://<name>. */
function options(a: Record<string, unknown>): PGliteOptions {
  const name = String(a.name);
  if (a.fs === 'idb') {
    odfs = undefined;
    return { dataDir: `idb://${name}` };
  }
  odfs = new OnDemandFs(name, a.sab as SharedArrayBuffer, a.port as MessagePort);
  return { fs: odfs };
}

const ops: Record<string, (a: Record<string, unknown>) => unknown> = {
  async features() {
    let syncAccessHandle: string;
    try {
      const root = await navigator.storage.getDirectory();
      const sh = await (await root.getFileHandle('od-probe.bin', { create: true })).createSyncAccessHandle();
      sh.write(new Uint8Array([1, 2, 3]), { at: 0 });
      syncAccessHandle = sh.getSize() === 3 ? 'works' : 'wrong size';
      sh.close();
      await root.removeEntry('od-probe.bin');
    } catch (e) {
      syncAccessHandle = errText(e);
    }
    return {
      userAgent: navigator.userAgent,
      crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      opfs: typeof (navigator.storage as { getDirectory?: unknown }).getDirectory === 'function',
      syncAccessHandle,
    };
  },

  /** Opens up to n sync access handles at once; stops at the first failure. */
  async handles(a) {
    const n = Number(a.n);
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('od-probe-handles', { create: true });
    const open: FileSystemSyncAccessHandle[] = [];
    let stoppedBy: string | null = null;
    const t = now();
    try {
      for (let i = 0; i < n; i++) open.push(await (await dir.getFileHandle(`f${String(i)}`, { create: true })).createSyncAccessHandle());
    } catch (e) {
      stoppedBy = errText(e);
    }
    const ms = Math.round(now() - t);
    let cleanupError: string | null = null;
    try {
      for (const h of open) h.close();
      await root.removeEntry('od-probe-handles', { recursive: true });
    } catch (e) {
      cleanupError = errText(e);
    }
    return { requested: n, opened: open.length, stoppedBy, ms, cleanupError };
  },

  async build(a) {
    const t = now();
    const p = await PGlite.create(options(a));
    const initMs = Math.round(now() - t);
    await p.exec('create table if not exists t (id int primary key, payload text)');
    // ~1 KB of distinct hex per row: under the TOAST threshold, so it is stored uncompressed.
    const target = Number(a.mb) * MB;
    const batch = 10_000;
    let next = 1;
    while ((await dbBytes(p)) < target) {
      await p.query(
        `insert into t select g, (select string_agg(md5(g::text || ':' || i::text), '') from generate_series(1, 30) i)
         from generate_series($1::int, $2::int) g`,
        [next, next + batch - 1],
      );
      next += batch;
    }
    await p.exec('checkpoint');
    const result = { rows: next - 1, dbBytes: await dbBytes(p), dataDirBytes: dataDirBytes(p), initMs, ms: Math.round(now() - t), fs: fsStats() };
    await p.close();
    return { ...result, containerBytes: odfs?.containerBytes ?? null };
  },

  async open(a) {
    const t = now();
    pg = await PGlite.create(options(a));
    await pg.query('select 1');
    const openMs = Math.round(now() - t);
    const sb = (await pg.query<{ s: string }>("select current_setting('shared_buffers') as s")).rows[0]?.s;
    return { openMs, sharedBuffers: sb, dbBytes: await dbBytes(pg), dataDirBytes: dataDirBytes(pg), mem: mem(pg), fs: fsStats() };
  },

  async query(a) {
    const p = live();
    const before = fsStats();
    const t = now();
    const r = await p.query(String(a.sql));
    return { ms: Math.round(now() - t), rows: r.rows, mem: mem(p), fs: fsDelta(before) };
  },

  async close() {
    await pg?.close();
    pg = undefined;
    return { containerBytes: odfs?.containerBytes ?? null };
  },
};

scope.onmessage = (ev: MessageEvent) => {
  const { id, op, args } = ev.data as Req;
  void (async () => {
    try {
      const fn = ops[op];
      if (!fn) throw new Error(`unknown op ${op}`);
      scope.postMessage({ id, result: await fn(args) });
    } catch (e) {
      scope.postMessage({ id, error: errText(e) });
    }
  })();
};
