// Throwaway spike code (issue #2): the benchmark page. Builds a database with plain IdbFs and with
// the prototype at 8, 32 and 64 KB, and measures gates G1-G9 of docs/plan/03. Nothing here ships.
import { IdbFs } from '@electric-sql/pglite';
import { dirStats, fsOf } from '../spike/memfs.ts';
import { ProtoFS, STORE, deleteDb, deriveSubkey, done, importMasterKey, openDb, req } from '../spike/protoFs.ts';
import type { BlockSize } from '../spike/protoFs.ts';
import { SCHEMA, createPg, randomBytes, walFile } from '../spike/workload.ts';
import type { Pg } from '../spike/workload.ts';
import { runG7 } from './g7.ts';

type Json = Record<string, unknown>;
const now = () => performance.now();
const MB = 1024 * 1024;
const BLOCK_SIZES: BlockSize[] = [8192, 32768, 65536];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const round = (x: number) => Math.round(x * 100) / 100;

const pct = (xs: readonly number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
};
interface Stat {
  p50: number;
  p95: number;
  max: number;
  n: number;
}
const stat = (xs: readonly number[]): Stat => ({ p50: round(pct(xs, 50)), p95: round(pct(xs, 95)), max: round(Math.max(...xs)), n: xs.length });

const statusEl = document.getElementById('status');
const outEl = document.getElementById('out');
const log = (msg: string) => {
  if (statusEl) statusEl.textContent = msg;
  console.log(`[bench] ${msg}`);
};
const errorText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// ---- the two filesystems, instrumented the same way ------------------------------------------

class PlainFS extends IdbFs {
  readonly syncStats: { ms: number }[] = [];
  openStartedAt = 0;
  override async initialSyncFs(): Promise<void> {
    this.openStartedAt = now();
    await super.initialSyncFs();
  }
  override async syncToFs(relaxed?: boolean): Promise<void> {
    const t = now();
    await super.syncToFs(relaxed);
    this.syncStats.push({ ms: now() - t });
  }
}

// Every IndexedDB connection the page opens. A closed IdbFs PGlite leaves its IDBFS connection
// open, and deleteDatabase then blocks forever, so the page closes leftovers before deleting.
const connections = new Set<IDBDatabase>();
const idbOpen = indexedDB.open.bind(indexedDB);
indexedDB.open = (name: string, version?: number) => {
  const r = version === undefined ? idbOpen(name) : idbOpen(name, version);
  r.addEventListener('success', () => {
    connections.add(r.result);
  });
  return r;
};
const dropIdb = (name: string) => {
  for (const c of connections) {
    if (c.name !== name) continue;
    c.close();
    connections.delete(c);
  }
  return deleteDb(name);
};

type Kind = 'plain' | BlockSize;
type AnyFs = PlainFS | ProtoFS;
const label = (k: Kind) => (k === 'plain' ? 'plain' : `proto-${String(k / 1024)}k`);
const makeFs = (k: Kind, name: string, key: CryptoKey): AnyFs =>
  k === 'plain' ? new PlainFS(name) : new ProtoFS({ name, key, blockSize: k });
const dropDb = (k: Kind, name: string) => dropIdb(k === 'plain' ? `/pglite/${name}` : name);

interface Sample {
  ms: Stat;
  tableBlocks?: Stat;
  dataBlocks?: Stat;
  /** Runs that grew, created, shrank, renamed or removed a file (the prototype only). */
  fileChanges?: number;
  /** Runs that wrote a table block although no file changed: the STOP condition of #2. */
  tableBlocksWithoutFileChange?: number;
}

