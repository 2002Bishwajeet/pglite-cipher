// Knows which blocks of the files under PGDATA changed since the last sync, by wrapping the
// Emscripten MEMFS operations that change a file's contents or its place in the tree.
import { BlockBitmap } from './bitmap.ts';

/** The fields of an Emscripten MEMFS node the tracker reads. */
export interface MemNode {
  name: string;
  parent: MemNode;
  mode: number;
  mtime: number;
  /** Files: the length. `contents` may be longer: MEMFS grows it ahead. */
  usedBytes?: number;
  /** Files: a `Uint8Array`; directories: name → node. */
  contents?: unknown;
  /** Symlinks: the target. */
  link?: string;
}

/** The parts of Emscripten's `FS` the tracker calls. */
export interface EmscriptenFS {
  lookupPath(path: string): { node: MemNode };
  getPath(node: MemNode): string;
}

type Ops = Record<string, unknown>;

/** Emscripten's `MEMFS` (`FS.filesystems.MEMFS`). */
export interface MemFS {
  ops_table: Record<string, { node: Ops; stream: Ops }> | null;
  node_ops: Ops;
  stream_ops: Ops;
}

export type NodeType = 'file' | 'directory' | 'symlink';

export interface SnapshotInode {
  fileId: Uint8Array;
  /** Relative to the tracked root, `/`-separated, without a leading `/`. */
  path: string;
  type: NodeType;
  mode: number;
  /** Bytes; 0 for a directory or a symlink. */
  size: number;
  mtime: number;
  /** `ceil(size / blockSize)`. */
  blocks: number;
  /** A symlink's target, else `null`. */
  target: string | null;
}

export interface SnapshotBlock {
  fileId: Uint8Array;
  index: number;
  /** A copy, zero-padded to the block size. */
  bytes: Uint8Array;
}

/** Block indexes `start … end - 1` of a file, which the store holds and must remove. */
export interface DeleteRange {
  fileId: Uint8Array;
  start: number;
  end: number;
}

export interface Snapshot {
  blocks: SnapshotBlock[];
  inodes: SnapshotInode[];
  deleteRanges: DeleteRange[];
  /** Files the store holds and must remove; their blocks are in `deleteRanges`. */
  deadFiles: Uint8Array[];
}

/** A file as the store holds it, for `loadState`. */
export interface StoredFile {
  path: string;
  fileId: Uint8Array;
  blocks: number;
}

export interface Tracker {
  readonly stats: { trackingGaps: number };
  /** What changed since the last snapshot. Commit or requeue it before the next one. */
  snapshot(): Snapshot;
  /** The snapshot is in the store. */
  commit(snapshot: Snapshot): void;
  /** The snapshot did not reach the store: its changes are owed again. */
  requeue(snapshot: Snapshot): void;
  /** After the store was read into MEMFS: what the store holds, with nothing dirty. */
  loadState(files: Iterable<StoredFile>): void;
  /** Every node under the root is owed to the store (first population, import). */
  markAllDirty(): void;
  /** A snapshot is outstanding, or a change was seen since the last one. */
  hasDirty(): boolean;
  /** Every tracked regular file and its node: what a rotation copies blocks from. */
  files(): Array<{ fileId: Uint8Array; node: MemNode }>;
}

interface NodeState {
  readonly node: MemNode;
  fileId: Uint8Array;
  /** The store holds this node's file entry. */
  inStore: boolean;
  /** How many of its blocks the store holds. */
  persistedBlocks: number;
  minSizeSinceSync: number;
  readonly dirty: BlockBitmap;
  inodeDirty: boolean;
  dead: boolean;
  /** (size, mtime) at the last snapshot, for the safety net. */
  shadowSize: number;
  shadowMtime: number;
  /** The last snapshot walk that reached it. */
  seen: number;
}

interface Pending {
  snap: Snapshot;
  live: { st: NodeState; blocks: number; indexes: number[] }[];
  dead: NodeState[];
}

interface Attr {
  size?: number;
  mode?: number | null;
  atime?: number | null;
  mtime?: number | null;
  ctime?: number | null;
}

interface MemStream {
  node: MemNode;
}

