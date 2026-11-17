// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared by the tracker tests: PGlite's Emscripten FS, a trivially correct model store, and the check that the model holds what MEMFS holds.
import { MemoryFS, PGlite } from '@electric-sql/pglite';
import type { EmscriptenFS, MemFS, MemNode, Snapshot, SnapshotInode, StoredFile } from '../../src/tracker/tracker.ts';

export interface Stream {
  fd: number;
  node: MemNode;
}

export interface TestFS extends EmscriptenFS {
  filesystems: { MEMFS: MemFS };
  open(path: string, flags: number, mode?: number): Stream;
  close(stream: Stream): void;
  write(stream: Stream, buffer: Uint8Array, offset: number, length: number, position?: number, canOwn?: boolean): number;
  truncate(path: string, length: number): void;
  ftruncate(fd: number, length: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  mkdir(path: string, mode?: number): void;
  mkdirTree(path: string): void;
  symlink(target: string, path: string): void;
  chmod(path: string, mode: number): void;
  utime(path: string, atime: number, mtime: number): void;
  mmap(stream: Stream, length: number, position: number, prot: number, flags: number): { ptr: number };
  msync(stream: Stream, buffer: Uint8Array, offset: number, length: number, flags: number): number;
  readdir(path: string): string[];
  lstat(path: string): { mode: number; size: number };
  readlink(path: string): string;
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
}

export interface TestModule {
  FS: TestFS;
  HEAPU8: Uint8Array;
  _free(ptr: number): void;
}

export const O_RDWR_CREAT = 0o102;
export const PROT_RW = 3;
export const MAP_SHARED = 1;

export const inBrowser = 'document' in globalThis;

export async function startPGlite(): Promise<{ pg: PGlite; mod: TestModule }> {
  const pg = new PGlite({ fs: new MemoryFS() });
  await pg.waitReady;
  return { pg, mod: pg.Module as unknown as TestModule };
}

export function saveOps(memfs: MemFS): () => void {
  const holders = [memfs.node_ops, memfs.stream_ops, ...Object.values(memfs.ops_table ?? {}).flatMap((g) => [g.node, g.stream])];
  const saved = holders.map((h) => ({ ...h }));
  return () => {
    holders.forEach((h, i) => Object.assign(h, saved[i]));
  };
}

export const isErrno = (e: unknown): boolean => typeof e === 'object' && e !== null && 'errno' in e;

export const S_IFMT = 0o170000;
export const isDirMode = (mode: number) => (mode & S_IFMT) === 0o040000;
export const isLinkMode = (mode: number) => (mode & S_IFMT) === 0o120000;

export function rmTree(fs: TestFS, path: string): void {
  if (isDirMode(fs.lstat(path).mode)) {
    for (const name of fs.readdir(path)) if (name !== '.' && name !== '..') rmTree(fs, `${path}/${name}`);
    fs.rmdir(path);
  } else {
    fs.unlink(path);
  }
}

export function listTree(fs: TestFS, root: string): Map<string, { mode: number; size: number }> {
  const out = new Map<string, { mode: number; size: number }>();
  const visit = (dir: string, prefix: string) => {
    for (const name of fs.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const stat = fs.lstat(`${dir}/${name}`);
      out.set(prefix + name, stat);
      if (isDirMode(stat.mode)) visit(`${dir}/${name}`, `${prefix}${name}/`);
    }
  };
  visit(root, '');
  return out;
}

export const hex = (id: Uint8Array) => Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');

export interface ModelFile {
  inode: SnapshotInode;
  blocks: Map<number, Uint8Array>;
}

/** The store as file id → inode and blocks; strict: refuses what a real store could not apply. */
export class ModelStore {
  readonly files = new Map<string, ModelFile>();
  readonly blockSize: number;

  constructor(blockSize: number) {
    this.blockSize = blockSize;
  }

  apply(snap: Snapshot): void {
    const inSnap = new Set<string>();
    for (const inode of snap.inodes) {
      const key = hex(inode.fileId);
      inSnap.add(key);
      const file = this.files.get(key);
      if (file) file.inode = inode;
      else this.files.set(key, { inode, blocks: new Map() });
    }
    for (const block of snap.blocks) {
      const file = this.files.get(hex(block.fileId));
      if (!file || !inSnap.has(hex(block.fileId))) throw new Error('a block without its inode in the snapshot');
      if (block.bytes.length !== this.blockSize) throw new Error('a block of the wrong size');
      file.blocks.set(block.index, block.bytes.slice());
    }
    for (const range of snap.deleteRanges) {
      const file = this.files.get(hex(range.fileId));
      if (!file) throw new Error('a delete range for a file the store does not hold');
      for (let i = range.start; i < range.end; i++) {
        if (!file.blocks.delete(i)) throw new Error(`a delete of block ${String(i)}, which the store does not hold`);
      }
    }
    for (const id of snap.deadFiles) {
      if (!this.files.delete(hex(id))) throw new Error('a dead file the store does not hold');
    }
  }

  read(file: ModelFile): Uint8Array {
    const B = this.blockSize;
    const out = new Uint8Array(file.inode.blocks * B);
    for (const [index, bytes] of file.blocks) out.set(bytes, index * B);
    return out.subarray(0, file.inode.size);
  }

  byPath(path: string): ModelFile | undefined {
    for (const file of this.files.values()) if (file.inode.path === path) return file;
    return undefined;
  }

  storedFiles(): StoredFile[] {
    return [...this.files.values()].map(({ inode }) => ({ path: inode.path, fileId: inode.fileId, blocks: inode.blocks }));
  }
}

export function checkModel(fs: TestFS, root: string, model: ModelStore): void {
  const B = model.blockSize;
  const actual = listTree(fs, root);
  const stored = new Map<string, ModelFile>();
  for (const file of model.files.values()) {
    if (stored.has(file.inode.path)) throw new Error(`the store holds two records for ${file.inode.path}`);
    stored.set(file.inode.path, file);
  }
  for (const path of stored.keys()) {
    if (!actual.has(path)) throw new Error(`the store still holds ${path}, which no longer exists`);
  }
  for (const [path, stat] of actual) {
    const file = stored.get(path);
    if (!file) throw new Error(`the store lacks ${path}`);
    const { inode } = file;
    if (inode.mode !== stat.mode) throw new Error(`mode of ${path}: ${String(inode.mode)} != ${String(stat.mode)}`);
    if (isLinkMode(stat.mode)) {
      if (inode.type !== 'symlink' || inode.target !== fs.readlink(`${root}/${path}`)) throw new Error(`symlink ${path}`);
      continue;
    }
    if (isDirMode(stat.mode)) {
      if (inode.type !== 'directory' || file.blocks.size !== 0) throw new Error(`directory ${path}`);
      continue;
    }
    const count = Math.ceil(stat.size / B);
    if (inode.type !== 'file' || inode.size !== stat.size || inode.blocks !== count) {
      throw new Error(`inode of ${path}: size ${String(inode.size)} != ${String(stat.size)}`);
    }
    for (const index of file.blocks.keys()) {
      if (index >= count) throw new Error(`the store holds block ${String(index)} of ${path}, past its end`);
    }
    for (let i = 0; i < count; i++) if (!file.blocks.has(i)) throw new Error(`the store lacks block ${String(i)} of ${path}`);
    const want = fs.readFile(`${root}/${path}`);
    const got = model.read(file);
    for (let i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) throw new Error(`byte ${String(i)} of ${path} (block ${String(Math.floor(i / B))}) differs`);
    }
  }
}

export function bytesFrom(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = (seed | 0) ^ 0x9e3779b9 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 255;
  }
  return out;
}
