// Throwaway spike code (issue #2). The minimal shape of Emscripten's FS and MEMFS that the trace
// and the prototype filesystem touch, and a hook installer that wraps every MEMFS operation.
import type { PGlite } from '@electric-sql/pglite';

export const PGDATA = '/pglite/data';

export interface FsNode {
  id: number;
  name: string;
  mode: number;
  parent: FsNode;
  contents: Uint8Array | Record<string, FsNode> | null;
  usedBytes: number;
}

export interface FsStream {
  node: FsNode;
}

type Op = (...args: unknown[]) => unknown;
type OpTable = Record<string, Op>;

export interface Memfs {
  stream_ops: OpTable;
  node_ops: OpTable;
  ops_table?: Record<string, { node?: OpTable; stream?: OpTable }>;
}

export interface EmFs {
  filesystems: { MEMFS: Memfs };
  getPath(node: FsNode): string;
  lookupPath(path: string): { node: FsNode };
  analyzePath(path: string): { exists: boolean };
  isFile(mode: number): boolean;
  isDir(mode: number): boolean;
  isLink(mode: number): boolean;
  mkdirTree(path: string, mode?: number): void;
  writeFile(path: string, data: Uint8Array): void;
  chmod(path: string, mode: number): void;
  readlink(path: string): string;
}

/** The Emscripten FS of a started PGlite instance. */
export const fsOf = (pg: PGlite): EmFs => (pg.Module as unknown as { FS: EmFs }).FS;

export type Around = (name: string, args: unknown[], call: () => unknown) => unknown;

/**
 * Wraps every function on MEMFS.stream_ops and MEMFS.node_ops, and the same functions where
 * MEMFS.ops_table already holds them (the table exists before preRun and nodes point into it).
 * One wrapper per original, so a call reaches `around` once: msync's internal call to
 * MEMFS.stream_ops.write reaches it as a nested 'write'.
 */
export function hookMemfs(fs: EmFs, around: Around): void {
  const memfs = fs.filesystems.MEMFS;
  const wrapped = new Map<Op, Op>();
  const wrap = (name: string, original: Op): Op => {
    const existing = wrapped.get(original);
    if (existing) return existing;
    const fn: Op = (...args) => around(name, args, () => original(...args));
    wrapped.set(original, fn);
    return fn;
  };
  const tables: OpTable[] = [memfs.stream_ops, memfs.node_ops];
  for (const group of Object.values(memfs.ops_table ?? {})) {
    if (group.node) tables.push(group.node);
    if (group.stream) tables.push(group.stream);
  }
  const names = new Map<Op, string>();
  for (const [name, fn] of Object.entries(memfs.stream_ops)) names.set(fn, name);
  for (const [name, fn] of Object.entries(memfs.node_ops)) names.set(fn, name);
  for (const table of tables) {
    for (const [key, fn] of Object.entries(table)) {
      const name = names.get(fn);
      if (name === undefined) continue; // not a MEMFS operation (chrdev ops are FS-wide)
      table[key] = wrap(name, fn);
    }
  }
}

/** Adds a preRun hook to the Emscripten options that MemoryFS.init returns. */
export function withPreRun<T extends { preRun?: unknown[] }>(opts: T, hook: (fs: EmFs) => void): T {
  return { ...opts, preRun: [...(opts.preRun ?? []), (mod: { FS: unknown }) => { hook(mod.FS as EmFs); }] };
}

export const isLinked = (node: FsNode): boolean => {
  const siblings = node.parent.contents;
  return siblings !== null && !(siblings instanceof Uint8Array) && siblings[node.name] === node;
};

/** Walks PGDATA: every directory, file and symlink below it, parents before children. */
export function walk(fs: EmFs, visit: (path: string, node: FsNode) => void, dir = PGDATA): void {
  const node = fs.lookupPath(dir).node;
  const contents = node.contents as Record<string, FsNode>;
  for (const name of Object.keys(contents).sort()) {
    const child = contents[name];
    if (!child) continue;
    const path = `${dir}/${name}`;
    visit(path, child);
    if (fs.isDir(child.mode)) walk(fs, visit, path);
  }
}

/** A file path with digits folded, so relation and segment files group: base/N/N, pg_wal/N. */
export const fileClass = (path: string): string => {
  if (!path.startsWith(`${PGDATA}/`)) return `(outside PGDATA) ${path.replace(/\d+/g, 'N')}`;
  const rel = path.slice(PGDATA.length + 1);
  if (/^pg_wal\/[0-9A-F]{24}$/.test(rel)) return 'pg_wal/<segment>';
  return rel.replace(/[0-9A-F]{8,}/g, 'X').replace(/\d+/g, 'N');
};

/** File count, directory count and bytes of PGDATA, with bytes per top-level entry. */
export function dirStats(fs: EmFs): { files: number; dirs: number; bytes: number; byTop: Record<string, number> } {
  const out = { files: 0, dirs: 0, bytes: 0, byTop: {} as Record<string, number> };
  walk(fs, (path, node) => {
    if (fs.isDir(node.mode)) {
      out.dirs++;
      return;
    }
    out.files++;
    out.bytes += node.usedBytes;
    const top = path.slice(PGDATA.length + 1).split('/')[0] ?? '';
    out.byTop[top] = (out.byTop[top] ?? 0) + node.usedBytes;
  });
  return out;
}
