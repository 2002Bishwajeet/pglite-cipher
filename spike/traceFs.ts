// Throwaway spike code (issue #2): MemoryFS that counts every MEMFS operation Postgres makes.
import { MemoryFS } from '@electric-sql/pglite';
import type { PGlite } from '@electric-sql/pglite';
import { fileClass, hookMemfs, isLinked, walk, withPreRun } from './memfs.ts';
import type { EmFs, FsNode, FsStream } from './memfs.ts';

const BLOCK = 8192;
const KNOWN = ['write', 'msync', 'mmap', 'llseek', 'setattr', 'mknod', 'rename', 'unlink', 'rmdir', 'symlink'];

const bump = (rec: Record<string, number>, key: string, by = 1) => {
  rec[key] = (rec[key] ?? 0) + by;
};

export interface WriteStats {
  count: number;
  bytes: number;
  viaMsync: number;
  unalignedOffset: number;
  unalignedLength: number;
  pastEof: number;
  unlinkedNode: number;
  offsetMod: Record<string, number>;
  lengthMod: Record<string, number>;
}

export interface SizeStats {
  setattrWithSize: number;
  setattrWithoutSize: number;
  grow: number;
  shrink: number;
  same: number;
  growByWrite: number;
}

export interface SyncEvent {
  phase: string;
  relaxed: boolean;
  writes: number;
  bytes: number;
  filesWritten: number;
  creates: string[];
  sizeChanges: string[];
  renames: string[];
  removes: string[];
}

interface Pending {
  writes: number;
  bytes: number;
  written: Set<number>;
  creates: string[];
  sized: Map<number, string>;
  renames: string[];
  removes: string[];
}

const pending = (): Pending => ({ writes: 0, bytes: 0, written: new Set(), creates: [], sized: new Map(), renames: [], removes: [] });

export class Trace {
  phase = 'start';
  readonly ops: Record<string, number> = {};
  readonly otherOps: Record<string, number> = {};
  readonly writes: Record<string, WriteStats> = {};
  readonly sizes: Record<string, SizeStats> = {};
  readonly mmaps: Record<string, number> = {};
  readonly msyncs: Record<string, number> = {};
  readonly creates: Record<string, number> = {};
  readonly unlinks: Record<string, number> = {};
  readonly rmdirs: Record<string, number> = {};
  readonly symlinks: Record<string, number> = {};
  readonly renames: Record<string, number> = {};
  /** Files that shrank and grew again between two syncs. */
  readonly truncateThenExtend: Record<string, number> = {};
  readonly syncs: SyncEvent[] = [];
  readonly syncsByPhase: Record<string, number> = {};
  private cur = pending();
  private shrunk = new Set<number>();
  private inMsync = 0;
  fs?: EmFs;

  private cls(node: FsNode): string {
    if (!this.fs) throw new Error('trace not attached');
    return fileClass(this.fs.getPath(node));
  }

  private sizeStats(cls: string): SizeStats {
    return (this.sizes[cls] ??= { setattrWithSize: 0, setattrWithoutSize: 0, grow: 0, shrink: 0, same: 0, growByWrite: 0 });
  }

  private sizeChanged(node: FsNode, cls: string, oldSize: number, newSize: number) {
    if (newSize === oldSize) return;
    this.cur.sized.set(node.id, cls);
    if (newSize < oldSize) this.shrunk.add(node.id);
    else if (this.shrunk.has(node.id)) {
      bump(this.truncateThenExtend, cls);
      this.shrunk.delete(node.id);
    }
  }

  readonly around = (name: string, args: unknown[], call: () => unknown): unknown => {
    bump(this.ops, name);
    if (!KNOWN.includes(name)) bump(this.otherOps, name);
    switch (name) {
      case 'write': {
        const [stream, , , length, position] = args as [FsStream, Uint8Array, number, number, number];
        const node = stream.node;
        const cls = this.cls(node);
        const oldSize = node.usedBytes;
        const linked = isLinked(node);
        const result = call();
        const w = (this.writes[cls] ??= {
          count: 0, bytes: 0, viaMsync: 0, unalignedOffset: 0, unalignedLength: 0, pastEof: 0, unlinkedNode: 0, offsetMod: {}, lengthMod: {},
        });
        w.count++;
        w.bytes += length;
        if (this.inMsync) w.viaMsync++;
        if (position % BLOCK) w.unalignedOffset++;
        if (length % BLOCK) w.unalignedLength++;
        if (position > oldSize) w.pastEof++;
        if (!linked) w.unlinkedNode++;
        bump(w.offsetMod, String(position % BLOCK));
        bump(w.lengthMod, String(length % BLOCK));
        if (node.usedBytes > oldSize) this.sizeStats(cls).growByWrite++;
        this.sizeChanged(node, cls, oldSize, node.usedBytes);
        this.cur.writes++;
        this.cur.bytes += length;
        this.cur.written.add(node.id);
        return result;
      }
      case 'msync': {
        const [stream] = args as [FsStream];
        bump(this.msyncs, this.cls(stream.node));
        this.inMsync++;
        try {
          return call();
        } finally {
          this.inMsync--;
        }
      }
      case 'mmap': {
        const [stream, , , , flags] = args as [FsStream, number, number, number, number];
        bump(this.mmaps, `${this.cls(stream.node)} flags=${String(flags)}`);
        return call();
      }
      case 'setattr': {
        const [node, attr] = args as [FsNode, { size?: number }];
        const cls = this.cls(node);
        const s = this.sizeStats(cls);
        if (attr.size === undefined) {
          s.setattrWithoutSize++;
          return call();
        }
        s.setattrWithSize++;
        const oldSize = node.usedBytes;
        const result = call();
        if (attr.size > oldSize) s.grow++;
        else if (attr.size < oldSize) s.shrink++;
        else s.same++;
        this.sizeChanged(node, cls, oldSize, attr.size);
        return result;
      }
      case 'mknod': {
        const result = call() as FsNode;
        const cls = this.cls(result);
        bump(this.creates, cls);
        this.cur.creates.push(cls);
        return result;
      }
      case 'rename': {
        const [node, newDir, newName] = args as [FsNode, FsNode, string];
        const from = this.cls(node);
        const result = call();
        const to = fileClass(`${this.fs?.getPath(newDir) ?? ''}/${newName}`);
        bump(this.renames, `${from} -> ${to}`);
        this.cur.renames.push(`${from} -> ${to}`);
        return result;
      }
      case 'unlink':
      case 'rmdir':
      case 'symlink': {
        const [parent, entry] = args as [FsNode, string];
        const cls = fileClass(`${this.fs?.getPath(parent) ?? ''}/${entry}`);
        bump(name === 'unlink' ? this.unlinks : name === 'rmdir' ? this.rmdirs : this.symlinks, cls);
        if (name !== 'symlink') this.cur.removes.push(cls);
        return call();
      }
      default:
        return call();
    }
  };

