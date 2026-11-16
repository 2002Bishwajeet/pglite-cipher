// Throwaway spike code (issue #2): gate G7, only inside a Journal Tauri shell built with the
// `encfs-bench` feature (2002Bishwajeet/journal plan file journal/02). The worker times both paths;
// Tauri's invoke exists only on the page, so the page relays the worker's command calls, moving the
// bytes as transferables.
type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;

export interface RelayRequest {
  id: number;
  cmd: string;
  args?: unknown;
}

export async function runG7(log: (msg: string) => void): Promise<unknown> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
  if (!tauri) return { available: false, reason: 'not inside Tauri (window.__TAURI_INTERNALS__ missing)' };
  let token: unknown;
  try {
    token = await tauri.invoke('bench_token');
  } catch (e) {
    return { available: false, reason: `bench_token failed (shell built without encfs-bench?): ${String(e)}` };
  }
  log('G7: Rust store throughput');
  const worker = new Worker(new URL('./g7worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onerror = (e) => {
        reject(new Error(e.message));
      };
      worker.onmessage = (ev: MessageEvent<{ relay?: RelayRequest; result?: unknown; log?: string; fatal?: string }>) => {
        const { relay, result, log: line, fatal } = ev.data;
        if (fatal !== undefined) reject(new Error(fatal));
        if (line !== undefined) log(line);
        if (result !== undefined) resolve(result);
        if (!relay) return;
        // `invoke` may throw before it returns a promise: that is a rejection too, answered to the worker.
        new Promise((done) => {
          done(tauri.invoke(relay.cmd, relay.args));
        })
          .then((value) => {
            worker.postMessage({ id: relay.id, value }, value instanceof ArrayBuffer ? [value] : []);
          })
          // A failed invoke and a failed postMessage (DataCloneError) are both answered, or the worker waits forever.
          .catch((e: unknown) => {
            worker.postMessage({ id: relay.id, error: String(e) });
          });
      };
      worker.onmessageerror = () => {
        reject(new Error('G7: a message from the worker could not be deserialized'));
      };
      worker.postMessage({ token });
    });
  } finally {
    worker.terminate();
  }
}
