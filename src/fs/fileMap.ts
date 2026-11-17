// The in-memory file table (FORMAT.md section 7), the table blocks it packs into, and every record's tag. A sync plans
// against it as a Draft, applied only once its commit is known to be in the store.
import { concat, toHex, type Bytes } from '../format/bytes.ts';
import {
  encodeTable,
  maxTableBlocks,
  type BlockSize,
  type FileEntry,
  type FileType,
  type RunEntry,
  type TableEntry,
} from '../format/codec.ts';
import { StoreFullError } from '../format/errors.ts';
import { newBlockId } from '../format/records.ts';
import { entrySize, maxRunIds, packEntries, type FileTable } from '../format/table.ts';
import type { Snapshot, SnapshotInode } from '../tracker/tracker.ts';

const COUNT_LENGTH = 2;
const RUN_ENTRY_FIXED = 23;

export const fromHex = (hex: string): Bytes => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};

export interface MapRun {
  first: number;
  n: number;
  block: string;
}

export interface MapFile {
  readonly fileId: Bytes;
  readonly key: string;
  type: FileType;
  mode: number;
  size: number;
  path: string;
  target: string;
  ids: string[];
  /** Tag of the record under each id, by index; undefined only inside a draft. */
  tags: Array<Bytes | undefined>;
  home: string;
  /** In `first` order; together they cover `ids` exactly once. */
  runs: MapRun[];
}

export interface TableBlock {
  readonly id: string;
  readonly members: Map<string, number>;
  used: number;
  /** Empty for a block not sealed yet. */
  tag: Bytes;
}

const runSize = (n: number) => RUN_ENTRY_FIXED + 16 * n;

export const fileEntry = (f: MapFile): FileEntry => ({
  kind: 'file',
  fileId: f.fileId,
  type: f.type,
  mode: f.mode,
  size: f.size,
  path: f.path,
  target: f.target,
});

export class FileMap {
  readonly blockSize: BlockSize;
  readonly files = new Map<string, MapFile>();
  readonly blocks = new Map<string, TableBlock>();
  order: string[] = [];
  readonly live = new Set<string>();
  readonly places = new Map<string, { key: string; index: number }>();
  entryBytes = 0;
  dataBlocks = 0;

  constructor(blockSize: BlockSize) {
    this.blockSize = blockSize;
  }

  static load(
    table: FileTable,
    blocks: ReadonlyArray<{ id: string; tag: Bytes; entries: TableEntry[] }>,
    blockSize: BlockSize,
  ): FileMap {
    const map = new FileMap(blockSize);
    for (const f of table.files.values()) {
      const key = toHex(f.fileId);
      const ids = f.ids.map(toHex);
      const { fileId, type, mode, size, path, target } = f;
      map.files.set(key, { fileId, key, type, mode, size, path, target, ids, tags: [], home: '', runs: [] });
      ids.forEach((id, index) => {
        map.places.set(id, { key, index });
        map.live.add(id);
      });
      map.dataBlocks += ids.length;
    }
    for (const { id, tag, entries } of blocks) {
      const block: TableBlock = { id, members: new Map(), used: 0, tag };
      for (const e of entries) {
        const file = map.files.get(toHex(e.fileId)) as MapFile;
        if (e.kind === 'file') file.home = id;
        else file.runs.push({ first: e.first, n: e.ids.length, block: id });
        block.used += entrySize(e);
        block.members.set(file.key, (block.members.get(file.key) ?? 0) + 1);
      }
      map.blocks.set(id, block);
      map.order.push(id);
      map.live.add(id);
      map.entryBytes += block.used;
    }
    for (const f of map.files.values()) f.runs.sort((a, b) => a.first - b.first);
    return map;
  }

  get fill(): number {
    return this.order.length === 0 ? 0 : this.entryBytes / (this.order.length * this.blockSize);
  }