/** Runs `op` n times; the syncs each run makes are summed (one per query or exec). */
async function sample(fs: () => AnyFs, n: number, op: (i: number) => Promise<unknown>, prep?: (i: number) => Promise<unknown>): Promise<Sample> {
  const ms: number[] = [];
  const table: number[] = [];
  const data: number[] = [];
  let fileChanges = 0;
  let unexplained = 0;
  for (let i = 0; i < n; i++) {
    await prep?.(i);
    const f = fs();
    const from = f.syncStats.length;
    await op(i);
    const syncs = f.syncStats.slice(from);
    ms.push(syncs.reduce((a, s) => a + s.ms, 0));
    if (f instanceof ProtoFS) {
      const ps = f.syncStats.slice(from);
      table.push(ps.reduce((a, s) => a + s.tableBlocks, 0));
      data.push(ps.reduce((a, s) => a + s.dataBlocks, 0));
      if (ps.some((s) => s.entries > 0)) fileChanges++;
      if (ps.some((s) => s.entries === 0 && s.tableBlocks > 0)) unexplained++;
    }
  }
  return {
    ms: stat(ms),
    ...(table.length > 0 ? { tableBlocks: stat(table), dataBlocks: stat(data), fileChanges, tableBlocksWithoutFileChange: unexplained } : {}),
  };
}

async function memory(pg: Pg): Promise<Json> {
  const p = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    memory?: { usedJSHeapSize: number };
  };
  const wasmHeapBytes = (pg.Module as unknown as { HEAPU8: Uint8Array }).HEAPU8.byteLength;
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

// ---- gates at one database size ---------------------------------------------------------------

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
  await pg.exec('CHECKPOINT');
  return docs;
}

interface VariantResult {
  buildMs: number;
  dataDir?: { files: number; bytes: number; records: number };
  g1: Sample;
  g1b: Sample;
  g4: Sample & { switched: number };
  g2: { ms: Stat; protoOpenMs?: Stat; fileMapMs?: Stat; tableBlocks?: number; blocks?: number; salts?: number };
  g3: Json;
  g9?: { syncs: number; tableBlocksPerSync: Stat; tableBlocksPerChangingSync: Stat; changingSyncs: number };
}

async function runVariant(kind: Kind, mb: number, runs: number, key: CryptoKey): Promise<VariantResult> {
  const name = `bench-${label(kind)}-${String(mb)}-${crypto.randomUUID()}`;
  let fs = makeFs(kind, name, key);
  const cur = () => fs;
  try {
    log(`${label(kind)} ${String(mb)} MB: build`);
    const t0 = now();
    let pg = await createPg(fs);
    const docs = await build(pg, mb);
    const buildMs = round(now() - t0);
    const dataDir = fs instanceof ProtoFS ? dirStats(fsOf(pg)) : undefined;

    log(`${label(kind)} ${String(mb)} MB: G1, G1b`);
    const g1 = await sample(cur, runs, (i) => pg.query('UPDATE doc_search SET body = $2 WHERE doc_id = $1', [docs[1], `edit ${String(i)}`]));
    const g1b = await sample(cur, runs, () => pg.query('INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)', [docs[2], randomBytes(4096)]));

    log(`${label(kind)} ${String(mb)} MB: G4`);
    // Untimed before each run: a CHECKPOINT (so old segments are recycled and memory stays bounded)
    // and the current segment's name, to count the runs that really switched.
    let switched = 0;
    let before = '';
    const countSwitch = async () => {
      if (before && (await walFile(pg)) !== before) switched++;
    };
    const g4s = await sample(
      cur,
      runs,
      () => pg.exec(`SELECT pg_switch_wal(); INSERT INTO doc_updates (doc_id, data) VALUES ('${docs[3] ?? ''}', spike_random_bytes(4096));`),
      async () => {
        await countSwitch();
        await pg.exec('CHECKPOINT');
        before = await walFile(pg);
      },
    );
    await countSwitch();
    const g4 = { ...g4s, switched };

    let g9: VariantResult['g9'];
    if (fs instanceof ProtoFS) {
      const all = fs.syncStats.map((s) => s.tableBlocks);
      const changing = fs.syncStats.filter((s) => s.entries > 0).map((s) => s.tableBlocks);
      g9 = { syncs: all.length, tableBlocksPerSync: stat(all), tableBlocksPerChangingSync: stat(changing), changingSyncs: changing.length };
    }

    log(`${label(kind)} ${String(mb)} MB: G2`);
    const open: number[] = [];
    const protoOpen: number[] = [];
    const fileMap: number[] = [];
    let g3: Json = {};
    for (let i = 0; i < runs; i++) {
      await pg.close();
      log(`${label(kind)} ${String(mb)} MB: G2 open ${String(i + 1)} of ${String(runs)}`);
      fs = makeFs(kind, name, key);
      pg = await createPg(fs);
      open.push(now() - fs.openStartedAt);
      if (fs instanceof ProtoFS && fs.openStat) {
        protoOpen.push(fs.openStat.totalMs);
        fileMap.push(fs.openStat.fileMapMs);
      }
      if (i === runs - 1) {
        log(`${label(kind)} ${String(mb)} MB: G3 memory`);
        g3 = await memory(pg);
      }
    }
    const os = fs instanceof ProtoFS ? fs.openStat : undefined;
    const g2: VariantResult['g2'] = {
      ms: stat(open),
      ...(os ? { protoOpenMs: stat(protoOpen), fileMapMs: stat(fileMap), tableBlocks: os.tableBlocks, blocks: os.blocks, salts: os.salts } : {}),
    };
    await pg.close();
    const records = fs instanceof ProtoFS ? (await ProtoFS.liveSalts(name)).records : 0;
    return {
      buildMs,
      ...(dataDir ? { dataDir: { files: dataDir.files, bytes: dataDir.bytes, records } } : {}),
      g1,
      g1b,
      g4,
      g2,
      g3,
      ...(g9 ? { g9 } : {}),
    };
  } finally {
    log(`${label(kind)} ${String(mb)} MB: delete the database`);
    await dropDb(kind, name);
  }
}

