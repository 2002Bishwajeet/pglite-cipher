// The PGlite filesystem that encrypts below Postgres. The data directory lives in MEMFS while the
// database runs; the tracker knows which blocks changed; each sync seals them, with the file-table
// blocks and a new root, into one atomic commit of the packed block space (FORMAT.md).
import { MemoryFS, type PGlite } from '@electric-sql/pglite';
import type { RecordKey, StorageBackend } from './backend/backend.ts';
import { equalBytes, toHex, type Bytes } from './format/bytes.ts';
import { DEFAULT_BLOCK_SIZE, decodeRoot, decodeTable, encodeRoot, type BlockSize, type TableEntry } from './format/codec.ts';
import {
  CorruptStoreError,
  IncompleteStoreError,
  StaleWriterError,
  StoreExistsError,
  StoreMissingError,
  WrongKeyError,
} from './format/errors.ts';
import { createHeader, openHeader, SubkeyCache } from './format/keys.ts';
import { computeManifest, computeTableDigest } from './format/manifest.ts';
import { openBlock, openRoot, openTable, sealBlock, sealRoot, sealTable, tagOf, type RecordContext } from './format/records.ts';
import { selfTest } from './format/selfTest.ts';
import { assembleFiles } from './format/table.ts';
import { FileMap, fromHex, type Draft, type MapFile } from './fs/fileMap.ts';
import { installTracker, type EmscriptenFS, type MemFS, type Snapshot, type Tracker } from './tracker/tracker.ts';

const PGDATA = '/pglite/data';
/** Records per backend read while loading. */
const PAGE = 512;
/** WebCrypto calls in flight. */
const CONCURRENCY = 64;
/** The key id of a new store's first data key. */
const FIRST_KEY_ID = 1;

export type OpenMode = 'open' | 'create' | 'open-or-create';

export interface OpenProgress {
  phase: 'table' | 'blocks';
  done: number;
  total: number;
}

export interface EncryptedFsOptions {
  backend: StorageBackend;
  /** The KEK: a non-extractable AES-GCM key with `wrapKey` and `unwrapKey` usages (see `importKek`). */
  key: CryptoKey;
  mode: OpenMode;
  /** Used only when a store is created. */
  blockSize?: BlockSize;
  /** Load progress, for a splash screen. */
  onProgress?: (progress: OpenProgress) => void;
  /** Called once when this instance stops syncing because another writer committed a newer store. */
  onFatal?: (error: Error) => void;
}

export interface SyncStats {
  dataBlocks: number;
  tableBlocks: number;
  deletes: number;
  repacked: boolean;
  bytes: number;
  encryptMs: number;
  commitMs: number;
}

export interface EncryptedFsStats {
  gen: number;
  encryptions: number;
  subkeys: number;
  files: number;
  dataBlocks: number;
  table: { blocks: number; fill: number };
  trackingGaps: number;
  /** null until the first sync. */
  lastSync: SyncStats | null;
  /** null for a store this instance created. */
  lastOpen: { tableMs: number; blocksMs: number } | null;
}

/** The parts of Emscripten's FS this filesystem calls. */
interface ModuleFS extends EmscriptenFS {
  filesystems: { MEMFS: MemFS };
  analyzePath(path: string): { exists: boolean };
  mkdirTree(path: string): void;
  mkdir(path: string, mode: number): void;
  symlink(target: string, path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  chmod(path: string, mode: number): void;
  readdir(path: string): string[];
  lstat(path: string): { mode: number };
  isDir(mode: number): boolean;
  unlink(path: string): void;
  rmdir(path: string): void;
}

/** A sealed sync, ready to commit. */
interface Prepared {
  draft: Draft;
  root: Bytes;
  puts: Array<[RecordKey, Bytes]>;
  deletes: string[];
  stats: SyncStats;
}

const now = () => performance.now();

const isEmpty = (s: Snapshot) =>
  s.blocks.length === 0 && s.inodes.length === 0 && s.deleteRanges.length === 0 && s.deadFiles.length === 0;

/** Runs `fn` over `items` with at most `CONCURRENCY` calls in flight. */
async function pool<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/** Removes everything under `dir`. */
function clearDir(FS: ModuleFS, dir: string): void {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = `${dir}/${name}`;
    if (FS.isDir(FS.lstat(path).mode)) {
      clearDir(FS, path);
      FS.rmdir(path);
    } else FS.unlink(path);
  }
}

