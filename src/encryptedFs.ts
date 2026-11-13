// The PGlite filesystem that encrypts below Postgres. The data directory lives in MEMFS while the
// database runs; the tracker knows which blocks changed; each sync seals them, with the file-table
// blocks and a new root, into one atomic commit of the packed block space (FORMAT.md).
import { MemoryFS, type PGlite } from '@electric-sql/pglite';
import { rootMatches, type CommitBatch, type RecordKey, type Slot, type StorageBackend } from './backend/backend.ts';
import { concat, equalBytes, toHex, type Bytes } from './format/bytes.ts';
import {
  DEFAULT_BLOCK_SIZE,
  decodeRoot,
  decodeTable,
  encodeRoot,
  type BlockSize,
  type RootBody,
  type RootState,
  type TableEntry,
} from './format/codec.ts';
import {
  CorruptStoreError,
  IncompleteStoreError,
  KeyChangeUnknownError,
  StaleWriterError,
  StoreExistsError,
  StoreMissingError,
  WrongKeyError,
} from './format/errors.ts';
import { createHeader, openHeader, rewrapHeader, SubkeyCache } from './format/keys.ts';
import { computeManifest, computeTableDigest } from './format/manifest.ts';
import { openBlock, openRoot, openTable, sealBlock, sealRoot, sealTable, tagOf, type RecordContext } from './format/records.ts';
import { selfTest } from './format/selfTest.ts';
import { assembleFiles } from './format/table.ts';
import { Draft, FileMap, fromHex, remap, type MapFile } from './fs/fileMap.ts';
import { PAGE, pool } from './fs/pool.ts';
import { installTracker, type EmscriptenFS, type MemFS, type MemNode, type Snapshot, type Tracker } from './tracker/tracker.ts';
import { checkBlocks, verifyStore, type VerifyOptions, type VerifyResult } from './verify.ts';

const PGDATA = '/pglite/data';
/** The key id of a new store's first data key. */
const FIRST_KEY_ID = 1;
/** Loads begun while another writer keeps committing, before the open gives up. */
const LOAD_ATTEMPTS = 3;
/** The names a rotation records for the two slots of a pair (`<name>.a`, `<name>.b`). */
const SLOT_NAMES = ['a', 'b'] as const;

export type OpenMode = 'open' | 'create' | 'open-or-create';

export interface OpenProgress {
  phase: 'table' | 'blocks';
  done: number;
  total: number;
}

export interface EncryptedFsOptions {
  /**
   * The store: one backend, or a pair (`IndexedDbBackend.pair(name)`). A data-key rotation writes the
   * new store into the empty one of a pair, so an open finds the current store by itself.
   */
  backend: StorageBackend | readonly [StorageBackend, StorageBackend];
  /** The KEK: a non-extractable AES-GCM key with `wrapKey` and `unwrapKey` usages (see `importKek`). */
  key: CryptoKey;
  mode: OpenMode;
  /** Used only when a store is created. */
  blockSize?: BlockSize;
  /** Load progress, for a splash screen. */
  onProgress?: (progress: OpenProgress) => void;
  /** Called once when this instance stops syncing because another writer committed a newer store. */
  onFatal?: (error: Error) => void;
  /**
   * One backend only: opens the store an interrupted rotation was writing, by the name its
   * `backendFactory` gave, so that the open can finish or undo the rotation. Without it, such a store
   * gives IncompleteStoreError with `rotation: true`.
   */
  openOrigin?: (name: string) => StorageBackend;
}

export interface RotateProgress {
  /** `copy`: every block, from memory; `catch-up`: what changed meanwhile, then the file table; `verify`: the new store read back. */
  phase: 'copy' | 'catch-up' | 'verify';
  done: number;
  total: number;
}

