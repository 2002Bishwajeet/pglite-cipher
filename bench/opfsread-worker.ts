// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Bench only: layout (c) of opfsread.ts, reading segments via FileSystemSyncAccessHandle.
interface Req {
  dirs: string[];
  names: string[];
  chunk: number;
}
const scope = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<Req>) => void) | null;
};

scope.onmessage = (ev) => {
  void (async () => {
    try {
      if (typeof FileSystemFileHandle.prototype.createSyncAccessHandle !== 'function') throw new Error('FileSystemSyncAccessHandle is missing');
      let dir = await navigator.storage.getDirectory();
      for (const d of ev.data.dirs) dir = await dir.getDirectoryHandle(d);
      for (const name of ev.data.names) {
        const handle = await (await dir.getFileHandle(name)).createSyncAccessHandle();
        try {
          const size = handle.getSize();
          for (let at = 0; at < size; at += ev.data.chunk) {
            const buf = new Uint8Array(Math.min(ev.data.chunk, size - at));
            const n = handle.read(buf, { at });
            scope.postMessage({ bytes: n, buf: buf.buffer }, [buf.buffer]);
          }
        } finally {
          handle.close();
        }
      }
      scope.postMessage({ done: true });
    } catch (e) {
      scope.postMessage({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  })();
};
