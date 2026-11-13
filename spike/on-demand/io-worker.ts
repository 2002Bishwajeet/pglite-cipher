// Throwaway spike code (issue #47): the IO worker of the bridge. Holds the only two OPFS sync access
// handles of a database (`data.bin`, the 8 KB blocks; `tree.json`, the tree fs.ts saves) and serves
// the PG worker's synchronous reads and writes through the SharedArrayBuffer of bridge.ts.
// With `aes`, every request also runs AES-256-GCM through crypto.subtle, one call per 8 KB record
// (decrypt for a read, encrypt for a write), to price the cipher; the bytes on disk stay plaintext.
import { BLOCK, CHUNK, HEADER_INTS, LEN, OFF_BLOCK, OFF_IN, OP, OP_READ, OP_WRITE, RESULT, STATE } from './bridge.ts';

interface Init {
  sab: SharedArrayBuffer;
  port: MessagePort;
  aes: boolean;
}
interface Call {
  id: number;
  op: string;
  args: Record<string, unknown>;
}

const scope = self as unknown as { onmessage: ((ev: MessageEvent) => void) | null };
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

scope.onmessage = (ev: MessageEvent) => {
  const { sab, port, aes } = ev.data as Init;
  const ctrl = new Int32Array(sab, 0, HEADER_INTS);
  const data = new Uint8Array(sab, HEADER_INTS * 4, CHUNK);
  const buf = new Uint8Array(CHUNK);
  let dataSh: FileSystemSyncAccessHandle | undefined;
  let treeSh: FileSystemSyncAccessHandle | undefined;
  let key: CryptoKey | undefined;
  let sealed: { iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer } | undefined;

  const handles = () => {
    if (!dataSh || !treeSh) throw new Error('not open');
    return { dataSh, treeSh };
  };

  /** One AES-GCM call per 8 KB record of the request, as a sealed-block store would make. */
  const price = async (op: number, len: number) => {
    if (!key || !sealed) return;
    const k = key;
    const s = sealed;
    const records = Math.ceil(len / BLOCK);
    await Promise.all(
      Array.from({ length: records }, (_, i) =>
        op === OP_READ
          ? crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv }, k, s.ct)
          : crypto.subtle.encrypt({ name: 'AES-GCM', iv: crypto.getRandomValues(new Uint8Array(12)) }, k, buf.subarray(i * BLOCK, Math.min(len, (i + 1) * BLOCK))),
      ),
    );
  };

  const serve = async () => {
    const op = Atomics.load(ctrl, OP);
    const len = Atomics.load(ctrl, LEN);
    const at = Atomics.load(ctrl, OFF_BLOCK) * BLOCK + Atomics.load(ctrl, OFF_IN);
    let result = len;
    try {
      const { dataSh: sh } = handles();
      const view = buf.subarray(0, len);
      if (op === OP_READ) {
        const n = sh.read(view, { at });
        if (n < len) view.fill(0, n);
        await price(op, len);
        data.set(view);
      } else if (op === OP_WRITE) {
        view.set(data.subarray(0, len));
        await price(op, len);
        sh.write(view, { at });
      } else result = -1;
    } catch {
      result = -1;
    }
    Atomics.store(ctrl, RESULT, result);
    Atomics.store(ctrl, STATE, 1);
    Atomics.notify(ctrl, STATE);
  };

  const calls: Record<string, (a: Record<string, unknown>) => unknown> = {
    async open(a) {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(String(a.name), { create: true });
      dataSh = await (await dir.getFileHandle('data.bin', { create: true })).createSyncAccessHandle();
      treeSh = await (await dir.getFileHandle('tree.json', { create: true })).createSyncAccessHandle();
      if (aes) {
        key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        sealed = { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(BLOCK)) };
      }
      const size = treeSh.getSize();
      if (size === 0) return null;
      const bytes = new Uint8Array(size);
      treeSh.read(bytes, { at: 0 });
      return bytes;
    },
    saveTree(a) {
      const { dataSh: d, treeSh: t } = handles();
      const bytes = a.bytes as Uint8Array;
      d.flush();
      t.truncate(0);
      t.write(bytes, { at: 0 });
      t.flush();
      return {};
    },
    flush() {
      handles().dataSh.flush();
      return {};
    },
    close() {
      const { dataSh: d, treeSh: t } = handles();
      const containerBytes = d.getSize();
      d.flush();
      d.close();
      t.close();
      dataSh = treeSh = undefined;
      return { containerBytes };
    },
  };

  port.onmessage = (m: MessageEvent) => {
    if (m.data === null) {
      void serve();
      return;
    }
    const { id, op, args } = m.data as Call;
    void (async () => {
      try {
        const fn = calls[op];
        if (!fn) throw new Error(`unknown op ${op}`);
        port.postMessage({ id, result: await fn(args) });
      } catch (e) {
        port.postMessage({ id, error: errText(e) });
      }
    })();
  };
};