function judge(mb: number, v: Record<string, VariantResult>): Json {
  const plain = v.plain;
  // Owner decision on #2: at 10 MB, G2 is ≤ 2× plain only (plain idb:// alone misses 400 ms). The
  // 400 ms figure still sets the G9 file-map budget (5 % of it, 20 ms), which the decision left as it was.
  const budget = mb >= 100 ? 1500 : 400;
  const g2Budget = mb >= 100 ? 1500 : Infinity;
  const out: Json = { g2BudgetMs: mb >= 100 ? 1500 : '2× plain only', note: 'p50 throughout; p95 is beside it in the variant numbers' };
  const passG2: number[] = [];
  for (const bs of BLOCK_SIZES) {
    const r = v[label(bs)];
    if (!r || !plain) continue;
    const g2 = r.g2.ms.p50 <= 2 * plain.g2.ms.p50 && r.g2.ms.p50 <= g2Budget;
    if (g2) passG2.push(bs);
    const mem = r.g3.bytes;
    out[label(bs)] = {
      G1: r.g1.ms.p50 <= 2 * plain.g1.ms.p50,
      G1b: (r.g1b.tableBlocks?.p50 ?? Infinity) <= 1 && r.g1b.ms.p50 <= 2 * plain.g1b.ms.p50,
      G2: g2,
      G3: typeof mem === 'number' && r.dataDir ? mem <= r.dataDir.bytes + 64 * MB : 'not available',
      G4: r.g4.ms.p50 <= 500,
      // G9 strictly: every G1 sync wrote no table block. G9_fileMap and G9_g1p50 split it up; a G1
      // sync that grew a file (a GIN pending-list page, say) is counted in g1.fileChanges.
      G9: (r.g2.fileMapMs?.p50 ?? Infinity) <= 0.05 * budget && r.g1.tableBlocks?.max === 0,
      G9_fileMap: (r.g2.fileMapMs?.p50 ?? Infinity) <= 0.05 * budget,
      G9_g1p50: r.g1.tableBlocks?.p50 === 0,
    };
  }
  out.G5 = passG2.length > 0 ? Math.min(...passG2) : 'none passes G2';
  return out;
}

async function runGates(mb: number, runs: number): Promise<Json> {
  const key = await importMasterKey(crypto.getRandomValues(new Uint8Array(32)));
  const variants: Record<string, VariantResult> = {};
  for (const kind of ['plain', ...BLOCK_SIZES] as Kind[]) variants[label(kind)] = await runVariant(kind, mb, runs, key);
  return { sizeMB: mb, variants, gates: judge(mb, variants) };
}

// ---- G6 support, G8 deriveKey, AES-GCM micro-benchmark ----------------------------------------

