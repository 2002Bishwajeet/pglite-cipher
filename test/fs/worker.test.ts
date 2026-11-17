// Worker killed mid-sync (browser only: a real Web Worker on the engine's IndexedDB) at a random moment of a write workload.
// The next worker must open, let Postgres recover, and find an acknowledged prefix of rows: all acknowledged durable, at most one in flight.
import { describe, expect, it } from 'vitest';
import { LONG, timeout } from '../long.ts';
import { inBrowser } from './helpers.ts';
import { progressName, readProgress } from './killProgress.ts';
import type { FromWorker, ToWorker } from './killWorker.ts';

const REPETITIONS = LONG ? 500 : 50;

interface Run {
  opened: Promise<{ n: number; max: number }>;
  error: string | null;
  worker: Worker;
}

function start(name: string, raw: Uint8Array<ArrayBuffer>): Run {
  const worker = new Worker(new URL('./killWorker.ts', import.meta.url), { type: 'module' });
  let resolveOpened: (opened: { n: number; max: number }) => void = () => undefined;
  let rejectOpened: (error: Error) => void = () => undefined;
  const run: Run = {
    opened: new Promise((resolve, reject) => {
      resolveOpened = resolve;
      rejectOpened = reject;
    }),
    error: null,
    worker,
  };
  worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
    const m = event.data;
    if (m.type === 'opened') resolveOpened(m);
    else {
      run.error = m.message;
      rejectOpened(new Error(m.message));
    }
  });
  worker.addEventListener('error', (event) => {
    run.error = event.message;
    rejectOpened(new Error(event.message));
  });
  worker.postMessage({ name, raw: raw.slice() } satisfies ToWorker);
  return run;
}

describe.runIf(inBrowser)('a worker killed mid-sync', () => {
  it(`opens to an acknowledged prefix after each of ${String(REPETITIONS)} kills`, async () => {
    const name = `kill-${crypto.randomUUID()}`;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    let acked = 0;
    let started = 0;
    let kills = 0;
    try {
      for (let rep = 0; rep <= REPETITIONS; rep++) {
        const run = start(name, raw);
        const { n, max } = await run.opened;
        expect(max, `repetition ${String(rep)}`).toBe(n);
        expect(n, `repetition ${String(rep)}`).toBeGreaterThanOrEqual(acked);
        expect(n, `repetition ${String(rep)}`).toBeLessThanOrEqual(started);
        if (rep === REPETITIONS) {
          run.worker.terminate();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 400));
        run.worker.terminate();
        expect(run.error, `repetition ${String(rep)}`).toBeNull();
        // What the worker recorded in IndexedDB, not its messages, which may die unsent.
        const progress = await readProgress(name);
        if (progress.started > n) kills++;
        acked = Math.max(n, progress.acked);
        started = Math.max(n, progress.started);
      }
      // Most kills landed while rows were being written.
      expect(kills).toBeGreaterThan(REPETITIONS / 2);
    } finally {
      for (const db of [name, progressName(name)]) {
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(db);
          request.onsuccess = request.onerror = request.onblocked = resolve;
        });
      }
    }
  }, timeout(900_000, 10));
});
