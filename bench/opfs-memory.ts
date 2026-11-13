// Research measurement for issue #43 (docs/research/opfs-on-demand.md): the page side. Starts the
// workers of opfs-memory-worker.ts and exposes window.__opfs for bench/opfs-memory.mjs to drive.
interface Reply {
  id: number;
  result?: unknown;
  error?: string;
}

const workers = new Map<string, Worker>();
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seq = 0;

function worker(name: string): Worker {
  let w = workers.get(name);
  if (!w) {
    w = new Worker(new URL('./opfs-memory-worker.ts', import.meta.url), { type: 'module', name });
    w.onmessage = (ev: MessageEvent) => {
      const { id, result, error } = ev.data as Reply;
      const p = pending.get(id);
      pending.delete(id);
      if (error === undefined) p?.resolve(result);
      else p?.reject(new Error(error));
    };
    workers.set(name, w);
  }
  return w;
}

function call(name: string, op: string, args: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker(name).postMessage({ id, op, args }, transfer);
  });
}

function terminate(name: string): void {
  workers.get(name)?.terminate();
  workers.delete(name);
}

async function bridge(pages: number, reads: number): Promise<unknown> {
  const sab = new SharedArrayBuffer(8 + 8192);
  const ch = new MessageChannel();
  await call('crypto', 'bridgeSetup', { pages, sab, port: ch.port2 }, [ch.port2]);
  const run = await call('pg', 'bridgeRun', { pages, reads, sab, port: ch.port1 }, [ch.port1]);
  const crypto = await call('crypto', 'bridgeStats');
  terminate('crypto');
  terminate('pg');
  return { pages, reads, run, crypto };
}

(window as unknown as { __opfs: unknown }).__opfs = { call, terminate, bridge };