export interface RotateOptions {
  /** One backend only (a pair rotates into its empty slot): an empty backend for the new store, and the name `openOrigin` opens it by. */
  backendFactory?: () => { name: string; backend: StorageBackend };
  onProgress?: (progress: RotateProgress) => void;
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

type Durability = CommitBatch['durability'];

const now = () => performance.now();

const isEmpty = (s: Snapshot) =>
  s.blocks.length === 0 && s.inodes.length === 0 && s.deleteRanges.length === 0 && s.deadFiles.length === 0;

/** Removes a store: every record, and the storage itself where the backend can (an IndexedDB database). */
async function deleteStore(backend: StorageBackend): Promise<void> {
  await backend.clear();
  await backend.destroy?.();
}

/**
 * Commits `batch`, which puts `value` in `slot`. A rejection other than a stale writer is settled by
 * reading the slot back: `value` there means the batch applied; otherwise the rejection stands.
 */
async function commitSettled(backend: StorageBackend, batch: CommitBatch, slot: Slot, value: Bytes): Promise<void> {
  try {
    await backend.commit(batch);
  } catch (error) {
    if (error instanceof StaleWriterError) throw error;
    let stored: Uint8Array | undefined;
    try {
      stored = await backend.get(slot);
    } catch {
      throw error;
    }
    if (stored === undefined || !equalBytes(stored, value)) throw error;
  }
}

/**
 * Which key opens the header `backend` holds, read back after a header commit that rejected: 'new'
 * when `newKek` does, 'old' when only `oldKek` does, 'unknown' when the read fails or neither does.
 */
async function headerKey(backend: StorageBackend, oldKek: CryptoKey, newKek: CryptoKey): Promise<'new' | 'old' | 'unknown'> {
  const copies = await Promise.all([backend.get(0), backend.get(1)]).catch(() => null);
  if (copies === null) return 'unknown';
  const [copy0, copy1] = copies as Array<Bytes | undefined>;
  const opens = (kek: CryptoKey) =>
    openHeader(kek, copy0, copy1).then(
      () => true,
      () => false,
    );
  if (await opens(newKek)) return 'new';
  return (await opens(oldKek)) ? 'old' : 'unknown';
}

/** A store's header and root, opened. */
interface OpenedRoot {
  ctx: RecordContext;
  root: RootBody;
  sealed: Bytes;
}

/** A store's header and root, opened; null for a store without a root or without a header, which nothing opens. */
async function openRootOf(backend: StorageBackend, kek: CryptoKey): Promise<OpenedRoot | null> {
  const [copy0, copy1, sealed] = (await Promise.all([backend.get(0), backend.get(1), backend.get(2)])) as Array<Bytes | undefined>;
  if (sealed === undefined || (copy0 === undefined && copy1 === undefined)) return null;
  const { dek, meta } = await openHeader(kek, copy0, copy1);
  const ctx: RecordContext = { subkeys: new SubkeyCache(dek), meta, encryptions: 0 };
  const root = decodeRoot(await openRoot(ctx, sealed));
  ctx.encryptions = root.encryptions;
  return { ctx, root, sealed };
}

/** The root body for the map as `draft` leaves it. The root's own encryption is the next one. */
async function rootBody(draft: Draft, ctx: RecordContext, fields: Pick<RootBody, 'gen' | 'state' | 'origin'>): Promise<RootBody> {
  const encryptions = ctx.encryptions + 1;
  const tableDigest = await computeTableDigest(draft.order.map((id) => draft.block(id).tag));
  const manifest = await computeManifest(draft.manifestFiles());
  return {
    ...fields,
    encryptions,
    fileCount: draft.fileCount,
    dataBlocks: draft.dataBlocks,
    tableDigest,
    manifest,
    tableIds: draft.order.map(fromHex),
  };
}

/** Block `index` of a MEMFS file as it is now, zero-padded; zeros for a file no longer there. */
function blockOf(node: MemNode | undefined, index: number, blockSize: number): Bytes {
  const bytes = new Uint8Array(blockSize);
  const contents = node?.contents as Uint8Array | null | undefined;
  if (node && contents) bytes.set(contents.subarray(index * blockSize, Math.min((index + 1) * blockSize, node.usedBytes ?? 0)));
  return bytes;
}

/**
 * Seals `items` and commits them strict, at most PAGE records per commit, so that one batch of
 * ciphertext is held at a time. `deletes` go with the first commit. The store being written has no
 * root yet, and each commit requires that: once another instance switched to a store in that slot,
 * the commit gets StaleWriterError instead of adding records to it.
 */
async function putInBatches<T>(
  backend: StorageBackend,
  items: readonly T[],
  seal: (item: T) => Promise<[RecordKey, Bytes]>,
  deletes: readonly RecordKey[],
  onBatch: (done: number) => void,
): Promise<void> {
  for (let at = 0; at < items.length || (at === 0 && deletes.length > 0); at += PAGE) {
    const batch = items.slice(at, at + PAGE);
    const puts: Array<[RecordKey, Bytes]> = [];
    await pool(batch, async (item) => {
      puts.push(await seal(item));
    });
    await backend.commit({ expectRoot: null, puts, deletes: at === 0 ? [...deletes] : [], durability: 'strict' });
    onBatch(at + batch.length);
  }
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
  /** One backend, or the two of a pair. */
  readonly #slots: StorageBackend[];
  /** The backend that holds the store. */
  #backend: StorageBackend;
  #key: CryptoKey;
  readonly #mode: OpenMode;
  readonly #createBlockSize: BlockSize;
  readonly #onProgress: ((progress: OpenProgress) => void) | undefined;
  readonly #onFatal: ((error: Error) => void) | undefined;
  readonly #openOrigin: ((name: string) => StorageBackend) | undefined;

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
  #unsettled: { prepared: Prepared; snap: Snapshot; durability: Durability } | null = null;
  #drain: Promise<void> | null = null;
  #requested = false;
  #strict = false;
  /** A commit applied since the last strict one: a strict request still owes a strict commit. */
  #owesStrict = false;
  /** The sync running now, if any. */
  #syncing: Promise<void> | null = null;
  /** Set while a key change, rotation or verify runs: syncs wait for it. */
  #hold: Promise<void> | null = null;

  #lastSync: SyncStats | null = null;
  #lastOpen: { tableMs: number; blocksMs: number } | null = null;

  constructor(options: EncryptedFsOptions) {
    super();
    const { backend } = options;
    this.#slots = Array.isArray(backend) ? [...(backend as readonly StorageBackend[])] : [backend as StorageBackend];
    this.#backend = this.#slots[0] as StorageBackend;
    this.#key = options.key;
    this.#mode = options.mode;
    this.#createBlockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    this.#onProgress = options.onProgress;
    this.#onFatal = options.onFatal;
    this.#openOrigin = options.openOrigin;
  }

  override async init(pg: PGlite, emscriptenOptions: Parameters<MemoryFS['init']>[1]): ReturnType<MemoryFS['init']> {
    await selfTest();
    const { emscriptenOpts } = await super.init(pg, emscriptenOptions);
    // The tracker needs the block size, which an existing store keeps in its header: it is
    // installed by initialSyncFs.
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
      this.#backend = await this.#open(FS);
      // One backend, resumed into the store of its origin: that is the backend now.
      if (this.#slots.length === 1) this.#slots[0] = this.#backend;
    } catch (error) {
      if (FS.analyzePath(PGDATA).exists) clearDir(FS, PGDATA);
      throw error;
    }
    this.#ready = true;
  }

  /** Finds the store among the slots, finishes or undoes a rotation a crash interrupted, and loads it. */
  async #open(FS: ModuleFS): Promise<StorageBackend> {
    const slots = this.#slots;
    const used: StorageBackend[] = [];
    for (const backend of slots) if (!(await backend.isEmpty())) used.push(backend);
    const [store, other] = used;
    if (store === undefined) {
      if (this.#mode === 'open') throw new StoreMissingError('there is no store to open');
      await this.#create(FS);
      return slots[0] as StorageBackend;
    }
    if (other === undefined) {
      // A root marked "rotating": a rotation from this store was interrupted. Anything else, and
      // anything that does not open here, is for the load to report.
      const opened = this.#mode === 'create' ? null : await openRootOf(store, this.#key).catch(() => null);
      const mark = opened?.root.state === 'rotating' ? opened : null;
      const next = mark === null ? undefined : slots.length === 2 ? slots[slots.indexOf(store) ^ 1] : this.#openOrigin?.(mark.root.origin);
      if (mark === null || next === undefined) {
        await this.#load(FS, store);
        return store;
      }
      return this.#resume(FS, store, next, mark);
    }
    // Two stores: a rotation from the one marked "rotating" into the other. Without a mark, a store
    // with no root or no header is what an undone rotation left, and is deleted.
    if (this.#mode === 'create') throw new StoreExistsError('a store exists');
    const opened = await Promise.all(used.map((backend) => openRootOf(backend, this.#key)));
    const marked = opened.map((o) => o?.root.state === 'rotating');
    const from = marked.indexOf(true);
    if (from !== -1 && !marked[1 - from]) {
      return this.#resume(FS, used[from] as StorageBackend, used[1 - from] as StorageBackend, opened[from] as OpenedRoot);
    }
    const left = opened.indexOf(null);
    if (from === -1 && left !== -1 && opened[1 - left] !== null) {
      const kept = used[1 - left] as StorageBackend;
      await deleteStore(used[left] as StorageBackend);
      await this.#load(FS, kept);
      return kept;
    }
    throw new CorruptStoreError('the two stores of the pair are not a rotation');
  }

  /**
   * Resumes a rotation from `from`, whose root is `mark`, into `to`. A new store that loads (so its
   * root is ready and every record checks) is the store, and the old one is deleted. Otherwise the
   * old one is set back to ready and loaded, and the new store is deleted. An open cannot tell a
   * crashed rotation from one that still runs, so before either store is deleted the old root moves
   * off the mark, in a commit guarded by it, as the rotation's own step 8 does: only one of them
   * wins, and the others get StaleWriterError and delete nothing.
   */
  async #resume(FS: ModuleFS, from: StorageBackend, to: StorageBackend, mark: OpenedRoot): Promise<StorageBackend> {
    const { ctx, root, sealed } = mark;
    // A pair keeps both backends; one backend keeps only the store it ends on.
    const drop = async (backend: StorageBackend) => {
      await deleteStore(backend);
      if (this.#slots.length === 1) await backend.close();
    };
    const move = async (state: RootState, origin: string) => {
      const body: RootBody = { ...root, gen: root.gen + 1, encryptions: ctx.encryptions + 1, state, origin };
      const next = await sealRoot(ctx, encodeRoot(body, ctx.meta.blockSize));
      await commitSettled(from, { expectRoot: sealed, puts: [[2, next]], deletes: [], durability: 'strict' }, 2, next);
    };
    let loaded = false;
    if (!(await to.isEmpty())) {
      try {
        await this.#load(FS, to);
        loaded = true;
      } catch (error) {
        if (!(error instanceof CorruptStoreError) && !(error instanceof IncompleteStoreError)) throw error;
        if (FS.analyzePath(PGDATA).exists) clearDir(FS, PGDATA);
      }
    }
    if (loaded) {
      // Still "rotating" until it is deleted, so that a crash in between finishes the rotation again.
      await move('rotating', root.origin);
      await drop(from);
      return to;
    }
    await move('ready', '');
    await drop(to);
    await this.#load(FS, from);
    return from;
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

  /**
   * Slots, table and blocks are separate backend reads, so a writer that commits during a load makes
   * a healthy store look corrupt. A root that moved meanwhile says so, and the load starts over.
   */
  async #load(FS: ModuleFS, backend: StorageBackend): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const slots = await Promise.all([backend.get(0), backend.get(1), backend.get(2)]);
      try {
        await this.#loadFrom(FS, backend, slots);
        return;
      } catch (error) {
        if (!(error instanceof CorruptStoreError) || rootMatches(await backend.get(2), slots[2] ?? null)) throw error;
        if (attempt === LOAD_ATTEMPTS) throw new StaleWriterError('another writer kept committing while the store loaded');
        if (FS.analyzePath(PGDATA).exists) clearDir(FS, PGDATA);
      }
    }
  }

  /** Loads the store the slots name. The tracker is installed only once the load is complete. */
  async #loadFrom(FS: ModuleFS, backend: StorageBackend, slots: Array<Uint8Array | undefined>): Promise<void> {
    const [copy0, copy1, sealedRoot] = slots;

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

    // 3. Blocks, in the order of their random ids. The next page is read while this one decrypts,
    // so a load holds at most two pages of ciphertext (review S5, as restated by the owner on #10).
    const t1 = now();
    const tableSet = new Set(tableIds);
    const total = tableIds.length + root.dataBlocks;
    let read = 0;
    let done = 0;
    const readPage = (after: string | null) => {
      const next = backend.readRange(after, PAGE);
      next.catch(() => undefined); // awaited below; not unhandled if this page's decrypt throws first
      return next;
    };
    for (let next: Promise<Array<[string, Uint8Array]>> | null = readPage(null); next; ) {
      const page: Array<[string, Uint8Array]> = await next;
      if (page.length === 0) break;
      next = page.length < PAGE ? null : readPage((page[page.length - 1] as [string, Uint8Array])[0]);
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
    }
    if (read !== root.dataBlocks) throw new CorruptStoreError('a data block is missing');
    const manifest = await computeManifest(
      [...map.files.values()].filter((f) => f.type === 'file').map((f) => ({ fileId: f.fileId, blockTags: concat(f.tags as Bytes[]) })),
    );
    if (!equalBytes(manifest, root.manifest)) throw new CorruptStoreError('the blocks differ from the manifest');
    const tracker = installTracker(FS, FS.filesystems.MEMFS, PGDATA, blockSize);
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
    this.#drain ??= this.#runAll();
    return relaxedDurability === true ? this.#drain.catch(() => undefined) : this.#drain;
  }

  /**
   * Runs syncs while one is requested. `#drain` is cleared in the same step that leaves the loop,
   * so a call after that step starts a new run instead of getting this finished one back. The
   * loop always awaits first, so `syncToFs` has assigned `#drain` before it is cleared.
   */
  async #runAll(): Promise<void> {
    let failure: { error: unknown } | null = null;
    try {
      while (this.#requested) {
        if (this.#hold) {
          await this.#hold;
          continue;
        }
        this.#requested = false;
        const strict = this.#strict;
        this.#strict = false;
        try {
          const sync = strict ? this.#syncStrict() : this.#syncOnce('relaxed');
          this.#syncing = sync;
          await sync;
          failure = null;
        } catch (error) {
          if (strict) this.#strict = true;
          failure = { error };
          if (this.#fatal) break;
        } finally {
          this.#syncing = null;
        }
      }
    } finally {
      this.#drain = null;
    }
    if (failure) throw failure.error;
  }

  async #syncOnce(durability: Durability): Promise<void> {
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
        this.#unsettled = { prepared, snap, durability };
        throw error;
      }
      if (!this.#settled(prepared, snap, stored as Bytes | undefined, durability)) throw error;
      return;
    }
    prepared.stats.commitMs = now() - t0;
    this.#apply(prepared, snap, durability);
  }

  /**
   * A strict sync. When it had nothing to commit but a commit since the last strict one was not
   * strict (a relaxed sync it joined, say), it puts the root again, unchanged, in a strict commit:
   * that makes the store durable up to it.
   */
  async #syncStrict(): Promise<void> {
    await this.#syncOnce('strict');
    if (!this.#owesStrict) return;
    const root = this.#lastRoot as Bytes;
    try {
      await this.#backend.commit({ expectRoot: root, puts: [[2, root]], deletes: [], durability: 'strict' });
    } catch (error) {
      if (error instanceof StaleWriterError) this.#setFatal(error);
      throw error;
    }
    this.#owesStrict = false;
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
    const body = await rootBody(draft, ctx, { gen: this.#gen + 1, state: 'ready', origin: this.#origin });
    const root = await sealRoot(ctx, encodeRoot(body, ctx.meta.blockSize));
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
  #settled(prepared: Prepared, snap: Snapshot, stored: Bytes | undefined, durability: Durability): boolean {
    if (stored !== undefined && equalBytes(stored, prepared.root)) {
      this.#apply(prepared, snap, durability);
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
    const { prepared, snap, durability } = this.#unsettled as { prepared: Prepared; snap: Snapshot; durability: Durability };
    const stored = await this.#backend.get(2);
    this.#unsettled = null;
    this.#settled(prepared, snap, stored as Bytes | undefined, durability);
  }

  #apply(prepared: Prepared, snap: Snapshot, durability: Durability): void {
    (this.#map as FileMap).apply(prepared.draft);
    (this.#tracker as Tracker).commit(snap);
    this.#lastRoot = prepared.root;
    this.#gen++;
    this.#headerRepair = false;
    this.#owesStrict = durability !== 'strict';
    this.#lastSync = prepared.stats;
  }

  #stale(snap: Snapshot, error: StaleWriterError): void {
    (this.#tracker as Tracker).requeue(snap);
    this.#setFatal(error);
  }

  #setFatal(error: Error): void {
    if (this.#fatal) return;
    this.#fatal = error;
    this.#onFatal?.(error);
  }

  // ---- keys and verify ---------------------------------------------------------------------

  /**
   * Runs a key operation on the open, idle store: it waits for the running sync and settles an
   * unsettled one, and syncs wait for it.
   */
  async #exclusive<T>(run: () => Promise<T>): Promise<T> {
    while (this.#hold) await this.#hold;
    if (!this.#ready) throw new Error('EncryptedFs: the store is not open');
    let release = (): void => undefined;
    this.#hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await this.#syncing?.catch(() => undefined);
      if (this.#fatal) throw this.#fatal;
      if (this.#unsettled) await this.#settle();
      return await run();
    } finally {
      this.#hold = null;
      release();
    }
  }

  /**
   * The other slot of a pair holds a store only when a rotation or an open could not delete the one
   * it left: a root marked "rotating", or none. That one is deleted once a read of this store's root
   * shows it is still the one this instance wrote. A root that moved, or a ready root in the other
   * slot, is another writer's: StaleWriterError, and nothing is deleted.
   */
  async #dropLeftover(): Promise<void> {
    const other = this.#slots.find((backend) => backend !== this.#backend);
    if (!other || (await other.isEmpty())) return;
    const current = rootMatches(await this.#backend.get(2), this.#lastRoot);
    const left = current ? await openRootOf(other, this.#key) : null;
    if (!current || (left !== null && left.root.state !== 'rotating')) {
      const error = new StaleWriterError('another writer committed to this store');
      this.#setFatal(error);
      throw error;
    }
    await deleteStore(other);
  }

  /**
   * Wraps the same data key under `newKek` (a non-extractable AES-GCM key with `wrapKey` and
   * `unwrapKey`). One commit puts the new header in both copies, so the store is never under two
   * keys at once. Afterwards the old key does not open the store, but it still opens a copy of the
   * old header, and with it any later copy of the store: after a suspected exposure, rotate the
   * data key too (`rotateDataKey`).
   *
   * A commit that rejects is settled by reading the header back: when the new key opens it, the
   * change is done; when the old key does, this rejects with the commit's error; when the read
   * fails (or neither opens it), with KeyChangeUnknownError: either key may open the store.
   */
  changeKey(newKek: CryptoKey): Promise<void> {
    return this.#exclusive(async () => {
      await this.#dropLeftover();
      const header = await rewrapHeader(this.#key, newKek, this.#header as Bytes);
      // A store not written yet gets its header with its first sync.
      if (this.#lastRoot !== null) {
        const batch: CommitBatch = { expectRoot: this.#lastRoot, puts: [[0, header], [1, header]], deletes: [], durability: 'strict' };
        try {
          await this.#backend.commit(batch);
        } catch (error) {
          if (error instanceof StaleWriterError) {
            this.#setFatal(error);
            throw error;
          }
          const opener = await headerKey(this.#backend, this.#key, newKek);
          if (opener === 'old') throw error;
          if (opener === 'unknown') {
            throw new KeyChangeUnknownError(
              'changeKey: the commit failed, and reading the header back did not show whether it applied: keep both keys, then call changeKey again or open with either',
              { cause: error },
            );
          }
        }
      }
      this.#key = newKek;
      this.#header = header;
      this.#headerRepair = false;
    });
  }

  /** Checks every record of the store (`verifyStore`), with syncs held back meanwhile. */
  verify(options: VerifyOptions = {}): Promise<VerifyResult> {
    return this.#exclusive(() => verifyStore(this.#backend, this.#key, options));
  }

  /**
   * A new data key, and every record sealed again under it, in a fresh store that then replaces this
   * one: the empty slot of a pair, or `backendFactory()`'s backend. The KEK stays: after a suspected
   * exposure, call `changeKey` first. Queries keep running; syncs wait, and what they owe becomes
   * durable when the rotation is done. A failure before the switch leaves the old store as it was,
   * and nothing in memory is lost.
   */
  rotateDataKey(options: RotateOptions = {}): Promise<void> {
    return this.#exclusive(() => this.#rotate(options));
  }

  async #rotate({ backendFactory, onProgress }: RotateOptions): Promise<void> {
    const single = this.#slots.length === 1;
    const from = this.#backend;
    let to: StorageBackend;
    let name: string;
    if (single) {
      if (!backendFactory) throw new TypeError('rotateDataKey: a single backend needs a backendFactory');
      ({ name, backend: to } = backendFactory());
      if (!(await to.isEmpty())) throw new StoreExistsError('the backend to rotate into is not empty');
    } else {
      await this.#dropLeftover();
      const i = this.#slots.indexOf(from) ^ 1;
      to = this.#slots[i] as StorageBackend;
      name = SLOT_NAMES[i] as string;
    }
    const tracker = this.#tracker as Tracker;
    let before = this.#lastRoot;
    let mark: Bytes | null = null;
    let snap: Snapshot | null = null;
    let next: { ctx: RecordContext; map: FileMap; header: Bytes; root: Bytes; snap: Snapshot; retired: Bytes };
    try {
      // 1. Flush. Syncs stay held back from here to the end; the tracker collects what queries change.
      await this.#syncOnce('strict');
      before = this.#lastRoot;

      // 2. Mark the old store, with the new store's name inside its encrypted root.
      mark = await this.#sealRootAs(this.#gen + 1, 'rotating', name);
      await commitSettled(from, { expectRoot: before, puts: [[2, mark]], deletes: [], durability: 'strict' }, 2, mark);

      // 3. The new store: a new data key under the same KEK and both header copies, then every block
      // read from MEMFS under a fresh id. No root, so it reads as incomplete. The copy is fuzzy:
      // queries may change blocks while it runs, and step 4 puts those again.
      const old = this.#ctx as RecordContext;
      const { blockSize } = old.meta;
      const created = await createHeader(this.#key, { blockSize, keyId: old.meta.keyId + 1 });
      const ctx: RecordContext = { subkeys: new SubkeyCache(created.dek), meta: created.meta, encryptions: 0 };
      await to.commit({ expectRoot: null, puts: [[0, created.header], [1, created.header]], deletes: [], durability: 'strict' });
      const map = remap(this.#map as FileMap);
      const nodes = new Map(tracker.files().map((f) => [toHex(f.fileId), f.node]));
      const copy = [...map.files.values()].flatMap((file) => file.ids.map((id, index) => ({ id, file, index })));
      await putInBatches(
        to,
        copy,
        async ({ id, file, index }): Promise<[RecordKey, Bytes]> => {
          const sealed = await sealBlock(ctx, file.fileId, index, blockOf(nodes.get(file.key), index, blockSize));
          file.tags[index] = tagOf(sealed).slice();
          return [id, sealed];
        },
        [],
        (done) => onProgress?.({ phase: 'copy', done, total: copy.length }),
      );

      // 4. Catch up: every block, inode and delete since step 1, through the new map. The data blocks
      // now equal MEMFS as of the snapshot. Then the file table, once, packed densely.
      snap = tracker.snapshot();
      const draft = map.plan(snap, { repack: true });
      const tables = draft.tables();
      const total = draft.writes.length + tables.length;
      await putInBatches(
        to,
        draft.writes,
        async (w): Promise<[RecordKey, Bytes]> => {
          const sealed = await sealBlock(ctx, w.file.fileId, w.index, w.bytes as Bytes);
          w.file.tags[w.index] = tagOf(sealed).slice();
          return [w.id, sealed];
        },
        draft.deletes,
        (done) => onProgress?.({ phase: 'catch-up', done, total }),
      );
      await putInBatches(
        to,
        tables,
        async (block): Promise<[RecordKey, Bytes]> => {
          const sealed = await sealTable(ctx, fromHex(block.id), draft.encode(block));
          block.tag = tagOf(sealed).slice();
          return [block.id, sealed];
        },
        [],
        (done) => onProgress?.({ phase: 'catch-up', done: draft.writes.length + done, total }),
      );
      map.apply(draft);

      // 5. Read it back: both header copies, and every record there, opening as the map says, and
      // nothing else.
      const body = await rootBody(new Draft(map), ctx, { gen: this.#gen + 2, state: 'ready', origin: this.#origin });
      const check = await checkBlocks(to, ctx, body, 2, (p) => {
        if (p.phase === 'blocks') onProgress?.({ phase: 'verify', done: p.done, total: p.total });
      });
      const copies = await Promise.all([to.get(0), to.get(1)]);
      if (!check.ok || !copies.every((c) => c !== undefined && equalBytes(c, created.header))) {
        throw new CorruptStoreError('the new store does not read back as it was written');
      }

      // 6. The switch: the new store's root. Until it is in, the old store is the store.
      const root = await sealRoot(ctx, encodeRoot(body, blockSize));
      // Step 8's old root, sealed while the old data key and map are the filesystem's.
      const retired = await this.#sealRootAs(this.#gen + 2, 'rotating', name);
      await commitSettled(to, { expectRoot: null, puts: [[2, root]], deletes: [], durability: 'strict' }, 2, root);
      next = { ctx, map, header: created.header, root, snap, retired };
    } catch (error) {
      if (snap) tracker.requeue(snap);
      await this.#undoRotation(from, to, before, mark, single);
      if (error instanceof StaleWriterError) this.#setFatal(error);
      throw error;
    }

    // 7. The filesystem moves to the new store.
    this.#backend = to;
    if (single) this.#slots[0] = to;
    this.#ctx = next.ctx;
    this.#map = next.map;
    this.#header = next.header;
    this.#headerRepair = false;
    this.#lastRoot = next.root;
    this.#gen += 2;
    tracker.commit(next.snap);

    // 8. Retire the old store, then delete it. The retiring commit keeps the old root "rotating", so
    // that a crash before the deletion finishes the rotation at the next open, and it is guarded by
    // the mark: an instance that opened the pair since step 2 took this rotation for an interrupted
    // one and finished or undid it, or this one retires the old store, never both. On
    // StaleWriterError the old store is not touched, the new one is deleted if the other instance
    // kept the old one, and this instance stops. Should anything else fail, the old store stays
    // marked, and the next open of the pair, or its next rotation or key change, deletes it.
    try {
      const retired = next.retired;
      await commitSettled(from, { expectRoot: mark, puts: [[2, retired]], deletes: [], durability: 'strict' }, 2, retired);
      await deleteStore(from);
    } catch (error) {
      if (!(error instanceof StaleWriterError)) return;
      const kept = await openRootOf(from, this.#key).catch(() => null);
      if (kept !== null && kept.root.state !== 'rotating') {
        // Guarded by this rotation's root, so that nothing written into the slot since is deleted.
        await to
          .commit({ expectRoot: next.root, puts: [], deletes: [0, 1, 2], durability: 'strict' })
          .then(() => deleteStore(to))
          .catch(() => undefined);
      }
      this.#setFatal(error);
      throw error;
    } finally {
      if (single) await from.close().catch(() => undefined);
    }
  }

  /** The current map's root, sealed with another state or origin: to mark a rotation, to retire the old store, and to undo the mark. */
  async #sealRootAs(gen: number, state: RootState, origin: string): Promise<Bytes> {
    const ctx = this.#ctx as RecordContext;
    const body = await rootBody(new Draft(this.#map as FileMap), ctx, { gen, state, origin });
    return sealRoot(ctx, encodeRoot(body, ctx.meta.blockSize));
  }

  /**
   * A rotation failed before the switch. It writes into the new store only once its mark is in the
   * old one, and an instance that moved the root off the mark owns both stores from then on. So the
   * new store is deleted, and the old one set back to ready in a commit guarded by the mark, only
   * while the old store still holds the mark. Without the mark, or with the old store's root as it
   * was, nothing of this rotation is anywhere. Any other root is another writer's: nothing is
   * deleted, and this instance stops. Should the undo fail, the old store stays marked, the next
   * open resolves it, and this instance stops syncing.
   */
  async #undoRotation(from: StorageBackend, to: StorageBackend, before: Bytes | null, mark: Bytes | null, single: boolean): Promise<void> {
    try {
      if (mark === null) return;
      const stored = await from.get(2);
      if (rootMatches(stored, before)) return;
      if (!rootMatches(stored, mark)) throw new StaleWriterError('another writer committed to this store');
      await deleteStore(to);
      const ready = await this.#sealRootAs(this.#gen + 2, 'ready', this.#origin);
      await commitSettled(from, { expectRoot: mark, puts: [[2, ready]], deletes: [], durability: 'strict' }, 2, ready);
      this.#lastRoot = ready;
      this.#gen += 2;
    } catch (error) {
      this.#setFatal(error instanceof Error ? error : new Error('EncryptedFs: a failed rotation could not be undone'));
    } finally {
      if (single) await to.close().catch(() => undefined);
    }
  }

  // ---- close and stats ---------------------------------------------------------------------

  /**
   * Waits for a running sync or key operation, commits what is dirty (strict), then closes the
   * backends and drops the module's FS, the tracker and the file map. PGlite drops its module on
   * close; through these, a host that keeps the closed instance kept the wasm memory and the data
   * directory too (#42).
   */
  override async closeFs(): Promise<void> {
    try {
      while (this.#hold) await this.#hold;
      await this.#drain?.catch(() => undefined);
      if (this.#ready && !this.#fatal && (this.hasDirty() || this.#owesStrict)) await this.syncToFs(false);
    } finally {
      this.#ready = false;
      await Promise.all(this.#slots.map((backend) => backend.close()));
      await super.closeFs();
      this.#FS = null;
      this.#tracker = null;
      this.#map = null;
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