export class EncryptedFs extends MemoryFS {
  readonly #backend: StorageBackend;
  readonly #key: CryptoKey;
  readonly #mode: OpenMode;
  readonly #createBlockSize: BlockSize;
  readonly #onProgress: ((progress: OpenProgress) => void) | undefined;
  readonly #onFatal: ((error: Error) => void) | undefined;

  #FS: ModuleFS | null = null;
  #tracker: Tracker | null = null;
  #ctx: RecordContext | null = null;
  #map: FileMap | null = null;
  /** The header both copies must hold. */
  #header: Bytes | null = null;
  #headerRepair = false;
  /** The stored root as this instance last read or wrote it; null while the store does not exist. */
  #lastRoot: Bytes | null = null;
  #gen = 0;
  #origin = '';

  /** Syncs are enabled once the open succeeded. */
  #ready = false;
  /** Set when another writer committed: syncs stay disabled. */
  #fatal: Error | null = null;
  /** A commit whose outcome is unknown: its plan and snapshot, kept until a read of the root settles it. */
  #unsettled: { prepared: Prepared; snap: Snapshot } | null = null;
  #drain: Promise<void> | null = null;
  #requested = false;
  #strict = false;

  #lastSync: SyncStats | null = null;
  #lastOpen: { tableMs: number; blocksMs: number } | null = null;

  constructor(options: EncryptedFsOptions) {
    super();
    this.#backend = options.backend;
    this.#key = options.key;
    this.#mode = options.mode;
    this.#createBlockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    this.#onProgress = options.onProgress;
    this.#onFatal = options.onFatal;
  }

  override async init(pg: PGlite, emscriptenOptions: Parameters<MemoryFS['init']>[1]): ReturnType<MemoryFS['init']> {
    await selfTest();
    const { emscriptenOpts } = await super.init(pg, emscriptenOptions);
    // The tracker needs the block size, which an existing store keeps in its header: it is
    // installed by initialSyncFs, before anything exists under PGDATA.
    const keepFs = (mod: { FS: unknown }) => {
      this.#FS = mod.FS as ModuleFS;
    };
    return { emscriptenOpts: { ...emscriptenOpts, preRun: [...(emscriptenOpts.preRun ?? []), keepFs] } };
  }

  // ---- open --------------------------------------------------------------------------------

