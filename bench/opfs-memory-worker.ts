// Research measurement for issue #43 (docs/research/opfs-on-demand.md); not part of the package.
// One dedicated worker file, two roles by worker name:
//   "pg"     opens PGlite on idb:// or opfs-ahp:// and reports what the data directory costs in
//            memory; probes features and the sync access handle limit; and is the synchronous side
//            of the Atomics bridge (blocks in Atomics.wait while the "crypto" worker decrypts).
//   "crypto" the asynchronous side of the bridge: reads a sealed 8 KB page from OPFS, opens it
//            with crypto.subtle (AES-256-GCM) and hands the plaintext back through a SharedArrayBuffer.
import { PGlite } from '@electric-sql/pglite';

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
const PAGE = 8192;
const REC = 12 + PAGE + 16;
const now = () => performance.now();
const round = (x: number) => Math.round(x * 1000) / 1000;
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const scope = self as unknown as {
  name: string;
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => round(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN);
  return { n: s.length, mean: round(s.reduce((a, b) => a + b, 0) / s.length), p50: at(0.5), p95: at(0.95), max: at(1) };
}

// ---- role "pg": PGlite memory ----

let pg: PGlite | undefined;
const fsOf = (p: PGlite) => (p.Module as unknown as { FS: MiniFS }).FS;

/** Bytes MEMFS holds in JS typed arrays under `path` (capacity, as allocated). */
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

function snapshot(p: PGlite) {
  (globalThis as { gc?: () => void }).gc?.();
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return {
    wasmBytes: (p.Module as unknown as { HEAPU8: Uint8Array }).HEAPU8.byteLength,
    memfsBytes: memfsBytes(fsOf(p), '/'),
    jsHeapBytes: heap ? heap.usedJSHeapSize : null,
  };
}

const live = () => {
  if (!pg) throw new Error('not open');
  return pg;
};

