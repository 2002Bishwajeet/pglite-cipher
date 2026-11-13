// Throwaway spike code (issue #47): the bench page's on-demand parts (bench/bench.ts).
//   ondemand          features, then a database of `mb` MB built and opened on the on-demand
//                     filesystem (fs.ts, through the bridge to io-worker.ts), a point query by
//                     primary key (cold, then warm), the first full scan, and a cold full scan
//                     after a reopen
//   ondemand-aes      the same, the IO worker also running AES-GCM per 8 KB record (prices the cipher)
//   ondemand-idb      the same on idb://, the baseline
//   ondemand-handles  how many OPFS sync access handles one worker can hold (up to 1,100)
// Each step runs in fresh workers. Between steps the page calls window.__odProbe(label) when a driver
// set it (spike/on-demand/run.mjs: the browser's RSS); on a device it is absent.
import { dropIdb, errorText, type Json } from '../../bench/measure.ts';
import { SAB_BYTES } from './bridge.ts';

type Variant = 'plain' | 'aes' | 'idb';
const POINT = 'select length(payload) as n from t where id = 4242';
const SCAN = 'select count(*)::int as rows, sum(length(payload))::bigint::text as bytes from t';

interface Workers {
  call(op: string, args?: Record<string, unknown>): Promise<Json>;
  terminate(): void;
}

/** A PG worker, plus for the on-demand variants an IO worker and the bridge between them. */
function start(variant: Variant | 'probe', name: string): Workers {
  const pg = new Worker(new URL('./pg-worker.ts', import.meta.url), { type: 'module', name: 'od-pg' });
  let io: Worker | undefined;
  let fsArgs: Record<string, unknown> = { fs: 'idb', name };
  const transfer: Transferable[] = [];
  if (variant === 'plain' || variant === 'aes') {
    io = new Worker(new URL('./io-worker.ts', import.meta.url), { type: 'module', name: 'od-io' });
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const ch = new MessageChannel();
    io.postMessage({ sab, port: ch.port2, aes: variant === 'aes' }, [ch.port2]);
    fsArgs = { fs: 'ondemand', name, sab, port: ch.port1 };
    transfer.push(ch.port1);
  }
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  let seq = 0;
  const fail = (msg: string) => {
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
  };
  pg.onmessage = (ev: MessageEvent) => {
    const { id, result, error } = ev.data as { id: number; result?: Json; error?: string };
    const p = pending.get(id);
    pending.delete(id);
    if (error === undefined) p?.resolve(result ?? {});
    else p?.reject(new Error(error));
  };
  pg.onerror = (e) => {
    fail(`PG worker: ${e.message}`);
  };
  if (io) {
    io.onerror = (e) => {
      fail(`IO worker: ${e.message}`);
    };
  }
  return {
    // The first call that opens PGlite (build or open) carries the bridge to the PG worker.
    call: (op, args = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        const withFs = op === 'build' || op === 'open';
        pg.postMessage({ id, op, args: withFs ? { ...fsArgs, ...args } : args }, withFs ? transfer.splice(0) : []);
      }),
    terminate: () => {
      pg.terminate();
      io?.terminate();
    },
  };
}

async function removeStorage(variant: Variant, name: string): Promise<string | null> {
  try {
    if (variant === 'idb') await dropIdb(`/pglite/${name}`);
    else await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true });
    return null;
  } catch (e) {
    return (e as { name?: string }).name === 'NotFoundError' ? null : errorText(e);
  }
}

/** The driver's measurement at this point (null without a driver). */
async function probe(label: string): Promise<unknown> {
  const fn = (window as unknown as { __odProbe?: (label: string) => Promise<unknown> }).__odProbe;
  return fn ? await fn(label) : null;
}

async function usage(): Promise<number | null> {
  try {
    return (await navigator.storage.estimate()).usage ?? null;
  } catch {
    return null;
  }
}

export async function runOnDemand(variant: Variant, mb: number, log: (msg: string) => void): Promise<Json> {
  const name = `od-spike-${variant}`;
  const result: Json = { variant, mb };
  if (variant === 'plain') {
    const w = start('probe', name);
    try {
      result.features = await w.call('features');
    } finally {
      w.terminate();
    }
  }
  if (variant !== 'idb' && !crossOriginIsolated) return { ...result, error: 'not cross-origin isolated: no SharedArrayBuffer for the bridge' };
  result.staleStorage = await removeStorage(variant, name);
  try {
    log(`on-demand ${variant}: build ${String(mb)} MB`);
    let w = start(variant, name);
    try {
      result.build = await w.call('build', { mb });
    } finally {
      w.terminate();
    }
    result.storageUsageBytes = await usage();
    result.baseline = await probe('baseline');
    log(`on-demand ${variant}: open`);
    w = start(variant, name);
    try {
      result.open = await w.call('open');
      result.afterOpen = await probe('open');
      result.point = await w.call('query', { sql: POINT });
      result.pointWarm = await w.call('query', { sql: POINT });
      log(`on-demand ${variant}: full scan`);
      // The first scan after the bulk load also sets hint bits, so it writes as much as it reads.
      result.scan = await w.call('query', { sql: SCAN });
      result.afterScan = await probe('scan');
      result.close = await w.call('close');
    } finally {
      w.terminate();
    }
    // Reopened, shared_buffers is empty and the hint bits are on disk: a cold scan that only reads.
    log(`on-demand ${variant}: reopen, cold scan`);
    w = start(variant, name);
    try {
      result.reopen = await w.call('open');
      result.coldScan = await w.call('query', { sql: SCAN });
      await w.call('close');
    } finally {
      w.terminate();
    }
    const built = result.build as { rows?: number };
    const matches = (q: unknown) => {
      const r = (q as { rows?: { rows?: number; bytes?: string }[] }).rows?.[0];
      return r?.rows === built.rows && r?.bytes === String((built.rows ?? 0) * 960);
    };
    result.scanMatchesBuild = matches(result.scan) && matches(result.coldScan);
  } catch (e) {
    // Keep what was measured before the failure.
    result.error = errorText(e);
  } finally {
    result.cleanupError = await removeStorage(variant, name);
  }
  return result;
}

export async function runHandles(n: number): Promise<Json> {
  const w = start('probe', 'od-probe');
  try {
    return await w.call('handles', { n });
  } finally {
    w.terminate();
  }
}