  override async initialSyncFs(): Promise<void> {
    const FS = this.#FS;
    if (!FS) throw new Error('EncryptedFs: initialSyncFs before init');
    try {
      if (await this.#backend.isEmpty()) {
        if (this.#mode === 'open') throw new StoreMissingError('there is no store to open');
        await this.#create(FS);
      } else {
        await this.#load(FS);
      }
    } catch (error) {
      if (FS.analyzePath(PGDATA).exists) clearDir(FS, PGDATA);
      throw error;
    }
    this.#ready = true;
  }

  /** A new store, in memory only: the first sync writes it, header copies and all. */
  async #create(FS: ModuleFS): Promise<void> {
    const blockSize = this.#createBlockSize;
    const { dek, meta, header } = await createHeader(this.#key, { blockSize, keyId: FIRST_KEY_ID });
    this.#ctx = { subkeys: new SubkeyCache(dek), meta, encryptions: 0 };
    this.#header = header;
    this.#map = new FileMap(blockSize);
    this.#tracker = installTracker(FS, FS.filesystems.MEMFS, PGDATA, blockSize);
  }

  async #load(FS: ModuleFS): Promise<void> {
    const backend = this.#backend;
    const [copy0, copy1, sealedRoot] = await Promise.all([backend.get(0), backend.get(1), backend.get(2)]);

    // 1. Header and root.
    if (copy0 === undefined && copy1 === undefined) throw new IncompleteStoreError('the store has records but no header');
    let opened;
    try {
      opened = await openHeader(this.#key, copy0 as Bytes | undefined, copy1 as Bytes | undefined);
    } catch (error) {
      if (error instanceof WrongKeyError && this.#mode === 'create') throw new StoreExistsError('a store exists');
      throw error;
    }
    const ctx: RecordContext = { subkeys: new SubkeyCache(opened.dek), meta: opened.meta, encryptions: 0 };
    if (sealedRoot === undefined) throw new IncompleteStoreError('the store has no root');
    const root = decodeRoot(await openRoot(ctx, sealedRoot as Bytes));
    if (root.state === 'populating') throw new IncompleteStoreError('the store was never completely written');
    if (root.state === 'rotating') throw new IncompleteStoreError('a data-key rotation was interrupted', { rotation: true });
    if (this.#mode === 'create') throw new StoreExistsError('a store exists');
    const { blockSize } = ctx.meta;

    // 2. File table. Nothing is built before its digest matches the root.
    const t0 = now();
    const tableIds = root.tableIds.map(toHex);
    const blocks: Array<{ id: string; tag: Bytes; entries: TableEntry[] }> = [];
    for (let at = 0; at < tableIds.length; at += PAGE) {
      const ids = tableIds.slice(at, at + PAGE);
      const values = await backend.getMany(ids);
      const page = ids.map((id, i) => ({ id, sealed: values[i] as Bytes | undefined, tag: new Uint8Array(0), entries: [] as TableEntry[] }));
      await pool(page, async (b) => {
        if (b.sealed === undefined) throw new CorruptStoreError(`table block ${b.id}: missing`);
        b.entries = decodeTable(await openTable(ctx, fromHex(b.id), b.sealed));
        b.tag = tagOf(b.sealed).slice();
      });
      for (const { id, tag, entries } of page) blocks.push({ id, tag, entries });
      this.#onProgress?.({ phase: 'table', done: blocks.length, total: tableIds.length });
    }
    const digest = await computeTableDigest(blocks.map((b) => b.tag));
    if (!equalBytes(digest, root.tableDigest)) throw new CorruptStoreError('file table: the digest differs from the root');
    const map = FileMap.load(
      assembleFiles(
        blocks.flatMap((b) => b.entries),
        root,
        blockSize,
      ),
      blocks,
      blockSize,
    );
    const tableMs = now() - t0;

    // The tree, every file at its final size.
    const tracker = installTracker(FS, FS.filesystems.MEMFS, PGDATA, blockSize);
    if (!FS.analyzePath(PGDATA).exists) FS.mkdirTree(PGDATA);
    FS.chmod(PGDATA, 0o700);
    const depth = (f: MapFile) => f.path.split('/').length;
    const buffers = new Map<string, Uint8Array>();
    for (const f of [...map.files.values()].sort((a, b) => depth(a) - depth(b))) {
      const path = `${PGDATA}/${f.path}`;
      if (f.type === 'symlink') {
        FS.symlink(f.target, path);
        continue;
      }
      if (f.type === 'directory') FS.mkdir(path, f.mode & 0o7777);
      else {
        FS.writeFile(path, new Uint8Array(0));
        const node = FS.lookupPath(path).node;
        const contents = new Uint8Array(f.size);
        node.contents = contents;
        node.usedBytes = f.size;
        buffers.set(f.key, contents);
      }
      FS.chmod(path, f.mode & 0o7777);
    }

    // 3. Blocks, one page at a time, in the order of their random ids.
    const t1 = now();
    const tableSet = new Set(tableIds);
    const total = tableIds.length + root.dataBlocks;
    let read = 0;
    let done = 0;
    for (let after: string | null = null; ; ) {
      const page = await backend.readRange(after, PAGE);
      if (page.length === 0) break;
      await pool(page, async ([id, sealed]) => {
        if (tableSet.has(id)) return;
        const place = map.places.get(id);
        if (!place) throw new CorruptStoreError(`block ${id}: not in the file table`);
        const file = map.files.get(place.key) as MapFile;
        const plain = await openBlock(ctx, fromHex(id), file.fileId, place.index, sealed as Bytes);
        const start = place.index * blockSize;
        (buffers.get(file.key) as Uint8Array).set(plain.subarray(0, Math.min(blockSize, file.size - start)), start);
        file.tags[place.index] = tagOf(sealed as Bytes).slice();
        read++;
      });
      done += page.length;
      this.#onProgress?.({ phase: 'blocks', done, total });
      after = (page[page.length - 1] as [string, Uint8Array])[0];
      if (page.length < PAGE) break;
    }
    if (read !== root.dataBlocks) throw new CorruptStoreError('a data block is missing');
    const manifest = await computeManifest(
      [...map.files.values()].filter((f) => f.type === 'file').map((f) => ({ fileId: f.fileId, blockTags: concatTags(f) })),
    );
    if (!equalBytes(manifest, root.manifest)) throw new CorruptStoreError('the blocks differ from the manifest');
    tracker.loadState([...map.files.values()].map((f) => ({ path: f.path, fileId: f.fileId, blocks: f.ids.length })));

    this.#lastOpen = { tableMs, blocksMs: now() - t1 };
    ctx.encryptions = root.encryptions;
    this.#ctx = ctx;
    this.#map = map;
    this.#tracker = tracker;
    this.#header = opened.header;
    this.#headerRepair = opened.headerRepairNeeded;
    this.#lastRoot = sealedRoot as Bytes;
    this.#gen = root.gen;
    this.#origin = root.origin;
  }

  // ---- sync --------------------------------------------------------------------------------

  /** Whether anything is owed to the store. Hosts use it for a flush on hide or when idle. */
  hasDirty(): boolean {
    return this.#unsettled !== null || this.#headerRepair || (this.#tracker?.hasDirty() ?? false);
  }

  /**
   * Commits everything dirty. Calls are serialised: one made during a sync waits for it and then
   * for one more, and every caller's promise settles once everything dirty at its call is in the
   * store. With `relaxedDurability` true (PGlite does not await those) a failure does not reject:
   * the changes stay dirty and the next sync retries them.
   */
  override syncToFs(relaxedDurability?: boolean): Promise<void> {
    if (!this.#ready) return Promise.reject(new Error('EncryptedFs: the store is not open'));
    this.#requested = true;
    if (relaxedDurability === false) this.#strict = true;
    this.#drain ??= this.#runAll().finally(() => {
      this.#drain = null;
    });
    return relaxedDurability === true ? this.#drain.catch(() => undefined) : this.#drain;
  }

  async #runAll(): Promise<void> {
    let failure: { error: unknown } | null = null;
    while (this.#requested) {
      this.#requested = false;
      const strict = this.#strict;
      this.#strict = false;
      try {
        await this.#syncOnce(strict ? 'strict' : 'relaxed');
        failure = null;
      } catch (error) {
        if (strict) this.#strict = true;
        failure = { error };
        if (this.#fatal) break;
      }
    }
    if (failure) throw failure.error;
  }

  async #syncOnce(durability: 'strict' | 'relaxed'): Promise<void> {
    if (this.#fatal) throw this.#fatal;
    if (this.#unsettled) await this.#settle();
    const tracker = this.#tracker as Tracker;
    const snap = tracker.snapshot();
    if (isEmpty(snap) && !this.#headerRepair) return;
    let prepared: Prepared;
    try {
      prepared = await this.#prepare(snap);
    } catch (error) {
      tracker.requeue(snap);
      throw error;
    }
    const t0 = now();
    try {
      await this.#backend.commit({ expectRoot: this.#lastRoot, puts: prepared.puts, deletes: prepared.deletes, durability });
    } catch (error) {
      prepared.stats.commitMs = now() - t0;
      if (error instanceof StaleWriterError) {
        this.#stale(snap, error);
        throw error;
      }
      let stored;
      try {
        stored = await this.#backend.get(2);
      } catch {
        this.#unsettled = { prepared, snap };
        throw error;
      }
      if (!this.#settled(prepared, snap, stored as Bytes | undefined)) throw error;
      return;
    }
    prepared.stats.commitMs = now() - t0;
    this.#apply(prepared, snap);
  }

  /** Plans the snapshot against the file map and seals every record it writes. */
  async #prepare(snap: Snapshot): Promise<Prepared> {
    const ctx = this.#ctx as RecordContext;
    const t0 = now();
    const draft = (this.#map as FileMap).plan(snap, { repack: this.#lastRoot === null });
    const puts: Prepared['puts'] = [];
    let bytes = 0;
    await pool(draft.writes, async (w) => {
      const sealed = await sealBlock(ctx, w.file.fileId, w.index, w.bytes as Bytes);
      w.file.tags[w.index] = tagOf(sealed).slice();
      puts.push([w.id, sealed]);
    });
    const tables = draft.tables();
    await pool(tables, async (block) => {
      const sealed = await sealTable(ctx, fromHex(block.id), draft.encode(block));
      block.tag = tagOf(sealed).slice();
      puts.push([block.id, sealed]);
    });
    const tableDigest = await computeTableDigest(draft.order.map((id) => draft.block(id).tag));
    const manifest = await computeManifest(draft.manifestFiles());
    const { blockSize } = ctx.meta;
    const body = encodeRoot(
      {
        gen: this.#gen + 1,
        // The root's own encryption is the next one.
        encryptions: ctx.encryptions + 1,
        state: 'ready',
        origin: this.#origin,
        fileCount: draft.fileCount,
        dataBlocks: draft.dataBlocks,
        tableDigest,
        manifest,
        tableIds: draft.order.map(fromHex),
      },
      blockSize,
    );
    const root = await sealRoot(ctx, body);
    puts.push([2, root]);
    if (this.#lastRoot === null || this.#headerRepair) {
      const header = this.#header as Bytes;
      puts.push([0, header], [1, header]);
    }
    for (const [, value] of puts) bytes += value.length;
    const stats: SyncStats = {
      dataBlocks: draft.writes.length,
      tableBlocks: tables.length,
      deletes: draft.deletes.length,
      repacked: draft.repacked,
      bytes,
      encryptMs: now() - t0,
      commitMs: 0,
    };
    return { draft, root, puts, deletes: draft.deletes, stats };
  }

  /**
   * After a commit whose outcome is unknown, decides by the stored root: this plan's root means it
   * applied (true); the previous root means nothing was written (false, the snapshot is owed
   * again); anything else is another writer.
   */
  #settled(prepared: Prepared, snap: Snapshot, stored: Bytes | undefined): boolean {
    if (stored !== undefined && equalBytes(stored, prepared.root)) {
      this.#apply(prepared, snap);
      return true;
    }
    const previous = this.#lastRoot;
    if (previous === null ? stored === undefined : stored !== undefined && equalBytes(stored, previous)) {
      (this.#tracker as Tracker).requeue(snap);
      return false;
    }
    const error = new StaleWriterError('another writer committed to this store');
    this.#stale(snap, error);
    throw error;
  }

  /** Settles an unsettled commit before anything else is planned. */
  async #settle(): Promise<void> {
    const { prepared, snap } = this.#unsettled as { prepared: Prepared; snap: Snapshot };
    const stored = await this.#backend.get(2);
    this.#unsettled = null;
    this.#settled(prepared, snap, stored as Bytes | undefined);
  }

  #apply(prepared: Prepared, snap: Snapshot): void {
    (this.#map as FileMap).apply(prepared.draft);
    (this.#tracker as Tracker).commit(snap);
    this.#lastRoot = prepared.root;
    this.#gen++;
    this.#headerRepair = false;
    this.#lastSync = prepared.stats;
  }

  #stale(snap: Snapshot, error: StaleWriterError): void {
    (this.#tracker as Tracker).requeue(snap);
    this.#fatal = error;
    this.#onFatal?.(error);
  }

  // ---- close and stats ---------------------------------------------------------------------

  /** Waits for a running sync, commits what is dirty (strict), then closes the backend. */
  override async closeFs(): Promise<void> {
    try {
      await this.#drain?.catch(() => undefined);
      if (this.#ready && !this.#fatal && this.hasDirty()) await this.syncToFs(false);
    } finally {
      this.#ready = false;
      await this.#backend.close();
      await super.closeFs();
    }
  }

  stats(): EncryptedFsStats {
    const map = this.#map;
    return {
      gen: this.#gen,
      encryptions: this.#ctx?.encryptions ?? 0,
      subkeys: this.#ctx?.subkeys.size ?? 0,
      files: map?.files.size ?? 0,
      dataBlocks: map?.dataBlocks ?? 0,
      table: { blocks: map?.order.length ?? 0, fill: map?.fill ?? 0 },
      trackingGaps: this.#tracker?.stats.trackingGaps ?? 0,
      lastSync: this.#lastSync && { ...this.#lastSync },
      lastOpen: this.#lastOpen && { ...this.#lastOpen },
    };
  }
}

function concatTags(f: MapFile): Bytes {
  const out = new Uint8Array(16 * f.tags.length);
  f.tags.forEach((t, i) => {
    out.set(t as Bytes, 16 * i);
  });
  return out;
}

