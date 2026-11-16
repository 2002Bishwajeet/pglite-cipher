// Spike #58 (bench only): how fast IndexedDB hands back 100 MB, by record size, getAll page size,
// parallel streams and getAll against a cursor. Records as the backend stores them: 32-character
// random hex keys, random bytes, one object store `kv`. MB/s per cell, the median of `runs` reads.
import { MB, dropIdb, now, pct, randomBytes, round, type Json } from './measure.ts';

const STORE = 'kv';
const SIZES = [32768, 65400, 65536, 65580, 131072, 262144, 1048576];
/**
 * `page` 0 is getAll without a count (everything at once); streams split the key space by its first
 * hex digit. `split` reads each page's keys first, then the page in that many parts at once, each in
 * its own transaction (one page in hand at a time, as the open holds them).
 */
const MODES: Array<{ name: string; page: number; streams: number; split?: number; cursor?: true }> = [
  { name: 'page64', page: 64, streams: 1 },
  { name: 'page512', page: 512, streams: 1 },
  { name: 'page2048', page: 2048, streams: 1 },
  { name: 'all', page: 0, streams: 1 },
  { name: 'streams2', page: 512, streams: 2 },
  { name: 'streams4', page: 512, streams: 4 },
  { name: 'split2', page: 512, streams: 1, split: 2 },
  { name: 'split4', page: 512, streams: 1, split: 4 },
  { name: 'cursor', page: 0, streams: 1, cursor: true },
];
/** Bytes per write transaction while filling the store. */
const WRITE_BATCH = 8 * MB;

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => {
      resolve(r.result);
    };
    r.onerror = () => {
      reject(r.error ?? new Error('IndexedDB request failed'));
    };
  });
const openDb = (name: string) => {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  return req(r);
};
const hexKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function fill(db: IDBDatabase, size: number, count: number): Promise<void> {
  const perTx = Math.max(1, Math.floor(WRITE_BATCH / size));
  for (let at = 0; at < count; at += perTx) {
    const tx = db.transaction(STORE, 'readwrite', { durability: 'relaxed' });
    const store = tx.objectStore(STORE);
    for (let i = at; i < Math.min(count, at + perTx); i++) store.put(randomBytes(size), hexKey());
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = tx.onabort = () => {
        reject(tx.error ?? new Error('IndexedDB transaction failed'));
      };
    });
  }
}

/** One stream over [lo, hi): pages of `page` records as the backend's readRange reads them (getAllKeys and getAll in one transaction). */
async function readStream(db: IDBDatabase, lo: string, hi: string | null, page: number, split = 1): Promise<number> {
  let bytes = 0;
  let after: string | null = null;
  for (;;) {
    const store = db.transaction(STORE).objectStore(STORE);
    const start = after ?? lo;
    const open = after !== null;
    const range = hi === null ? IDBKeyRange.lowerBound(start, open) : IDBKeyRange.bound(start, hi, open, true);
    const count = page === 0 ? undefined : page;
    let keys: string[];
    let values: Uint8Array[];
    if (split > 1) {
      keys = await req(store.getAllKeys(range, count) as IDBRequest<string[]>);
      const q = Math.ceil(keys.length / split);
      const parts = await Promise.all(
        Array.from({ length: Math.ceil(keys.length / q) }, (_, j) => {
          const ks = keys.slice(j * q, (j + 1) * q);
          const part = IDBKeyRange.bound(ks[0], ks[ks.length - 1]);
          return req(db.transaction(STORE).objectStore(STORE).getAll(part, ks.length) as IDBRequest<Uint8Array[]>);
        }),
      );
      values = parts.flat();
    } else {
      [keys, values] = await Promise.all([req(store.getAllKeys(range, count) as IDBRequest<string[]>), req(store.getAll(range, count) as IDBRequest<Uint8Array[]>)]);
    }
    for (const v of values) bytes += v.byteLength;
    if (page === 0 || keys.length < page) return bytes;
    after = keys[keys.length - 1] as string;
  }
}

function readCursor(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const r = db.transaction(STORE).objectStore(STORE).openCursor(IDBKeyRange.lowerBound(''));
    r.onsuccess = () => {
      const c = r.result;
      if (!c) {
        resolve(bytes);
        return;
      }
      bytes += (c.value as Uint8Array).byteLength;
      c.continue();
    };
    r.onerror = () => {
      reject(r.error ?? new Error('IndexedDB cursor failed'));
    };
  });
}

async function readAll(db: IDBDatabase, mode: (typeof MODES)[number]): Promise<number> {
  if (mode.cursor) return readCursor(db);
  const step = 16 / mode.streams;
  const bounds = Array.from({ length: mode.streams }, (_, i) => (i === 0 ? '' : (i * step).toString(16)));
  const parts = await Promise.all(bounds.map((lo, i) => readStream(db, lo, bounds[i + 1] ?? null, mode.page, mode.split)));
  return parts.reduce((a, b) => a + b, 0);
}

export async function runIdbRead(mb: number, runs: number, log: (msg: string) => void): Promise<Json> {
  const out: Json = { sizeMB: mb };
  for (const size of SIZES) {
    const count = Math.ceil((mb * MB) / size);
    const total = count * size;
    const name = `bench-idbread-${crypto.randomUUID()}`;
    let db: IDBDatabase | undefined;
    try {
      log(`idbread ${String(size)} B: writing ${String(count)} records`);
      db = await openDb(name);
      const t = now();
      await fill(db, size, count);
      const writeMs = now() - t;
      db.close();
      db = await openDb(name);
      const ms: Record<string, number[]> = {};
      for (let r = 0; r < runs; r++) {
        for (const mode of MODES) {
          log(`idbread ${String(size)} B: ${mode.name}, run ${String(r + 1)} of ${String(runs)}`);
          const t0 = now();
          const got = await readAll(db, mode);
          (ms[mode.name] ??= []).push(now() - t0);
          if (got !== total) throw new Error(`idbread ${String(size)} B ${mode.name}: read ${String(got)} bytes of ${String(total)}`);
        }
      }
      db.close();
      db = undefined;
      const cells: Json = {};
      for (const [mode, xs] of Object.entries(ms)) {
        const p50 = pct(xs, 50);
        cells[mode] = { ms: round(p50), MBps: round(total / MB / (p50 / 1000)) };
      }
      out[String(size)] = { records: count, writeMBps: round(total / MB / (writeMs / 1000)), ...cells };
    } finally {
      db?.close(); // an error path leaves it open, and deleteDatabase then blocks
      await dropIdb(name);
    }
  }
  return out;
}