  /** Records one syncToFs and what changed in PGDATA since the previous one. */
  sync(relaxed: boolean): void {
    const inData = (c: string) => !c.startsWith('(outside');
    const c = this.cur;
    this.syncs.push({
      phase: this.phase,
      relaxed,
      writes: c.writes,
      bytes: c.bytes,
      filesWritten: c.written.size,
      creates: c.creates.filter(inData),
      sizeChanges: [...c.sized.values()].filter(inData),
      renames: c.renames.filter(inData),
      removes: c.removes.filter(inData),
    });
    bump(this.syncsByPhase, this.phase);
    this.cur = pending();
    this.shrunk.clear();
  }
}

export interface Snapshot {
  dirs: { path: string; mode: number }[];
  files: { path: string; mode: number; data: Uint8Array }[];
}

/** Copies PGDATA out of MEMFS (for a "reopen" of an in-memory database). */
export function snapshot(fs: EmFs): Snapshot {
  const snap: Snapshot = { dirs: [], files: [] };
  walk(fs, (path, node) => {
    if (fs.isDir(node.mode)) snap.dirs.push({ path, mode: node.mode });
    else if (fs.isFile(node.mode)) {
      const contents = node.contents as Uint8Array | null;
      snap.files.push({ path, mode: node.mode, data: contents ? contents.slice(0, node.usedBytes) : new Uint8Array(0) });
    } else throw new Error(`unexpected node type in PGDATA: ${path}`);
  });
  return snap;
}

export interface TraceOptions {
  trace?: Trace;
  restore?: Snapshot;
  /** Milliseconds each syncToFs waits, to make a queued sync observable. */
  syncDelayMs?: number;
}

export class TraceFS extends MemoryFS {
  readonly trace: Trace;
  private readonly restore: Snapshot | undefined;
  private readonly syncDelayMs: number;
  private restoring = false;
  last?: Snapshot;
  syncsDone = 0;

  constructor(opts: TraceOptions = {}) {
    super();
    this.trace = opts.trace ?? new Trace();
    this.restore = opts.restore;
    this.syncDelayMs = opts.syncDelayMs ?? 0;
  }

  override async init(pg: PGlite, opts: Parameters<MemoryFS['init']>[1]) {
    const { emscriptenOpts } = await super.init(pg, opts);
    return {
      emscriptenOpts: withPreRun(emscriptenOpts, (fs) => {
        this.trace.fs = fs;
        hookMemfs(fs, (name, args, call) => (this.restoring ? call() : this.trace.around(name, args, call)));
      }),
    };
  }

  override async initialSyncFs(): Promise<void> {
    const snap = this.restore;
    if (!snap || !this.pg) return;
    const fs = this.pg.Module.FS as unknown as EmFs;
    this.restoring = true;
    try {
      for (const d of snap.dirs) {
        fs.mkdirTree(d.path);
        fs.chmod(d.path, d.mode);
      }
      for (const f of snap.files) {
        fs.writeFile(f.path, f.data);
        fs.chmod(f.path, f.mode);
      }
    } finally {
      this.restoring = false;
    }
    await Promise.resolve();
  }

  override async syncToFs(relaxedDurability?: boolean): Promise<void> {
    this.trace.sync(relaxedDurability ?? false);
    if (this.syncDelayMs) await new Promise((r) => setTimeout(r, this.syncDelayMs));
    this.syncsDone++;
  }

  override async closeFs(): Promise<void> {
    if (this.pg) this.last = snapshot((this.pg.Module as unknown as { FS: EmFs }).FS);
    await super.closeFs();
  }
}