const pgOps: Record<string, (a: Record<string, unknown>) => unknown> = {
  features: () => ({
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    atomicsWaitAsync: typeof (Atomics as { waitAsync?: unknown }).waitAsync === 'function',
    opfs: typeof navigator.storage.getDirectory === 'function',
    createSyncAccessHandle: typeof FileSystemFileHandle === 'function' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype,
    jspi: 'Suspending' in WebAssembly && 'promising' in WebAssembly,
  }),

  async handles(a) {
    const n = Number(a.n);
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('probe-handles', { create: true });
    const open: FileSystemSyncAccessHandle[] = [];
    let error: string | null = null;
    try {
      for (let i = 0; i < n; i++) {
        const fh = await dir.getFileHandle(`f${String(i)}`, { create: true });
        open.push(await fh.createSyncAccessHandle());
      }
    } catch (e) {
      error = errText(e);
    }
    const opened = open.length;
    let cleanupError: string | null = null;
    try {
      for (const h of open) h.close();
      await root.removeEntry('probe-handles', { recursive: true });
    } catch (e) {
      cleanupError = errText(e);
    }
    return { requested: n, opened, error, cleanupError };
  },

  async build(a) {
    const t = now();
    const p = await PGlite.create({ dataDir: String(a.dataDir) });
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
    const result = { rows: next - 1, dbBytes: await dbBytes(p), dataDirBytes: dataDirBytes(p), ms: Math.round(now() - t) };
    await p.close();
    return result;
  },

  async open(a) {
    const t = now();
    pg = await PGlite.create({ dataDir: String(a.dataDir) });
    await pg.query('select 1');
    const openMs = Math.round(now() - t);
    const sb = (await pg.query<{ s: string }>("select current_setting('shared_buffers') as s")).rows[0]?.s;
    return { openMs, sharedBuffers: sb, dbBytes: await dbBytes(pg), dataDirBytes: dataDirBytes(pg), mem: snapshot(pg) };
  },

  async query(a) {
    const p = live();
    const t = now();
    const r = await p.query(String(a.sql));
    return { ms: Math.round(now() - t), rows: r.rows, mem: snapshot(p) };
  },

  async close() {
    await pg?.close();
    pg = undefined;
    return {};
  },

  // The synchronous side of the bridge, as a PGlite filesystem's read() would be.
  async bridgeRun(a) {
    const sab = a.sab as SharedArrayBuffer;
    const port = a.port as MessagePort;
    const pages = Number(a.pages);
    const reads = Number(a.reads);
    const ctrl = new Int32Array(sab, 0, 2);
    const data = new Uint8Array(sab, 8, PAGE);
    const out = new Uint8Array(PAGE);
    const view = new DataView(out.buffer);
    const times: number[] = [];
    let mismatches = 0;
    const t0 = now();
    for (let k = 0; k < reads; k++) {
      const idx = (k * 7919) % pages;
      Atomics.store(ctrl, 0, 0);
      const t = now();
      port.postMessage(idx);
      Atomics.wait(ctrl, 0, 0);
      out.set(data);
      times.push(now() - t);
      if (view.getUint32(0) !== idx) mismatches++;
    }
    const total = now() - t0;

    // Baseline: the same reads of plaintext straight from a sync access handle (what opfs-ahp does).
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('plain.bin', { create: true });
    const sh = await fh.createSyncAccessHandle();
    sh.truncate(0);
    for (let i = 0; i < pages; i++) sh.write(new Uint8Array(PAGE).fill(i & 0xff), { at: i * PAGE });
    sh.flush();
    const plain: number[] = [];
    const p0 = now();
    for (let k = 0; k < reads; k++) {
      const t = now();
      sh.read(out, { at: ((k * 7919) % pages) * PAGE });
      plain.push(now() - t);
    }
    const plainTotal = now() - p0;
    sh.close();
    await root.removeEntry('plain.bin');
    return {
      roundTripMs: { ...stats(times), meanFromTotal: round(total / reads) },
      plainReadMs: { ...stats(plain), meanFromTotal: round(plainTotal / reads) },
      mismatches,
    };
  },
};

// ---- role "crypto": the asynchronous side of the bridge ----

let served: number[] = [];
let bridgeSh: FileSystemSyncAccessHandle | undefined;

const cryptoOps: Record<string, (a: Record<string, unknown>) => unknown> = {
  async bridgeSetup(a) {
    const pages = Number(a.pages);
    const sab = a.sab as SharedArrayBuffer;
    const port = a.port as MessagePort;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('bridge.bin', { create: true });
    const sh = await fh.createSyncAccessHandle();
    bridgeSh = sh;
    sh.truncate(0);
    for (let i = 0; i < pages; i++) {
      const pt = new Uint8Array(PAGE);
      new DataView(pt.buffer).setUint32(0, i);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
      const rec = new Uint8Array(REC);
      rec.set(iv);
      rec.set(ct, 12);
      sh.write(rec, { at: i * REC });
    }
    sh.flush();
    const ctrl = new Int32Array(sab, 0, 2);
    const data = new Uint8Array(sab, 8, PAGE);
    const rec = new Uint8Array(REC);
    served = [];
    port.onmessage = (ev: MessageEvent) => {
      const idx = ev.data as number;
      void (async () => {
        const t = now();
        sh.read(rec, { at: idx * REC });
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.subarray(0, 12) }, key, rec.subarray(12));
        data.set(new Uint8Array(pt));
        served.push(now() - t);
        Atomics.store(ctrl, 0, 1);
        Atomics.notify(ctrl, 0);
      })();
    };
    return { pages };
  },

  async bridgeStats() {
    bridgeSh?.close();
    bridgeSh = undefined;
    await (await navigator.storage.getDirectory()).removeEntry('bridge.bin');
    return { readAndDecryptMs: stats(served) };
  },
};

const ops = scope.name === 'crypto' ? cryptoOps : pgOps;
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