type WriteOp = (s: MemStream, buf: Uint8Array, off: number, len: number, pos: number, canOwn?: boolean) => number;
type MsyncOp = (s: MemStream, buf: Uint8Array, pos: number, len: number, flags: number) => number;
type SetattrOp = (node: MemNode, attr: Attr) => void;
type CreateOp = (parent: MemNode, name: string, a: never, b: never) => MemNode;
type RenameOp = (node: MemNode, newDir: MemNode, newName: string) => void;
type RemoveOp = (parent: MemNode, name: string) => void;

const S_IFMT = 0o170000;
const TYPES = new Map<number, NodeType>([
  [0o100000, 'file'],
  [0o040000, 'directory'],
  [0o120000, 'symlink'],
]);
const typeOf = (mode: number): NodeType | undefined => TYPES.get(mode & S_IFMT);

function patch<F>(holders: Ops[], key: string, wrap: (orig: F) => F): void {
  for (const holder of holders) {
    const orig = holder[key];
    if (typeof orig === 'function') holder[key] = wrap(orig as F);
  }
}

const isEmptySnapshot = (s: Snapshot) =>
  s.blocks.length === 0 && s.inodes.length === 0 && s.deleteRanges.length === 0 && s.deadFiles.length === 0;

/**
 * Wraps `MEMFS` for the nodes under `root`; call it from a `preRun` hook. `root` need not exist
 * yet: it is recognised when it is created.
 */
