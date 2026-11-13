// Throwaway spike code (issue #47, design A of docs/research/opfs-on-demand.md): a plain on-demand
// PGlite filesystem. Runs in the PG worker. The tree and each file's block list live here, in
// memory; the bytes live in one OPFS container file of 8 KB blocks that only the IO worker
// (io-worker.ts) holds a sync access handle for. Every read and write crosses the bridge
// synchronously (bridge.ts): Postgres's read() blocks in Atomics.wait until the IO worker answers.
// The tree is saved as JSON to a second OPFS file in syncToFs. No cipher, no page cache, and not
// crash safe: the tree is rewritten in place and data is flushed only in syncToFs.
import { BaseFilesystem, ERRNO_CODES, type FsStats } from '@electric-sql/pglite/basefs';
import type { PGlite } from '@electric-sql/pglite';
import { BLOCK, CHUNK, EIO, HEADER_INTS, LEN, OFF_BLOCK, OFF_IN, OP, OP_READ, OP_WRITE, RESULT, STATE } from './bridge.ts';

const MODE_DIR = 16384;
const MODE_FILE = 32768;
const TRIP_TIMEOUT_MS = 60_000;

interface FileNode {
  type: 'file';
  mode: number;
  mtime: number;
  size: number;
  /** Container block per 8 KB of the file; -1 is a hole (reads as zeros). */
  blocks: number[];
}
interface DirNode {
  type: 'dir';
  mode: number;
  mtime: number;
  children: Record<string, Node>;
}
type Node = FileNode | DirNode;
interface Tree {
  root: DirNode;
  blockCount: number;
  free: number[];
}

class FsError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Counters the bench reports; the times are wall time inside read() and write(). */
export interface OnDemandStats {
  reads: number;
  readBytes: number;
  readMs: number;
  writes: number;
  writeBytes: number;
  writeMs: number;
  trips: number;
  treeSaves: number;
  treeBytes: number;
  treeMs: number;
}

const parts = (path: string) => path.split('/').filter(Boolean);
const isDir = (n: Node): n is DirNode => n.type === 'dir';

