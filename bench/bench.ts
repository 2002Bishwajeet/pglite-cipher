// The benchmark page: the real implementation (EncryptedFs over IndexedDbBackend, 64 KB blocks)
// against plain IdbFs, gates G1-G9 of docs/plan/01-sqlcipher-comparison.md 3.3, the key operations,
// and the rows ported from davidmuggleton/pglite-encrypted-fs's bench (THIRD_PARTY.md).
import { IdbFs, PGlite } from '@electric-sql/pglite';
import { EncryptedFs, IndexedDbBackend } from '../src/index.ts';
import type { BlockSize } from '../src/format/codec.ts';
import { deriveRecordKey, SubkeyCache } from '../src/format/keys.ts';
import { openBlock, sealBlock, type RecordContext } from '../src/format/records.ts';
import { runHandles, runOnDemand } from '../spike/on-demand/part.ts';
import { runG7 } from './g7.ts';
import { runIdbRead } from './idbread.ts';
import { judgeGates, judgeYear } from './judge.ts';
import { SCHEMA, createPg, dropIdb, errorText, newKek, now, pct, randomBytes, ratios, round, runPair, stat, wasmBytes, type Json, type Pg, type PgOptions, type Stat } from './measure.ts';

// `&block=262144` builds the gates' encrypted store at that block size (#63); the codec must accept it.
const BLOCK_SIZE = Number(new URLSearchParams(location.search).get('block') ?? 65536) as BlockSize;
const MB = 1024 * 1024;

const statusEl = document.getElementById('status');
const outEl = document.getElementById('out');
// Device runs: with `&post=<target>` the page reports progress and its result to the collector of
// bench/device/serve.mjs, which saves the result as bench/results/<target>.json.
const postTarget = new URLSearchParams(location.search).get('post');
const log = (msg: string) => {
  if (statusEl) statusEl.textContent = msg;
  console.log(`[bench] ${msg}`);
  if (postTarget) void fetch('./log', { method: 'POST', body: `${postTarget} ${msg}` }).catch(() => undefined);
};

// ---- gates at one database size ---------------------------------------------------------------

async function runGates(mb: number, runs: number): Promise<Json> {
  const { plain, encrypted } = await runPair(mb, runs, log, { keys: true, blockSize: BLOCK_SIZE });
  const result = { sizeMB: mb, blockSize: BLOCK_SIZE, plain, encrypted };
  return { ...result, ratios: ratios(plain, encrypted), gates: judgeGates(result, 1) };
}

/** The encrypted variant alone (`enc10`, `enc100`): no plain build, no plain section, no ratios. */
async function runEncrypted(mb: number, runs: number): Promise<Json> {
  const { encrypted } = await runPair(mb, runs, log, { keys: true, onlyEncrypted: true, blockSize: BLOCK_SIZE });
  const result = { sizeMB: mb, blockSize: BLOCK_SIZE, encrypted };
  return { ...result, gates: judgeGates(result, 1) };
}

// ---- memory levers (#48): WAL sizes, shared_buffers, initialMemory ---------------------------

const SMALL_WAL = ['min_wal_size=32MB', 'max_wal_size=32MB']; // the least Postgres allows: two 16 MB segments
// No smaller `initialMemory`: PGlite 0.5.10's wasm declares 2048 pages (128 MB) as its minimum, and
// `PGlite.create` with less never settles (instantiate fails: "memory import has 512 pages which is
// smaller than the declared initial of 2048").
const LEVERS: Record<string, string[]> = {
  default: [],
  wal: SMALL_WAL,
  sb32: ['shared_buffers=32MB'],
  sb16: ['shared_buffers=16MB'],
  'wal+sb16': [...SMALL_WAL, 'shared_buffers=16MB'],
};