export function installTracker(FS: EmscriptenFS, MEMFS: MemFS, root: string, blockSize: number): Tracker {
  const B = blockSize;
  const live = new Map<MemNode, NodeState>();
  let dead: NodeState[] = [];
  let pending: Pending | null = null;
  let rootNode: MemNode | null = null;
  let epoch = 0;
  const stats = { trackingGaps: 0 };

  const sizeOf = (node: MemNode) => node.usedBytes ?? 0;
  const blocksOf = (bytes: number) => Math.ceil(bytes / B);
  const children = (dir: MemNode) => dir.contents as Record<string, MemNode | undefined>;
  const forChildren = (dir: MemNode, fn: (child: MemNode) => void) => {
    for (const child of Object.values(children(dir))) if (child) fn(child);
  };
  const tracked = (dir: MemNode) => dir === rootNode || live.has(dir);

  /** Starts tracking a node, and a directory's subtree, as new to the store. */
  function adopt(node: MemNode): NodeState | undefined {
    const type = typeOf(node.mode);
    if (type === undefined) return undefined;
    const st: NodeState = {
      node,
      fileId: crypto.getRandomValues(new Uint8Array(16)),
      inStore: false,
      persistedBlocks: 0,
      minSizeSinceSync: 0,
      dirty: new BlockBitmap(),
      inodeDirty: true,
      dead: false,
      shadowSize: sizeOf(node),
      shadowMtime: node.mtime,
      seen: 0,
    };
    st.dirty.add(0, blocksOf(sizeOf(node)));
    live.set(node, st);
    if (type === 'directory') forChildren(node, adopt);
    return st;
  }

  function kill(node: MemNode): void {
    const st = live.get(node);
    if (!st) return;
    if (typeOf(node.mode) === 'directory') forChildren(node, kill);
    live.delete(node);
    st.dead = true;
    dead.push(st);
  }

  /** A rename changes the path of the node and of everything below it. */
  function touch(node: MemNode): void {
    const st = live.get(node);
    if (!st) return;
    st.inodeDirty = true;
    if (typeOf(node.mode) === 'directory') forChildren(node, touch);
  }

  function markWrite(st: NodeState, oldSize: number, pos: number, len: number): void {
    // A write past the end leaves a zero-filled hole from the old end.
    st.dirty.add(Math.floor(Math.min(pos, oldSize) / B), Math.floor((pos + len - 1) / B) + 1);
  }

  const groups = Object.values(MEMFS.ops_table ?? {});
  const nodeOps = [MEMFS.node_ops, ...groups.map((g) => g.node)];
  const streamOps = [MEMFS.stream_ops, ...groups.map((g) => g.stream)];

  patch<WriteOp>(streamOps, 'write', (orig) => (stream, buf, off, len, pos, canOwn) => {
    const st = live.get(stream.node);
    const oldSize = sizeOf(stream.node);
    const n = orig(stream, buf, off, len, pos, canOwn);
    if (st && n > 0) {
      // MEMFS may take an owned buffer as the whole file, whatever the position.
      if (canOwn) st.dirty.add(0, blocksOf(sizeOf(stream.node)));
      else markWrite(st, oldSize, pos, n);
    }
    return n;
  });

  // msync calls MEMFS.stream_ops.write itself, not through the node's ops: marked here on its own.
  patch<MsyncOp>(streamOps, 'msync', (orig) => (stream, buf, pos, len, flags) => {
    const st = live.get(stream.node);
    const oldSize = sizeOf(stream.node);
    const result = orig(stream, buf, pos, len, flags);
    if (st && len > 0) markWrite(st, oldSize, pos, len);
    return result;
  });

  // Truncate, ftruncate and posix_fallocate (no stream_ops.allocate in this build) all end here.
  patch<SetattrOp>(nodeOps, 'setattr', (orig) => (node, attr) => {
    const st = live.get(node);
    const oldSize = sizeOf(node);
    orig(node, attr);
    if (!st) return;
    const newSize = sizeOf(node);
    if (newSize !== oldSize) {
      const low = Math.min(oldSize, newSize);
      st.dirty.add(Math.floor(low / B), blocksOf(newSize));
      st.minSizeSinceSync = Math.min(st.minSizeSinceSync, low);
      st.inodeDirty = true;
    }
    if (attr.mode != null || attr.atime != null || attr.mtime != null || attr.ctime != null) st.inodeDirty = true;
  });

  // mknod also makes directories; symlink makes its node without mknod.
  for (const key of ['mknod', 'symlink']) {
    patch<CreateOp>(nodeOps, key, (orig) => (parent, name, a, b) => {
      const node = orig(parent, name, a, b);
      if (tracked(parent)) adopt(node);
      else if (rootNode === null && FS.getPath(node) === root) rootNode = node;
      return node;
    });
  }

  patch<RenameOp>(nodeOps, 'rename', (orig) => (node, newDir, newName) => {
    const replaced = children(newDir)[newName];
    orig(node, newDir, newName);
    if (replaced && replaced !== node) kill(replaced);
    if (!tracked(newDir)) kill(node);
    else if (live.has(node)) touch(node);
    else adopt(node);
  });

  for (const key of ['unlink', 'rmdir']) {
    patch<RemoveOp>(nodeOps, key, (orig) => (parent, name) => {
      const node = children(parent)[name];
      orig(parent, name);
      if (node) kill(node);
    });
  }

  try {
    rootNode = FS.lookupPath(root).node;
  } catch {
    // Not there yet: initdb creates PGDATA, and mknod recognises it.
  }
  if (rootNode) forChildren(rootNode, adopt);

  /** Every trackable node under the root, parents before children. */
  function walk(visit: (node: MemNode, type: NodeType, path: string, depth: number) => void): void {
    const descend = (dir: MemNode, prefix: string, depth: number) => {
      for (const [name, node] of Object.entries(children(dir))) {
        const type = node && typeOf(node.mode);
        if (!node || type === undefined) continue;
        visit(node, type, prefix + name, depth);
        if (type === 'directory') descend(node, `${prefix}${name}/`, depth + 1);
      }
    };
    if (rootNode) descend(rootNode, '', 1);
  }

  function snapshot(): Snapshot {
    if (pending) throw new Error('pglite-cipher tracker: commit or requeue the previous snapshot first');
    const snap: Snapshot = { blocks: [], inodes: [], deleteRanges: [], deadFiles: [] };
    const next: Pending = { snap, live: [], dead: [] };
    epoch++;
    let gaps = 0;
    let gapDepth = 0;
    const gap = (depth: number) => {
      if (gaps++ === 0) gapDepth = depth;
    };

    walk((node, type, path, depth) => {
      let st = live.get(node);
      // Safety net: a change no wrapper saw. Rewrite the whole node.
      if (!st) {
        st = adopt(node);
        if (!st) return;
        gap(depth);
      } else if (
        type === 'file' &&
        st.dirty.isEmpty &&
        !st.inodeDirty &&
        (sizeOf(node) !== st.shadowSize || node.mtime !== st.shadowMtime)
      ) {
        st.dirty.add(0, blocksOf(sizeOf(node)));
        st.inodeDirty = true;
        gap(depth);
      }
      st.seen = epoch;

      const size = type === 'file' ? sizeOf(node) : 0;
      const count = blocksOf(size);
      st.shadowSize = size;
      st.shadowMtime = node.mtime;
      // Truncated and extended again: every block from the low point is new.
      if (st.minSizeSinceSync < size) st.dirty.add(Math.floor(st.minSizeSinceSync / B), count);
      st.minSizeSinceSync = size;
      if (st.dirty.isEmpty && !st.inodeDirty) return;

      const indexes = st.dirty.indexes(count);
      const contents = node.contents as Uint8Array;
      for (const index of indexes) {
        const bytes = new Uint8Array(B);
        bytes.set(contents.subarray(index * B, Math.min((index + 1) * B, size)));
        snap.blocks.push({ fileId: st.fileId, index, bytes });
      }
      const target = type === 'symlink' ? (node.link ?? '') : null;
      snap.inodes.push({ fileId: st.fileId, path, type, mode: node.mode, size, mtime: node.mtime, blocks: count, target });
      if (count < st.persistedBlocks) {
        snap.deleteRanges.push({ fileId: st.fileId, start: count, end: st.persistedBlocks });
      }
      next.live.push({ st, blocks: count, indexes });
      st.dirty.clear();
      st.inodeDirty = false;
    });

    // Safety net: removed or moved away without a wrapper seeing it.
    for (const st of live.values()) {
      if (st.seen === epoch) continue;
      kill(st.node);
      gap(0);
    }

    for (const st of dead) {
      if (!st.inStore) continue; // created and removed between two syncs
      snap.deadFiles.push(st.fileId);
      if (st.persistedBlocks > 0) snap.deleteRanges.push({ fileId: st.fileId, start: 0, end: st.persistedBlocks });
      next.dead.push(st);
    }
    dead = [];

    if (gaps > 0) {
      stats.trackingGaps += gaps;
      console.warn(`pglite-cipher: ${String(gaps)} filesystem change(s) escaped the tracker (first at depth ${String(gapDepth)})`);
    }
    if (!isEmptySnapshot(snap)) pending = next;
    return snap;
  }

  function take(snap: Snapshot): Pending | null {
    if (pending?.snap === snap) {
      const p = pending;
      pending = null;
      return p;
    }
    if (isEmptySnapshot(snap)) return null;
    throw new Error('pglite-cipher tracker: not the outstanding snapshot');
  }

  return {
    stats,
    snapshot,

    commit(snap) {
      const p = take(snap);
      if (!p) return;
      for (const { st, blocks } of p.live) {
        st.inStore = true;
        st.persistedBlocks = blocks;
      }
      for (const st of p.dead) {
        st.inStore = false;
        st.persistedBlocks = 0;
      }
    },

    requeue(snap) {
      const p = take(snap);
      if (!p) return;
      // A node that died meanwhile keeps only its deletes, which the dead list already owes.
      for (const { st, indexes } of p.live) {
        if (st.dead) continue;
        for (const i of indexes) st.dirty.add(i, i + 1);
        st.inodeDirty = true;
      }
      dead.push(...p.dead);
    },

    loadState(files) {
      const byPath = new Map<string, NodeState>();
      walk((node, _type, path) => {
        const st = live.get(node);
        if (st) byPath.set(path, st);
      });
      for (const file of files) {
        const st = byPath.get(file.path);
        if (!st) throw new Error('pglite-cipher tracker: a stored file is not in the filesystem');
        const size = typeOf(st.node.mode) === 'file' ? sizeOf(st.node) : 0;
        st.fileId = file.fileId;
        st.inStore = true;
        st.persistedBlocks = file.blocks;
        st.minSizeSinceSync = size;
        st.dirty.clear();
        st.inodeDirty = false;
        st.shadowSize = size;
        st.shadowMtime = st.node.mtime;
      }
    },

    markAllDirty() {
      for (const st of live.values()) {
        st.dirty.add(0, blocksOf(sizeOf(st.node)));
        st.inodeDirty = true;
      }
    },

    hasDirty() {
      if (pending !== null || dead.some((st) => st.inStore)) return true;
      for (const st of live.values()) if (st.inodeDirty || !st.dirty.isEmpty) return true;
      return false;
    },

    files() {
      return [...live.values()].filter((st) => typeOf(st.node.mode) === 'file').map((st) => ({ fileId: st.fileId, node: st.node }));
    },
  };
}