  /** `repack` packs the whole table densely, as a store's first commit does. */
  plan(snap: Snapshot, { repack = false }: { repack?: boolean } = {}): Draft {
    const draft = new Draft(this);
    for (const fileId of snap.deadFiles) draft.removeFile(toHex(fileId));
    for (const range of snap.deleteRanges) {
      const ids = (this.files.get(toHex(range.fileId)) as MapFile).ids;
      for (let i = range.start; i < range.end; i++) draft.deletes.push(ids[i] as string);
    }
    for (const inode of snap.inodes) draft.updateFile(inode);
    for (const block of snap.blocks) {
      const file = draft.files.get(toHex(block.fileId)) as MapFile;
      draft.writes.push({ id: file.ids[block.index] as string, file, index: block.index, bytes: block.bytes });
    }
    draft.finish(repack);
    return draft;
  }

  apply(draft: Draft): void {
    for (const id of draft.deletes) {
      this.live.delete(id);
      this.places.delete(id);
    }
    for (const [key, file] of draft.files) {
      if (!file) {
        this.files.delete(key);
        continue;
      }
      this.files.set(key, file);
      file.ids.forEach((id, index) => this.places.set(id, { key, index }));
    }
    for (const [id, block] of draft.blocks) {
      if (block) this.blocks.set(id, block);
      else this.blocks.delete(id);
    }
    for (const w of draft.writes) this.live.add(w.id);
    for (const block of draft.tables()) this.live.add(block.id);
    this.order = draft.order;
    this.entryBytes = draft.entryBytes;
    this.dataBlocks = draft.dataBlocks;
  }
}