/** The gates pair once per lever (`&levers=a,b` picks some), with the settings Postgres reports and the wasm memory of an empty in-memory instance. */
async function runLevers(mb: number, runs: number): Promise<Json> {
  const only = new URLSearchParams(location.search).get('levers')?.split(',');
  const out: Json = { sizeMB: mb };
  for (const [name, conf] of Object.entries(LEVERS)) {
    if (only && !only.includes(name)) continue;
    const pgOptions: PgOptions = { startParams: [...PGlite.defaultStartParams, ...conf.flatMap((c) => ['-c', c])] };
    const probe = await PGlite.create(pgOptions);
    let settings: Record<string, string> | undefined;
    let emptyWasm: number;
    try {
      settings = (await probe.query<Record<string, string>>("SELECT current_setting('shared_buffers') AS shared_buffers, current_setting('min_wal_size') AS min_wal_size, current_setting('max_wal_size') AS max_wal_size, current_setting('wal_segment_size') AS wal_segment_size")).rows[0];
      emptyWasm = wasmBytes(probe);
    } finally {
      await probe.close();
    }
    log(`levers ${String(mb)} MB: ${name}`);
    const { plain, encrypted } = await runPair(mb, runs, log, { pgOptions });
    out[name] = { conf, settings, emptyWasm, ratios: ratios(plain, encrypted), plain, encrypted };
  }
  return out;
}

// ---- G6 support, G8 deriveKey, AES-GCM, crypto overhead ----------------------------------------

const STORE = 'kv';
const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => {
      resolve(r.result);
    };
    r.onerror = () => {
      reject(r.error ?? new Error('IndexedDB request failed'));
    };
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
const openDb = (name: string) => {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  return req(r);
};

const hkdfBase = () => crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'HKDF', false, ['deriveKey']);

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
    const sub = await deriveRecordKey(base, crypto.getRandomValues(new Uint8Array(16)));
    return (await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sub, plain)).byteLength === 80;
  };
  await check('hkdfDeriveKeyToAesGcm', async () => deriveWorks(await hkdfBase()));
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
  } finally {
    db.close();
    await dropIdb(name);
  }
  return r;
}

/** G8's unit: one HKDF `deriveKey` of a record subkey. */
async function deriveKeyMs(n: number): Promise<Stat> {
  const base = await hkdfBase();
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const t = now();
    await deriveRecordKey(base, salt);
    ms.push(now() - t);
  }
  return { ...stat(ms), p50: Math.round(pct(ms, 50) * 1000) / 1000 };
}

/** The browser version of docs/plan/gcmbench.mjs: 100 MB at each unit, 64 calls in flight. */
async function gcmMicro(): Promise<Json> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const aad = new Uint8Array(24);
  const out: Json = {};
  for (const unit of [8192, 32768, 65536]) {
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
    out[`${String(unit / 1024)}k`] = { calls: n, encryptMs: round(enc), encryptMBps: round((100 / enc) * 1000), decryptMs: round(dec), decryptMBps: round((100 / dec) * 1000) };
  }
  return out;
}

/** Ported shape (crypto-overhead.bench.ts): one record sealed and opened, and 100 at once, as the format does it. */
async function cryptoOverhead(runs: number): Promise<Json> {
  const out: Json = {};
  for (const blockSize of [8192, 65536] as BlockSize[]) {
    const ctx: RecordContext = { subkeys: new SubkeyCache(await hkdfBase()), meta: { blockSize, keyId: 1, storeId: randomBytes(16) }, encryptions: 0 };
    const fileId = randomBytes(16);
    const id = randomBytes(16);
    const body = randomBytes(blockSize);
    const sealed = await sealBlock(ctx, fileId, 0, body);
    const time = async (op: () => Promise<unknown>) => {
      const ms: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t = now();
        await op();
        ms.push(now() - t);
      }
      return stat(ms);
    };
    out[`${String(blockSize / 1024)}k`] = {
      sealOneMs: await time(() => sealBlock(ctx, fileId, 0, body)),
      openOneMs: await time(() => openBlock(ctx, id, fileId, 0, sealed)),
      seal100Ms: await time(() => Promise.all(Array.from({ length: 100 }, (_, i) => sealBlock(ctx, fileId, i, body)))),
      open100Ms: await time(() => Promise.all(Array.from({ length: 100 }, () => openBlock(ctx, id, fileId, 0, sealed)))),
    };
  }
  return out;
}