async function support(): Promise<Json> {
  const r: Json = {};
  const check = async (k: string, fn: () => Promise<unknown>) => {
    try {
      r[k] = await fn();
    } catch (e) {
      r[k] = `error: ${errorText(e)}`;
    }
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = crypto.getRandomValues(new Uint8Array(64));
  await check('aesGcm', async () => {
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, plain);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct)).every((x, i) => x === plain[i]);
  });
  const deriveWorks = async (base: CryptoKey) => {
    const sub = await deriveSubkey(base, crypto.getRandomValues(new Uint8Array(16)));
    return (await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sub, plain)).byteLength === 80;
  };
  await check('hkdfDeriveKeyToAesGcm', async () => deriveWorks(await importMasterKey(crypto.getRandomValues(new Uint8Array(32)))));
  await check('unwrapKeyRawIntoHkdf', async () => {
    const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'unwrapKey']);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, crypto.getRandomValues(new Uint8Array(32)));
    const base = await crypto.subtle.unwrapKey('raw', wrapped, kek, { name: 'AES-GCM', iv }, 'HKDF', false, ['deriveKey']);
    return deriveWorks(base);
  });

  const name = `bench-g6-${crypto.randomUUID()}`;
  const db = await openDb(name);
  try {
    for (const durability of ['strict', 'relaxed'] as const) {
      await check(`idbDurability_${durability}`, async () => {
        const tx = db.transaction(STORE, 'readwrite', { durability });
        tx.objectStore(STORE).put(1, 'durability-probe');
        const got = tx.durability;
        await done(tx);
        return got;
      });
    }
    await check('idbNumberKeysOrderedFirst', async () => {
      const tx = db.transaction(STORE, 'readwrite');
      const s = tx.objectStore(STORE);
      for (const k of ['b'.repeat(32), 2, 'a'.repeat(32), 1]) s.put(0, k);
      s.delete('durability-probe');
      await done(tx);
      const keys = await req(db.transaction(STORE).objectStore(STORE).getAllKeys());
      return JSON.stringify(keys) === JSON.stringify([1, 2, 'a'.repeat(32), 'b'.repeat(32)]);
    });
    await check('idbStringKeyRangeGetAll', async () => {
      const vals = await req(db.transaction(STORE).objectStore(STORE).getAll(IDBKeyRange.lowerBound(''), 512));
      return vals.length === 2;
    });
    await check('idb2048PutsThen2048DeletesMs', async () => {
      const ids = Array.from({ length: 2048 }, () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
      const rec = crypto.getRandomValues(new Uint8Array(44 + 8192));
      let t = now();
      let tx = db.transaction(STORE, 'readwrite');
      for (const id of ids) tx.objectStore(STORE).put(rec, id);
      await done(tx);
      const puts = round(now() - t);
      t = now();
      tx = db.transaction(STORE, 'readwrite');
      for (const id of ids) tx.objectStore(STORE).delete(id);
      await done(tx);
      return { puts, deletes: round(now() - t) };
    });
  } finally {
    db.close();
    await dropIdb(name);
  }
  return r;
}

async function deriveKeyMs(n: number): Promise<Stat> {
  const master = await importMasterKey(crypto.getRandomValues(new Uint8Array(32)));
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const t = now();
    await deriveSubkey(master, salt);
    ms.push(now() - t);
  }
  return { ...stat(ms), p50: Math.round(pct(ms, 50) * 1000) / 1000 };
}

/** The browser version of docs/plan/gcmbench.mjs: 100 MB at each unit, 64 calls in flight. */
async function gcmMicro(): Promise<Json> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const aad = new Uint8Array(24);
  const out: Json = {};
  for (const unit of BLOCK_SIZES) {
    log(`AES-GCM micro ${String(unit / 1024)} KB`);
    const n = Math.ceil((100 * MB) / unit);
    const block = crypto.getRandomValues(new Uint8Array(unit));
    const cts = new Array<[Uint8Array<ArrayBuffer>, ArrayBuffer]>(n);
    let t = now();
    for (let i = 0; i < n; i += 64) {
      await Promise.all(
        Array.from({ length: Math.min(64, n - i) }, async (_, j) => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          cts[i + j] = [iv, await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, block)];
        }),
      );
    }
    const enc = now() - t;
    t = now();
    for (let i = 0; i < n; i += 64) {
      await Promise.all(cts.slice(i, i + 64).map(([iv, ct]) => crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct)));
    }
    const dec = now() - t;
    out[`${String(unit / 1024)}k`] = {
      calls: n,
      encryptMs: round(enc),
      encryptMBps: round((100 / enc) * 1000),
      encryptUsPerCall: round((enc / n) * 1000),
      decryptMs: round(dec),
      decryptMBps: round((100 / dec) * 1000),
      decryptUsPerCall: round((dec / n) * 1000),
    };
  }
  return out;
}