/** The map of a store to rotate into: same files, a fresh id for every block (none an id of `map`). Packed, not stored. */
export function remap(map: FileMap): FileMap {
  const taken = new Set(map.live);
  const draw = (): string => {
    for (;;) {
      const id = toHex(newBlockId());
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  };
  const files = [...map.files.values()].map(({ fileId, path, type, mode, size, target, ids }) => ({
    fileId,
    path,
    type,
    mode,
    size,
    target,
    ids: ids.map(() => fromHex(draw())),
  }));
  const blocks = packEntries(files, map.blockSize).map((entries) => ({ id: draw(), tag: new Uint8Array(0), entries }));
  return FileMap.load({ files: new Map(files.map((f) => [toHex(f.fileId), f])), blocks: new Map() }, blocks, map.blockSize);
}

export interface BlockWrite {
  id: string;
  file: MapFile;
  index: number;
  bytes: Uint8Array;
}

/** One sync's changes over the map, without changing it (null = removed). */
export class Draft {
  readonly map: FileMap;
  readonly files = new Map<string, MapFile | null>();
  readonly blocks = new Map<string, TableBlock | null>();
  order: string[];
  entryBytes: number;
  dataBlocks: number;
  fileCount: number;
  readonly writes: BlockWrite[] = [];
  readonly deletes: string[] = [];
  repacked = false;
  readonly #drawn = new Set<string>();
  readonly #room: number;
  readonly #maxRun: number;

  constructor(map: FileMap) {
    this.map = map;
    this.order = [...map.order];
    this.entryBytes = map.entryBytes;
    this.dataBlocks = map.dataBlocks;
    this.fileCount = map.files.size;
    this.#room = map.blockSize - COUNT_LENGTH;
    this.#maxRun = maxRunIds(map.blockSize);
  }

  /** A block id that is neither live nor drawn earlier in this draft. */
  fresh(): string {
    for (;;) {
      const id = toHex(newBlockId());
      if (!this.map.live.has(id) && !this.#drawn.has(id)) {
        this.#drawn.add(id);
        return id;
      }
    }
  }

  file(key: string): MapFile | undefined {
    const f = this.files.get(key);
    return f === null ? undefined : (f ?? this.map.files.get(key));
  }

  block(id: string): TableBlock {
    return (this.blocks.get(id) ?? this.map.blocks.get(id)) as TableBlock;
  }

  *allFiles(): Generator<MapFile> {
    for (const [key, f] of this.map.files) if (!this.files.has(key)) yield f;
    for (const f of this.files.values()) if (f) yield f;
  }

  tables(): TableBlock[] {
    return [...this.blocks.values()].filter((b): b is TableBlock => b !== null);
  }

  encode(block: TableBlock): Bytes {
    const entries: TableEntry[] = [];
    for (const key of block.members.keys()) {
      const f = this.file(key) as MapFile;
      if (f.home === block.id) entries.push(fileEntry(f));
      for (const r of f.runs) {
        if (r.block !== block.id) continue;
        const run: RunEntry = { kind: 'run', fileId: f.fileId, first: r.first, ids: f.ids.slice(r.first, r.first + r.n).map(fromHex) };
        entries.push(run);
      }
    }
    return encodeTable(entries, this.map.blockSize);
  }

  removeFile(key: string): void {
    const f = this.map.files.get(key) as MapFile;
    this.#remove(f.home, key, entrySize(fileEntry(f)));
    for (const r of f.runs) this.#remove(r.block, key, runSize(r.n));
    this.files.set(key, null);
    this.fileCount--;
    this.dataBlocks -= f.ids.length;
  }

  updateFile(inode: SnapshotInode): void {
    const key = toHex(inode.fileId);
    const old = this.map.files.get(key);
    const count = inode.blocks;
    const f: MapFile = {
      fileId: inode.fileId as Bytes,
      key,
      type: inode.type,
      mode: inode.mode,
      size: inode.size,
      path: inode.path,
      target: inode.target ?? '',
      ids: old ? old.ids.slice(0, count) : [],
      tags: old ? old.tags.slice(0, count) : [],
      home: old?.home ?? '',
      runs: old ? old.runs.map((r) => ({ ...r })) : [],
    };
    const oldCount = old?.ids.length ?? 0;
    while (f.ids.length < count) {
      f.ids.push(this.fresh());
      f.tags.push(undefined);
    }
    this.files.set(key, f);
    this.dataBlocks += count - oldCount;

    const size = entrySize(fileEntry(f));
    if (size > this.#room) throw new StoreFullError('a path or symlink target does not fit in one table block');
    if (!old) {
      this.fileCount++;
      f.home = this.#findRoom(size);
      this.#add(f.home, key, size);
    } else if (
      old.type !== f.type ||
      old.mode !== f.mode ||
      old.size !== f.size ||
      old.path !== f.path ||
      old.target !== f.target
    ) {
      // A changed entry stays in its table block when it still fits there.
      const delta = size - entrySize(fileEntry(old));
      if (this.#free(f.home) >= delta) this.#resize(f.home, delta);
      else {
        this.#remove(f.home, key, size - delta);
        f.home = this.#findRoom(size);
        this.#add(f.home, key, size);
      }
    }
    this.#fitRuns(f, oldCount);
  }

  #fitRuns(f: MapFile, oldCount: number): void {
    const count = f.ids.length;
    const { runs, key } = f;
    if (count < oldCount) {
      for (let last = runs.at(-1); last && last.first >= count; last = runs.at(-1)) {
        this.#remove(last.block, key, runSize(last.n));
        runs.pop();
      }
      const last = runs.at(-1);
      if (last && last.first + last.n > count) {
        const cut = last.first + last.n - count;
        this.#resize(last.block, -16 * cut);
        last.n -= cut;
      }
      return;
    }
    let next = oldCount;
    const last = runs.at(-1);
    if (last && last.n < this.#maxRun && next < count) {
      // The open run grows; when it no longer fits its block, it moves whole.
      const more = Math.min(count - next, this.#maxRun - last.n);
      if (this.#free(last.block) >= 16 * more) this.#resize(last.block, 16 * more);
      else {
        this.#remove(last.block, key, runSize(last.n));
        last.block = this.#findRoom(runSize(last.n + more));
        this.#add(last.block, key, runSize(last.n + more));
      }
      last.n += more;
      next += more;
    }
    while (next < count) {
      const n = Math.min(count - next, this.#maxRun);
      // A file's first run goes into its entry's table block when it fits.
      const block = this.#findRoom(runSize(n), runs.length === 0 ? f.home : undefined);
      this.#add(block, key, runSize(n));
      runs.push({ first: next, n, block });
      next += n;
    }
  }

  finish(repack: boolean): void {
    const emptied = [...this.blocks.values()].filter((b): b is TableBlock => b !== null && b.members.size === 0);
    for (const b of emptied) this.blocks.set(b.id, null);
    if (emptied.length > 0) {
      const gone = new Set(emptied.map((b) => b.id));
      this.order = this.order.filter((id) => !gone.has(id));
    }
    const { blockSize } = this.map;
    if (repack || (this.order.length > 4 && this.entryBytes * 2 < this.order.length * blockSize)) this.#repack();
    else for (const b of emptied) if (this.map.blocks.has(b.id)) this.deletes.push(b.id);
    if (this.order.length > maxTableBlocks(blockSize)) {
      throw new StoreFullError(`the file table needs more than ${String(maxTableBlocks(blockSize))} blocks`);
    }
  }

  #repack(): void {
    const files = [...this.allFiles()].map((f) => ({ ...f, ids: f.ids.map(fromHex) }));
    const packed = packEntries(files, this.map.blockSize);
    for (const id of this.map.order) this.deletes.push(id);
    for (const id of this.blocks.keys()) this.blocks.set(id, null);
    for (const id of this.map.order) this.blocks.set(id, null);
    const placed = new Map<string, MapFile>();
    for (const f of this.allFiles()) placed.set(f.key, { ...f, home: '', runs: [] });
    this.order = [];
    this.entryBytes = 0;
    for (const entries of packed) {
      const id = this.fresh();
      const block: TableBlock = { id, members: new Map(), used: 0, tag: new Uint8Array(0) };
      for (const e of entries) {
        const f = placed.get(toHex(e.fileId)) as MapFile;
        if (e.kind === 'file') f.home = id;
        else f.runs.push({ first: e.first, n: e.ids.length, block: id });
        block.used += entrySize(e);
        block.members.set(f.key, (block.members.get(f.key) ?? 0) + 1);
      }
      this.blocks.set(id, block);
      this.order.push(id);
      this.entryBytes += block.used;
    }
    for (const [key, f] of placed) this.files.set(key, f);
    this.repacked = true;
  }

  manifestFiles(): Array<{ fileId: Bytes; blockTags: Bytes }> {
    const out: Array<{ fileId: Bytes; blockTags: Bytes }> = [];
    for (const f of this.allFiles()) {
      if (f.type !== 'file') continue;
      // A plain loop: `tags` can be sparse (indexed assignment), and `some` skips holes.
      for (let i = 0; i < f.ids.length; i++) {
        if (f.tags[i] === undefined) throw new Error('pglite-cipher: a new block has no record to store');
      }
      out.push({ fileId: f.fileId, blockTags: concat(f.tags as Bytes[]) });
    }
    return out;
  }

  #free(id: string): number {
    return this.#room - this.block(id).used;
  }

  #edit(id: string): TableBlock {
    let b = this.blocks.get(id);
    if (!b) {
      const base = this.map.blocks.get(id) as TableBlock;
      b = { id, members: new Map(base.members), used: base.used, tag: base.tag };
      this.blocks.set(id, b);
    }
    return b;
  }

  #add(id: string, key: string, size: number): void {
    const b = this.#edit(id);
    b.used += size;
    b.members.set(key, (b.members.get(key) ?? 0) + 1);
    this.entryBytes += size;
  }

  #remove(id: string, key: string, size: number): void {
    const b = this.#edit(id);
    b.used -= size;
    const n = (b.members.get(key) ?? 0) - 1;
    if (n > 0) b.members.set(key, n);
    else b.members.delete(key);
    this.entryBytes -= size;
  }

  #resize(id: string, delta: number): void {
    this.#edit(id).used += delta;
    this.entryBytes += delta;
  }

  #findRoom(size: number, prefer?: string): string {
    if (prefer !== undefined && this.#free(prefer) >= size) return prefer;
    for (const id of this.order) if (this.#free(id) >= size) return id;
    const id = this.fresh();
    this.blocks.set(id, { id, members: new Map(), used: 0, tag: new Uint8Array(0) });
    this.order.push(id);
    return id;
  }
}
