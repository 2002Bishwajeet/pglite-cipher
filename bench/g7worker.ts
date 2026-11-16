// Throwaway spike code (issue #2): the G7 worker. Writes and reads 100 MB of 8 KB and 64 KB blocks
// (a) through the Tauri commands bench_blob_put / bench_blob_get, relayed by the page, and (b) by
// fetch to the shell's loopback endpoint with the per-launch token. Assumes `bench_blob_get`'s
// `index` counts blocks of `len` bytes (offset = index * len), as journal/02 describes a slice.
import type { RelayRequest } from './g7.ts';

const ORIGIN = 'http://localhost:47821';
const TOTAL = 100 * 1024 * 1024;
const now = () => performance.now();
const round = (x: number) => Math.round(x * 100) / 100;
const scope = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

let nextId = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const relay = (cmd: string, args?: unknown, transfer: Transferable[] = []): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    const msg: { relay: RelayRequest } = { relay: { id, cmd, ...(args === undefined ? {} : { args }) } };
    scope.postMessage(msg, transfer);
  });

// getRandomValues throws QuotaExceededError above 65,536 bytes.
const block = (unit: number) => {
  const out = new Uint8Array(unit);
  for (let o = 0; o < unit; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(unit, o + 65536)));
  return out;
};

async function viaCommands(unit: number): Promise<unknown> {
  const n = TOTAL / unit;
  await relay('bench_reset');
  let t = now();
  for (let i = 0; i < n; i++) {
    const b = block(unit);
    await relay('bench_blob_put', b, [b.buffer]);
  }
  const put = now() - t;
  t = now();
  for (let i = 0; i < n; i++) {
    const got = await relay('bench_blob_get', { index: i, len: unit });
    if (!(got instanceof ArrayBuffer) || got.byteLength !== unit) throw new Error(`bench_blob_get returned ${typeof got}`);
  }
  const get = now() - t;
  return { putMBps: round((100 / put) * 1000), getMBps: round((100 / get) * 1000) };
}

async function viaFetch(unit: number, token: string): Promise<unknown> {
  const n = TOTAL / unit;
  const headers = { 'X-Journal-Bench': token };
  await relay('bench_reset');
  let t = now();
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${ORIGIN}/__bench/blob`, { method: 'PUT', headers, body: block(unit) });
    if (!r.ok) throw new Error(`PUT /__bench/blob: ${String(r.status)}`);
  }
  const put = now() - t;
  t = now();
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${ORIGIN}/__bench/blob?index=${String(i)}&len=${String(unit)}`, { headers });
    if (!r.ok || (await r.arrayBuffer()).byteLength !== unit) throw new Error(`GET /__bench/blob: ${String(r.status)}`);
  }
  const get = now() - t;
  return { putMBps: round((100 / put) * 1000), getMBps: round((100 / get) * 1000) };
}

/** A 1 MB put and get through the commands: Tauri's fetch IPC takes a few ms, postMessage far more. */
async function echo(): Promise<unknown> {
  await relay('bench_reset');
  const b = block(1024 * 1024);
  const t = now();
  await relay('bench_blob_put', b, [b.buffer]);
  await relay('bench_blob_get', { index: 0, len: 1024 * 1024 });
  const ms = round(now() - t);
  return { oneMbPutGetMs: ms, ipcGuess: ms < 50 ? 'fetch IPC (likely)' : 'postMessage fallback (likely)' };
}

const attempt = async (fn: () => Promise<unknown>) => {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

scope.onmessage = (ev: MessageEvent<{ token?: string; id?: number; value?: unknown; error?: string }>) => {
  const { token, id, value, error } = ev.data;
  if (id !== undefined) {
    const w = waiting.get(id);
    waiting.delete(id);
    if (error !== undefined) w?.reject(new Error(error));
    else w?.resolve(value);
    return;
  }
  if (token === undefined) return;
  void (async () => {
    try {
      const result: Record<string, unknown> = { available: true, ipc: await attempt(echo) };
      for (const unit of [8192, 65536]) {
        scope.postMessage({ log: `G7: ${String(unit / 1024)} KB blocks` });
        result[`commands_${String(unit / 1024)}k`] = await attempt(() => viaCommands(unit));
        result[`fetch_${String(unit / 1024)}k`] = await attempt(() => viaFetch(unit, token));
      }
      await attempt(() => relay('bench_reset'));
      scope.postMessage({ result });
    } catch (e) {
      // Whatever escapes `attempt` ends the part with an error instead of leaving the page waiting.
      scope.postMessage({ fatal: e instanceof Error ? e.message : String(e) });
    }
  })();
};