async function runExtras(): Promise<Json> {
  log('G6 support');
  const g6 = await support();
  log('G8 deriveKey x1000');
  const g8DeriveKeyMs = await deriveKeyMs(1000);
  const aesGcm = await gcmMicro();
  return { g6, g8DeriveKeyMs, aesGcm };
}

/** G8: 365 open/edit/checkpoint/close sessions; how many session salts still own a live record. */
async function runYear(sessions: number, blockSize: BlockSize): Promise<Json> {
  const name = `bench-year-${crypto.randomUUID()}`;
  const key = await importMasterKey(crypto.getRandomValues(new Uint8Array(32)));
  const t0 = now();
  try {
    let pg = await createPg(new ProtoFS({ name, key, blockSize }));
    await pg.exec(SCHEMA);
    const doc = crypto.randomUUID();
    await pg.query(`INSERT INTO doc_search (doc_id, title, body) VALUES ($1, 'note', 'body')`, [doc]);
    await pg.close();
    for (let s = 0; s < sessions; s++) {
      if (s % 25 === 0) log(`G8 year: session ${String(s)} of ${String(sessions)}`);
      pg = await createPg(new ProtoFS({ name, key, blockSize }));
      await pg.query('INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)', [doc, randomBytes(4096)]);
      await pg.query('UPDATE doc_search SET body = $2 WHERE doc_id = $1', [doc, `session ${String(s)}`]);
      await pg.exec('CHECKPOINT');
      await pg.close();
    }
    const live = await ProtoFS.liveSalts(name);
    const derive = await deriveKeyMs(200);
    const g8Ms = live.salts * derive.p50;
    return {
      sessions,
      blockSize,
      liveSalts: live.salts,
      records: live.records,
      deriveKeyP50Ms: derive.p50,
      saltsTimesDeriveKeyMs: round(g8Ms),
      G8: g8Ms <= 0.1 * 1500,
      totalMs: round(now() - t0),
    };
  } finally {
    await dropIdb(name);
  }
}

// ---- page ------------------------------------------------------------------------------------

const PARTS: Record<string, (runs: number) => Promise<unknown>> = {
  gates10: (runs) => runGates(10, runs),
  gates100: (runs) => runGates(100, runs),
  extras: () => runExtras(),
  year: () => runYear(Number(new URLSearchParams(location.search).get('sessions') ?? 365), 8192),
  g7: () => runG7(log),
};

async function run(parts: string[], runs: number): Promise<Json> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const result: Json = {
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    runs,
    startedAt: new Date().toISOString(),
  };
  for (const part of parts) {
    const fn = PARTS[part];
    if (!fn) continue;
    try {
      result[part] = await fn(runs);
    } catch (e) {
      result[part] = { error: errorText(e) };
    }
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

const show = (result: Json) => {
  if (outEl) outEl.textContent = JSON.stringify(result, null, 2);
  (window as unknown as { __benchResult?: Json }).__benchResult = result;
  log('done');
};

const start = (parts: string[], runs: number) => {
  run(parts, runs).then(show, (e: unknown) => {
    (window as unknown as { __benchError?: string }).__benchError = errorText(e);
    log(`failed: ${errorText(e)}`);
  });
};

document.getElementById('run')?.addEventListener('click', () => {
  const parts = [...document.querySelectorAll<HTMLInputElement>('input[name=part]:checked')].map((i) => i.value);
  const runs = Number((document.getElementById('runs') as HTMLInputElement | null)?.value ?? 20);
  start(parts, runs);
});
document.getElementById('copy')?.addEventListener('click', () => {
  void navigator.clipboard.writeText(outEl?.textContent ?? '');
});

const params = new URLSearchParams(location.search);
if (params.get('auto') === '1') start((params.get('parts') ?? 'gates10,extras').split(','), Number(params.get('runs') ?? 20));