async function runExtras(runs: number): Promise<Json> {
  log('G6 support');
  const g6 = await support();
  log('G8 deriveKey x1000');
  const g8DeriveKeyMs = await deriveKeyMs(1000);
  const aesGcm = await gcmMicro();
  log('crypto overhead');
  return { g6, g8DeriveKeyMs, aesGcm, cryptoOverhead: await cryptoOverhead(runs) };
}

// ---- G8 over a simulated year ------------------------------------------------------------------

/** 365 open/edit/checkpoint/close sessions; then how many session salts the open derives (one per salt still stored). */
async function runYear(sessions: number): Promise<Json> {
  const name = `bench-year-${crypto.randomUUID()}`;
  const key = await newKek();
  const open = () => new EncryptedFs({ backend: IndexedDbBackend.pair(name), key, mode: 'open-or-create' });
  const t0 = now();
  try {
    let pg = await createPg(open());
    await pg.exec(SCHEMA);
    const doc = crypto.randomUUID();
    await pg.query(`INSERT INTO doc_search (doc_id, title, body) VALUES ($1, 'note', 'body')`, [doc]);
    await pg.close();
    for (let s = 0; s < sessions; s++) {
      if (s % 25 === 0) log(`G8 year: session ${String(s)} of ${String(sessions)}`);
      pg = await createPg(open());
      await pg.query('INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)', [doc, randomBytes(4096)]);
      await pg.query('UPDATE doc_search SET body = $2 WHERE doc_id = $1', [doc, `session ${String(s)}`]);
      await pg.exec('CHECKPOINT');
      await pg.close();
    }
    const fs = open();
    pg = await createPg(fs);
    const { subkeys, dataBlocks, table } = fs.stats();
    await pg.close();
    const derive = await deriveKeyMs(200);
    const result = { sessions, blockSize: BLOCK_SIZE, liveSalts: subkeys, records: 3 + table.blocks + dataBlocks, deriveKeyP50Ms: derive.p50, totalMs: round(now() - t0) };
    return { ...result, gates: judgeYear(result, 1) };
  } finally {
    for (const db of [`${name}.a`, `${name}.b`]) await dropIdb(db);
  }
}

// ---- ported shape: startup and operations ----------------------------------------------------

/** Ported shape (startup.bench.ts, operations.bench.ts): plain and encrypted, p50 of `runs` each. */
async function runOps(runs: number): Promise<Json> {
  const out: Json = {};
  for (const kind of ['plain', 'encrypted'] as const) {
    const key = await newKek();
    const names: string[] = [];
    const make = (name: string) => {
      names.push(name);
      return kind === 'plain' ? new IdbFs(name) : new EncryptedFs({ backend: new IndexedDbBackend(name), key, mode: 'open-or-create' });
    };
    const dbName = (name: string) => (kind === 'plain' ? `/pglite/${name}` : name);
    const time = async (op: () => Promise<unknown>, prep?: () => Promise<unknown>) => {
      const ms: number[] = [];
      for (let i = 0; i < runs; i++) {
        await prep?.();
        const t = now();
        await op();
        ms.push(now() - t);
      }
      return stat(ms);
    };
    try {
      log(`ops ${kind}: startup`);
      const freshInitMs = await time(async () => {
        await (await createPg(make(`bench-ops-${crypto.randomUUID()}`))).close();
      });
      const reopenName = `bench-ops-${crypto.randomUUID()}`;
      await (await createPg(make(reopenName))).close();
      const reopenMs = await time(async () => {
        await (await createPg(make(reopenName))).close();
      });

      log(`ops ${kind}: operations`);
      const pg: Pg = await createPg(make(`bench-ops-${crypto.randomUUID()}`));
      await pg.exec('CREATE TABLE items (id serial PRIMARY KEY, name text, value int); CREATE INDEX items_value ON items (value)');
      const ops = {
        insert100RowsMs: await time(async () => {
          for (let i = 0; i < 100; i++) await pg.query('INSERT INTO items (name, value) VALUES ($1, $2)', [`item ${String(i)}`, i]);
        }),
        bulkInsert1000RowsMs: await time(() => pg.exec(`INSERT INTO items (name, value) SELECT 'bulk ' || g, g FROM generate_series(1, 1000) g`)),
        insertLargeText10KBx50Ms: await time(async () => {
          for (let i = 0; i < 50; i++) await pg.query('INSERT INTO items (name, value) VALUES ($1, $2)', ['x'.repeat(10_240), i]);
        }),
        select1000RowsMs: await time(() => pg.query('SELECT * FROM items LIMIT 1000')),
        selectWithIndexMs: await time(() => pg.query('SELECT * FROM items WHERE value = $1', [500])),
        aggregateMs: await time(() => pg.query('SELECT count(*), sum(value) FROM items')),
        mixedCrudCycleMs: await time(async () => {
          const { rows } = await pg.query<{ id: number }>(`INSERT INTO items (name, value) VALUES ('crud', 1) RETURNING id`);
          const id = rows[0]?.id;
          await pg.query('SELECT * FROM items WHERE id = $1', [id]);
          await pg.query('UPDATE items SET value = value + 1 WHERE id = $1', [id]);
          await pg.query('DELETE FROM items WHERE id = $1', [id]);
        }),
      };
      await pg.close();
      out[kind] = { freshInitMs, reopenMs, ...ops };
    } finally {
      for (const name of new Set(names)) await dropIdb(dbName(name));
    }
  }
  return out;
}