export class OnDemandFs extends BaseFilesystem {
  /** Size of data.bin, set by closeFs. */
  containerBytes = 0;
  readonly stats: OnDemandStats = { reads: 0, readBytes: 0, readMs: 0, writes: 0, writeBytes: 0, writeMs: 0, trips: 0, treeSaves: 0, treeBytes: 0, treeMs: 0 };
  readonly #name: string;
  readonly #port: MessagePort;
  readonly #ctrl: Int32Array;
  readonly #data: Uint8Array;
  readonly #zeros = new Uint8Array(BLOCK);
  #tree: Tree = { root: { type: 'dir', mode: MODE_DIR, mtime: Date.now(), children: {} }, blockCount: 0, free: [] };
  /** Blocks freed since the last tree save: reused only once the saved tree no longer points at them. */
  #pendingFree: number[] = [];
  #treeDirty = true;
  #dataDirty = false;
  readonly #fds = new Map<number, FileNode>();
  #nextFd = 1;
  #callId = 0;
  readonly #calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(name: string, sab: SharedArrayBuffer, port: MessagePort) {
    super(name);
    this.#name = name;
    this.#port = port;
    this.#ctrl = new Int32Array(sab, 0, HEADER_INTS);
    this.#data = new Uint8Array(sab, HEADER_INTS * 4, CHUNK);
    port.onmessage = (ev: MessageEvent) => {
      const { id, result, error } = ev.data as { id: number; result?: unknown; error?: string };
      const call = this.#calls.get(id);
      this.#calls.delete(id);
      if (error === undefined) call?.resolve(result);
      else call?.reject(new Error(error));
    };
  }

  /** An asynchronous request to the IO worker (open, save the tree, close); never during a query. */
  #call<T>(op: string, args: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.#callId;
      this.#calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#port.postMessage({ id, op, args }, transfer);
    });
  }

  async init(pg: PGlite, opts: Parameters<BaseFilesystem['init']>[1]) {
    const saved = await this.#call<Uint8Array | null>('open', { name: this.#name });
    if (saved) {
      this.#tree = JSON.parse(new TextDecoder().decode(saved)) as Tree;
      this.#treeDirty = false;
    }
    return super.init(pg, opts);
  }

  async syncToFs() {
    if (this.#treeDirty) {
      const t = performance.now();
      const bytes = new TextEncoder().encode(JSON.stringify({ ...this.#tree, free: [...this.#tree.free, ...this.#pendingFree] }));
      this.#treeDirty = false;
      this.#dataDirty = false;
      this.stats.treeBytes = bytes.byteLength;
      await this.#call('saveTree', { bytes }, [bytes.buffer]);
      this.#tree.free.push(...this.#pendingFree);
      this.#pendingFree = [];
      this.stats.treeSaves++;
      this.stats.treeMs += performance.now() - t;
    } else if (this.#dataDirty) {
      this.#dataDirty = false;
      await this.#call('flush');
    }
  }

  async closeFs() {
    await this.syncToFs();
    this.containerBytes = (await this.#call<{ containerBytes: number }>('close')).containerBytes;
    (this.pg?.Module as { FS: { quit(): void } } | undefined)?.FS.quit();
  }

  // ---- the bridge ----

  /** One synchronous round trip; throws EIO when the IO worker fails or does not answer. */
  #trip(op: number, offset: number, len: number): void {
    const c = this.#ctrl;
    Atomics.store(c, STATE, 0);
    Atomics.store(c, OP, op);
    Atomics.store(c, LEN, len);
    Atomics.store(c, OFF_BLOCK, Math.floor(offset / BLOCK));
    Atomics.store(c, OFF_IN, offset % BLOCK);
    this.#port.postMessage(null);
    if (Atomics.wait(c, STATE, 0, TRIP_TIMEOUT_MS) === 'timed-out') throw new FsError(EIO, 'bridge: the IO worker did not answer');
    if (Atomics.load(c, RESULT) < 0) throw new FsError(EIO, 'bridge: the IO worker failed');
    this.stats.trips++;
  }

  #readAt(offset: number, dst: Uint8Array, at: number, len: number): void {
    for (let done = 0; done < len; ) {
      const n = Math.min(CHUNK, len - done);
      this.#trip(OP_READ, offset + done, n);
      dst.set(this.#data.subarray(0, n), at + done);
      done += n;
    }
  }

  #writeAt(offset: number, src: Uint8Array): void {
    for (let done = 0; done < src.byteLength; ) {
      const n = Math.min(CHUNK, src.byteLength - done);
      this.#data.set(src.subarray(done, done + n));
      this.#trip(OP_WRITE, offset + done, n);
      done += n;
    }
  }

  /** Calls fn(fileOffset, containerOffset or -1 for a hole, length) per run of contiguous container blocks. */
  #runs(f: FileNode, position: number, length: number, fn: (at: number, offset: number, len: number) => void): void {
    for (let done = 0; done < length; ) {
      const p = position + done;
      const bi = Math.floor(p / BLOCK);
      const blk = f.blocks[bi] ?? -1;
      let len = Math.min(BLOCK - (p % BLOCK), length - done);
      for (let b = bi; blk >= 0 && done + len < length && f.blocks[b + 1] === (f.blocks[b] ?? -2) + 1; b++) len += Math.min(BLOCK, length - done - len);
      fn(done, blk < 0 ? -1 : blk * BLOCK + (p % BLOCK), len);
      done += len;
    }
  }

  #alloc(): { blk: number; reused: boolean } {
    const reused = this.#tree.free.pop();
    this.#treeDirty = true;
    return reused === undefined ? { blk: this.#tree.blockCount++, reused: false } : { blk: reused, reused: true };
  }

  #freeFrom(f: FileNode, firstBlock: number): void {
    for (const b of f.blocks.splice(firstBlock)) if (b >= 0) this.#pendingFree.push(b);
    this.#treeDirty = true;
  }

  // ---- the tree ----

  #resolve(path: string): Node {
    let node: Node = this.#tree.root;
    for (const part of parts(path)) {
      if (!isDir(node)) throw new FsError(ERRNO_CODES.ENOTDIR, 'not a directory');
      const next: Node | undefined = Object.hasOwn(node.children, part) ? node.children[part] : undefined;
      if (!next) throw new FsError(ERRNO_CODES.ENOENT, 'no such file or directory');
      node = next;
    }
    return node;
  }

  #parent(path: string): { dir: DirNode; name: string } {
    const p = parts(path);
    const name = p.pop();
    const dir = this.#resolve(p.join('/'));
    if (name === undefined || !isDir(dir)) throw new FsError(ERRNO_CODES.ENOTDIR, 'not a directory');
    return { dir, name };
  }

  #file(path: string): FileNode {
    const n = this.#resolve(path);
    if (isDir(n)) throw new FsError(ERRNO_CODES.EISDIR, 'is a directory');
    return n;
  }

  #fd(fd: number): FileNode {
    const f = this.#fds.get(fd);
    if (!f) throw new FsError(ERRNO_CODES.EBADF, 'bad file descriptor');
    return f;
  }

  #stat(n: Node): FsStats {
    const size = isDir(n) ? 0 : n.size;
    return { dev: 0, ino: 0, mode: n.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size, blksize: BLOCK, blocks: Math.ceil(size / BLOCK), atime: n.mtime, mtime: n.mtime, ctime: n.mtime };
  }

  #truncateFile(f: FileNode, len: number): void {
    if (len < f.size) {
      this.#freeFrom(f, Math.ceil(len / BLOCK));
      // Bytes past the end of the last block must read as zeros if the file grows again.
      const tail = f.blocks[Math.floor(len / BLOCK)] ?? -1;
      if (len % BLOCK !== 0 && tail >= 0) this.#writeAt(tail * BLOCK + (len % BLOCK), this.#zeros.subarray(len % BLOCK));
    }
    f.size = len;
    f.mtime = Date.now();
    this.#treeDirty = true;
  }

  // ---- Filesystem API ----

  chmod(path: string, mode: number): void {
    this.#resolve(path).mode = mode;
    this.#treeDirty = true;
  }

  close(fd: number): void {
    this.#fds.delete(fd);
  }

  fstat(fd: number): FsStats {
    return this.#stat(this.#fd(fd));
  }

  lstat(path: string): FsStats {
    return this.#stat(this.#resolve(path));
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    const p = parts(path);
    let node = this.#tree.root;
    p.forEach((part, i) => {
      const last = i === p.length - 1;
      const next: Node | undefined = Object.hasOwn(node.children, part) ? node.children[part] : undefined;
      if (next && last) throw new FsError(ERRNO_CODES.EEXIST, 'file exists');
      if (!next && !last && !options?.recursive) throw new FsError(ERRNO_CODES.ENOENT, 'no such file or directory');
      if (next && !isDir(next)) throw new FsError(ERRNO_CODES.ENOTDIR, 'not a directory');
      node = next ?? (node.children[part] = { type: 'dir', mode: options?.mode ?? MODE_DIR, mtime: Date.now(), children: {} });
    });
    this.#treeDirty = true;
  }

  open(path: string): number {
    const f = this.#file(path);
    const fd = this.#nextFd++;
    this.#fds.set(fd, f);
    return fd;
  }

  readdir(path: string): string[] {
    const n = this.#resolve(path);
    if (!isDir(n)) throw new FsError(ERRNO_CODES.ENOTDIR, 'not a directory');
    return Object.keys(n.children);
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const t = performance.now();
    const f = this.#fd(fd);
    const n = Math.max(0, Math.min(length, f.size - position));
    this.#runs(f, position, n, (at, off, len) => {
      if (off < 0) buffer.fill(0, offset + at, offset + at + len);
      else this.#readAt(off, buffer, offset + at, len);
    });
    this.stats.reads++;
    this.stats.readBytes += n;
    this.stats.readMs += performance.now() - t;
    return n;
  }

  rename(oldPath: string, newPath: string): void {
    const from = this.#parent(oldPath);
    const node = Object.hasOwn(from.dir.children, from.name) ? from.dir.children[from.name] : undefined;
    if (!node) throw new FsError(ERRNO_CODES.ENOENT, 'no such file or directory');
    const to = this.#parent(newPath);
    const old = Object.hasOwn(to.dir.children, to.name) ? to.dir.children[to.name] : undefined;
    if (old && old !== node) {
      if (isDir(old) && Object.keys(old.children).length > 0) throw new FsError(ERRNO_CODES.ENOTEMPTY, 'directory not empty');
      if (!isDir(old)) this.#freeFrom(old, 0);
    }
    Reflect.deleteProperty(from.dir.children, from.name);
    to.dir.children[to.name] = node;
    this.#treeDirty = true;
  }

  rmdir(path: string): void {
    const { dir, name } = this.#parent(path);
    const n = this.#resolve(path);
    if (!isDir(n)) throw new FsError(ERRNO_CODES.ENOTDIR, 'not a directory');
    if (Object.keys(n.children).length > 0) throw new FsError(ERRNO_CODES.ENOTEMPTY, 'directory not empty');
    Reflect.deleteProperty(dir.children, name);
    this.#treeDirty = true;
  }

  truncate(path: string, len = 0): void {
    this.#truncateFile(this.#file(path), len);
  }

  unlink(path: string): void {
    const { dir, name } = this.#parent(path);
    const f = this.#file(path);
    this.#freeFrom(f, 0);
    f.size = 0;
    Reflect.deleteProperty(dir.children, name);
  }

  utimes(path: string, _atime: number, mtime: number): void {
    this.#resolve(path).mtime = mtime;
    this.#treeDirty = true;
  }

  writeFile(path: string, data: string | Uint8Array, options?: { encoding?: string; mode?: number; flag?: string }): void {
    const { dir, name } = this.#parent(path);
    let f = Object.hasOwn(dir.children, name) ? dir.children[name] : undefined;
    if (f && isDir(f)) throw new FsError(ERRNO_CODES.EISDIR, 'is a directory');
    if (!f) {
      f = { type: 'file', mode: options?.mode ?? MODE_FILE, mtime: Date.now(), size: 0, blocks: [] };
      dir.children[name] = f;
      this.#treeDirty = true;
    } else this.#truncateFile(f, 0);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (bytes.byteLength > 0) this.#writeFile(f, bytes, 0);
  }

  write(fd: number, buffer: Uint8Array | ArrayBufferLike, offset: number, length: number, position: number): number {
    // PGlite's stream_ops.write passes the heap's ArrayBuffer here, typed as a Uint8Array.
    const src = ArrayBuffer.isView(buffer) ? buffer.subarray(offset, offset + length) : new Uint8Array(buffer, offset, length);
    return this.#writeFile(this.#fd(fd), src, position);
  }

  #writeFile(f: FileNode, src: Uint8Array, position: number): number {
    const t = performance.now();
    const length = src.byteLength;
    if (length === 0) return 0;
    // Allocate every block the write touches; a reused block it covers only in part is zeroed first.
    for (let bi = Math.floor(position / BLOCK); bi * BLOCK < position + length; bi++) {
      if ((f.blocks[bi] ?? -1) >= 0) continue;
      while (f.blocks.length < bi) f.blocks.push(-1);
      const { blk, reused } = this.#alloc();
      f.blocks[bi] = blk;
      if (reused && (position > bi * BLOCK || position + length < (bi + 1) * BLOCK)) this.#writeAt(blk * BLOCK, this.#zeros);
    }
    this.#runs(f, position, length, (at, off, len) => {
      this.#writeAt(off, src.subarray(at, at + len));
    });
    if (position + length > f.size) {
      f.size = position + length;
      this.#treeDirty = true;
    }
    f.mtime = Date.now();
    this.#dataDirty = true;
    this.stats.writes++;
    this.stats.writeBytes += length;
    this.stats.writeMs += performance.now() - t;
    return length;
  }
}