// ---- page ------------------------------------------------------------------------------------

const odMb = () => Number(new URLSearchParams(location.search).get('odmb') ?? 100);

const PARTS: Record<string, (runs: number) => Promise<unknown>> = {
  gates10: (runs) => runGates(10, runs),
  gates100: (runs) => runGates(100, runs),
  enc10: (runs) => runEncrypted(10, runs),
  enc100: (runs) => runEncrypted(100, runs),
  levers10: (runs) => runLevers(10, runs),
  levers100: (runs) => runLevers(100, runs),
  extras: (runs) => runExtras(runs),
  year: () => runYear(Number(new URLSearchParams(location.search).get('sessions') ?? 365)),
  ops: (runs) => runOps(runs),
  g7: () => runG7(log),
  // Spike #47 (spike/on-demand/): `&odmb=` sets the database size, 100 MB by default.
  ondemand: () => runOnDemand('plain', odMb(), log),
  'ondemand-aes': () => runOnDemand('aes', odMb(), log),
  'ondemand-idb': () => runOnDemand('idb', odMb(), log),
  'ondemand-handles': () => runHandles(1100),
  // Spike #58 (bench/idbread.ts): `&idbmb=` sets the store size, 100 MB by default.
  idbread: (runs) => runIdbRead(Number(new URLSearchParams(location.search).get('idbmb') ?? 100), runs, log),
};

async function run(parts: string[], runs: number, onPart: (result: Json) => Promise<void>): Promise<Json> {
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
    // A later part may crash the tab: send this one now (serve.mjs merges per part).
    await onPart({ partial: true, userAgent: result.userAgent, runs, finishedAt: new Date().toISOString(), [part]: result[part] });
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

const show = (result: Json) => {
  if (outEl) outEl.textContent = JSON.stringify(result, null, 2);
  (window as unknown as { __benchResult?: Json }).__benchResult = result;
  log('done');
};

/** Sends a result to the collector; the final one (not a `partial` per-part post) sets `window.__benchPosted` (what the device drivers wait for). */
const post = async (body: Json, final = true) => {
  if (!postTarget) return;
  try {
    const r = await fetch('./result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: postTarget, ...body }) });
    log(r.ok ? `posted as ${postTarget}` : `collector answered ${String(r.status)}`);
  } catch (e) {
    log(`post failed: ${errorText(e)}`);
  }
  if (final) (window as unknown as { __benchPosted?: boolean }).__benchPosted = true;
};

const start = (parts: string[], runs: number) => {
  void run(parts, runs, (body) => post(body, false)).then(
    (result) => {
      show(result);
      return post(result);
    },
    (e: unknown) => {
      (window as unknown as { __benchError?: string }).__benchError = errorText(e);
      log(`failed: ${errorText(e)}`);
      return post({ error: errorText(e) });
    },
  );
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
