// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// The PGlite filesystem that encrypts below Postgres: MEMFS while running, sealed blocks plus a new
// root committed atomically on each sync (FORMAT.md).
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
const FIRST_KEY_ID = 1;
// Load retries while another writer keeps committing.
const LOAD_ATTEMPTS = 3;
const SLOT_NAMES = ['a', 'b'] as const;

export type OpenMode = 'open' | 'create' | 'open-or-create';

export interface OpenProgress {
  phase: 'table' | 'blocks';
  done: number;
  total: number;
}

export interface EncryptedFsOptions {
  /** The store: one backend, or a pair (`IndexedDbBackend.pair(name)`); a rotation writes into the pair's empty slot. */
  backend: StorageBackend | readonly [StorageBackend, StorageBackend];
  /** The KEK: non-extractable AES-GCM with `wrapKey`/`unwrapKey` (see `importKek`). */
  key: CryptoKey;
  mode: OpenMode;
  /** Used only when a store is created. */
  blockSize?: BlockSize;
  onProgress?: (progress: OpenProgress) => void;
  /** Called once when another writer's newer store stops this instance syncing. */
  onFatal?: (error: Error) => void;
  /** One backend only: opens the store an interrupted rotation was writing (by its `backendFactory` name), so the
   * open can finish or undo it; otherwise IncompleteStoreError with `rotation: true`. */
  openOrigin?: (name: string) => StorageBackend;
}

export interface RotateProgress {
  /** `copy`: all blocks; `catch-up`: changes since, then the file table; `verify`: read-back. */
  phase: 'copy' | 'catch-up' | 'verify';
  done: number;
  total: number;
}

export interface RotateOptions {
  /** One backend only: an empty backend for the new store, and the name `openOrigin` opens it by. */
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
  lastSync: SyncStats | null;
  /** null for a store this instance created. */
  lastOpen: { tableMs: number; blocksMs: number } | null;
}

interface ModuleFS extends EmscriptenFS {
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

interface ModuleMemory {
  HEAPU8?: Uint8Array;
  wasmMemory?: WebAssembly.Memory;
}

// Zeroes snapshot plaintext once committed or requeued.
function wipeSnapshot(snap: Snapshot): void {
  for (const block of snap.blocks) block.bytes.fill(0);
}

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

async function deleteStore(backend: StorageBackend): Promise<void> {
  await backend.clear();
  await backend.destroy?.();
}

// Commits `batch`; a non-stale rejection is settled by reading `slot` back: `value` there means it applied.
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

// After a rejected header commit: 'new' if newKek opens it, 'old' if only oldKek does, else 'unknown'.
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

interface OpenedRoot {
  ctx: RecordContext;
  root: RootBody;
  sealed: Bytes;
}

// null for a store without a root or header.
async function openRootOf(backend: StorageBackend, kek: CryptoKey): Promise<OpenedRoot | null> {
  const [copy0, copy1, sealed] = (await Promise.all([backend.get(0), backend.get(1), backend.get(2)])) as Array<Bytes | undefined>;
  if (sealed === undefined || (copy0 === undefined && copy1 === undefined)) return null;
  const { dek, meta } = await openHeader(kek, copy0, copy1);
  const ctx: RecordContext = { subkeys: new SubkeyCache(dek), meta, encryptions: 0 };
  const root = decodeRoot(await openRoot(ctx, sealed));
  ctx.encryptions = root.encryptions;
  return { ctx, root, sealed };
}

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

// Zeros for a file no longer there.
function blockOf(node: MemNode | undefined, index: number, blockSize: number): Bytes {
  const bytes = new Uint8Array(blockSize);
  const contents = node?.contents as Uint8Array | null | undefined;
  if (node && contents) bytes.set(contents.subarray(index * blockSize, Math.min((index + 1) * blockSize, node.usedBytes ?? 0)));
  return bytes;
}

// Seals and commits `items` strict, at most PAGE records per commit; `deletes` go with the first. The store has no
// root yet and each commit requires that, so a store another instance switched to gives StaleWriterError.
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
  readonly #slots: StorageBackend[];
  #backend: StorageBackend;
  #key: CryptoKey;
  readonly #mode: OpenMode;
  readonly #createBlockSize: BlockSize;
  readonly #onProgress: ((progress: OpenProgress) => void) | undefined;
  readonly #onFatal: ((error: Error) => void) | undefined;
  readonly #openOrigin: ((name: string) => StorageBackend) | undefined;

  #FS: ModuleFS | null = null;
  #MEMFS: MemFS | null = null;
  #mod: ModuleMemory | null = null;
  #tracker: Tracker | null = null;
  #ctx: RecordContext | null = null;
  #map: FileMap | null = null;
  #header: Bytes | null = null;
  #headerRepair = false;
  /** null while the store does not exist. */
  #lastRoot: Bytes | null = null;
  #gen = 0;
  #origin = '';

  #ready = false;
  /** Set when another writer committed: syncs stay disabled. */
  #fatal: Error | null = null;
  /** Unsettled commit: plan and snapshot, kept until a root read settles it. */
  #unsettled: { prepared: Prepared; snap: Snapshot; durability: Durability } | null = null;
  #drain: Promise<void> | null = null;
  #requested = false;
  #strict = false;
  /** A relaxed commit since the last strict one: a strict request still owes one. */
  #owesStrict = false;
  #syncing: Promise<void> | null = null;
  /** A key change, rotation or verify runs: syncs wait. */
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
    // The tracker needs the header's block size: installed by initialSyncFs.
    // PGlite 0.5.15 dropped FS.filesystems; the module itself has exported MEMFS since 0.5.10.
    const keepFs = (mod: { FS: unknown; MEMFS?: MemFS }) => {
      this.#FS = mod.FS as ModuleFS;
      this.#MEMFS = (mod.FS as { filesystems?: { MEMFS?: MemFS } }).filesystems?.MEMFS ?? mod.MEMFS ?? null;
      this.#mod = mod as ModuleMemory;
    };
    return { emscriptenOpts: { ...emscriptenOpts, preRun: [...(emscriptenOpts.preRun ?? []), keepFs] } };
  }


  #memfs(): MemFS {
    if (!this.#MEMFS) throw new Error('EncryptedFs: this PGlite build exposes no MEMFS');
    return this.#MEMFS;
  }

  override async initialSyncFs(): Promise<void> {
    const FS = this.#FS;
    if (!FS) throw new Error('EncryptedFs: initialSyncFs before init');
    try {
      this.#backend = await this.#open(FS);
      // Resumed into the origin store: that is now the backend.
      if (this.#slots.length === 1) this.#slots[0] = this.#backend;
    } catch (error) {
      if (FS.analyzePath(PGDATA).exists) clearDir(FS, PGDATA);
      throw error;
    }
    this.#ready = true;
  }

  // Also finishes or undoes a rotation a crash interrupted.
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
      // A root marked "rotating" is an interrupted rotation; anything else is for the load to report.
      const opened = this.#mode === 'create' ? null : await openRootOf(store, this.#key).catch(() => null);
      const mark = opened?.root.state === 'rotating' ? opened : null;
      const next = mark === null ? undefined : slots.length === 2 ? slots[slots.indexOf(store) ^ 1] : this.#openOrigin?.(mark.root.origin);
      if (mark === null || next === undefined) {
        await this.#load(FS, store);
        return store;
      }
      return this.#resume(FS, store, next, mark);
    }
    // A rotation from the store marked "rotating"; unmarked, a store with no root or header is an undone rotation's leftover.
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

  // Resumes a rotation from `from` (root `mark`) into `to`: a new store that loads wins and the old is deleted; else the
  // old is set back to ready and the new deleted. An open can't tell a crash from a live rotation, so the old root first
  // moves off the mark in a commit guarded by it (as step 8): one wins, the rest get StaleWriterError and delete nothing.
  async #resume(FS: ModuleFS, from: StorageBackend, to: StorageBackend, mark: OpenedRoot): Promise<StorageBackend> {
    const { ctx, root, sealed } = mark;
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
      // Stays "rotating" until deleted, so a crash in between finishes the rotation again.
      await move('rotating', root.origin);
      await drop(from);
      return to;
    }
    await move('ready', '');
    await drop(to);
    await this.#load(FS, from);
    return from;
  }

  async #create(FS: ModuleFS): Promise<void> {
    const blockSize = this.#createBlockSize;
    const { dek, meta, header } = await createHeader(this.#key, { blockSize, keyId: FIRST_KEY_ID });
    this.#ctx = { subkeys: new SubkeyCache(dek), meta, encryptions: 0 };
    this.#header = header;
    this.#map = new FileMap(blockSize);
    this.#tracker = installTracker(FS, this.#memfs(), PGDATA, blockSize);
  }

  // Slots, table and blocks are separate reads, so a writer committing mid-load looks like corruption; a moved root restarts the load.
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

  // The tracker is installed only once the load is complete.
  async #loadFrom(FS: ModuleFS, backend: StorageBackend, slots: Array<Uint8Array | undefined>): Promise<void> {
    const [copy0, copy1, sealedRoot] = slots;

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

    // Nothing is built before the table digest matches the root.
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

    // The next page is read while this one decrypts: at most two pages of ciphertext held.
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
        plain.fill(0);
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
    const tracker = installTracker(FS, this.#memfs(), PGDATA, blockSize);
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


  hasDirty(): boolean {
    return this.#unsettled !== null || this.#headerRepair || (this.#tracker?.hasDirty() ?? false);
  }

  /** Commits everything dirty; concurrent calls are serialised. With `relaxedDurability` a failure does not reject:
   * changes stay dirty for the next sync. */
  override syncToFs(relaxedDurability?: boolean): Promise<void> {
    if (!this.#ready) return Promise.reject(new Error('EncryptedFs: the store is not open'));
    this.#requested = true;
    if (relaxedDurability === false) this.#strict = true;
    this.#drain ??= this.#runAll();
    return relaxedDurability === true ? this.#drain.catch(() => undefined) : this.#drain;
  }

  // `#drain` is cleared in the step that leaves the loop, so a later call starts a new run; the loop awaits first so
  // `syncToFs` has assigned it.
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
      wipeSnapshot(snap);
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

  // Strict sync. With nothing to commit but a non-strict commit since the last strict one, re-puts the unchanged root strictly.
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

  // After an unknown-outcome commit the stored root decides: this plan's root = applied (true); the previous = not
  // written (false, snapshot owed again); anything else is another writer.
  #settled(prepared: Prepared, snap: Snapshot, stored: Bytes | undefined, durability: Durability): boolean {
    if (stored !== undefined && equalBytes(stored, prepared.root)) {
      this.#apply(prepared, snap, durability);
      return true;
    }
    const previous = this.#lastRoot;
    if (previous === null ? stored === undefined : stored !== undefined && equalBytes(stored, previous)) {
      (this.#tracker as Tracker).requeue(snap);
      wipeSnapshot(snap);
      return false;
    }
    const error = new StaleWriterError('another writer committed to this store');
    this.#stale(snap, error);
    throw error;
  }

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
    wipeSnapshot(snap);
  }

  #stale(snap: Snapshot, error: StaleWriterError): void {
    (this.#tracker as Tracker).requeue(snap);
    wipeSnapshot(snap);
    this.#setFatal(error);
  }

  #setFatal(error: Error): void {
    if (this.#fatal) return;
    this.#fatal = error;
    this.#onFatal?.(error);
  }


  // Runs a key operation on the open, idle store; syncs wait for it.
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

  // The other slot holds a store only if a rotation or open couldn't delete it (root "rotating", or none). Deleted once this
  // store's root reads back as the one we wrote; a moved root, or a ready root there, is another writer's: StaleWriterError.
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
   * Wraps the same data key under `newKek`, one commit for both header copies. The old KEK no longer opens the store
   * but still opens copies of the old header: after suspected exposure also call `rotateDataKey`. A rejected commit is
   * settled by reading the header back; if neither key opens it, KeyChangeUnknownError.
   */
  changeKey(newKek: CryptoKey): Promise<void> {
    return this.#exclusive(async () => {
      await this.#dropLeftover();
      const header = await rewrapHeader(this.#key, newKek, this.#header as Bytes);
      // Header goes with the first sync.
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

  verify(options: VerifyOptions = {}): Promise<VerifyResult> {
    return this.#exclusive(() => verifyStore(this.#backend, this.#key, options));
  }

  /**
   * Re-seals every record under a new data key in a fresh store (a pair's empty slot, or `backendFactory()`'s) that
   * replaces this one. The KEK stays: after suspected exposure call `changeKey` first. Syncs wait; a failure before the
   * switch leaves the old store intact.
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
      // 1. Flush; syncs held back from here to the end.
      await this.#syncOnce('strict');
      before = this.#lastRoot;

      // 2. Mark the old store, naming the new store inside its encrypted root.
      mark = await this.#sealRootAs(this.#gen + 1, 'rotating', name);
      await commitSettled(from, { expectRoot: before, puts: [[2, mark]], deletes: [], durability: 'strict' }, 2, mark);

      // 3. New store: new data key, both headers, every block under a fresh id. No root, so it reads as incomplete. The copy
      // is fuzzy; step 4 re-puts blocks changed meanwhile.
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
          const plain = blockOf(nodes.get(file.key), index, blockSize);
          let sealed: Bytes;
          try {
            sealed = await sealBlock(ctx, file.fileId, index, plain);
          } finally {
            plain.fill(0);
          }
          file.tags[index] = tagOf(sealed).slice();
          return [id, sealed];
        },
        [],
        (done) => onProgress?.({ phase: 'copy', done, total: copy.length }),
      );

      // 4. Catch up every change since step 1, then the file table, packed densely.
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

      // 5. Read back: both headers and every record open as the map says, nothing else.
      const body = await rootBody(new Draft(map), ctx, { gen: this.#gen + 2, state: 'ready', origin: this.#origin });
      const check = await checkBlocks(to, ctx, body, 2, (p) => {
        if (p.phase === 'blocks') onProgress?.({ phase: 'verify', done: p.done, total: p.total });
      });
      const copies = await Promise.all([to.get(0), to.get(1)]);
      if (!check.ok || !copies.every((c) => c !== undefined && equalBytes(c, created.header))) {
        throw new CorruptStoreError('the new store does not read back as it was written');
      }

      // 6. Switch: the new store's root. Until it is in, the old store is the store.
      const root = await sealRoot(ctx, encodeRoot(body, blockSize));
      // Step 8's old root, sealed while the old key and map are still current.
      const retired = await this.#sealRootAs(this.#gen + 2, 'rotating', name);
      await commitSettled(to, { expectRoot: null, puts: [[2, root]], deletes: [], durability: 'strict' }, 2, root);
      next = { ctx, map, header: created.header, root, snap, retired };
    } catch (error) {
      if (snap) {
        tracker.requeue(snap);
        wipeSnapshot(snap);
      }
      await this.#undoRotation(from, to, before, mark, single);
      if (error instanceof StaleWriterError) this.#setFatal(error);
      throw error;
    }

    // 7. Move the filesystem to the new store.
    this.#backend = to;
    if (single) this.#slots[0] = to;
    this.#ctx = next.ctx;
    this.#map = next.map;
    this.#header = next.header;
    this.#headerRepair = false;
    this.#lastRoot = next.root;
    this.#gen += 2;
    tracker.commit(next.snap);
    wipeSnapshot(next.snap);

    // 8. Retire, then delete the old store. The retiring commit keeps the old root "rotating" (a crash before deletion is
    // finished by the next open) and is guarded by the mark, so this rotation or an open that took it for interrupted
    // retires the old store, never both. On StaleWriterError the old store is untouched, the new is deleted if the other
    // instance kept the old, and this instance stops. Any other failure leaves the old marked for the next open, rotation
    // or key change to delete.
    try {
      const retired = next.retired;
      await commitSettled(from, { expectRoot: mark, puts: [[2, retired]], deletes: [], durability: 'strict' }, 2, retired);
      await deleteStore(from);
    } catch (error) {
      if (!(error instanceof StaleWriterError)) return;
      const kept = await openRootOf(from, this.#key).catch(() => null);
      if (kept !== null && kept.root.state !== 'rotating') {
        // Guarded by this rotation's root: nothing written into the slot since is deleted.
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

  // The current root sealed with another state or origin (mark, retire, undo).
  async #sealRootAs(gen: number, state: RootState, origin: string): Promise<Bytes> {
    const ctx = this.#ctx as RecordContext;
    const body = await rootBody(new Draft(this.#map as FileMap), ctx, { gen, state, origin });
    return sealRoot(ctx, encodeRoot(body, ctx.meta.blockSize));
  }

  // A rotation failed before the switch. The new store is deleted and the old set back to ready (commit guarded by the
  // mark) only while the old store still holds the mark; any other root is another writer's: nothing deleted, this
  // instance stops. If the undo fails the old stays marked for the next open and this instance stops syncing.
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


  /**
   * Commits what is dirty (strict), then drops the module's FS, tracker and file map before closing the backends, so a
   * host keeping the closed instance keeps no plaintext, even if a backend fails to close or the final sync rejects.
   * PGlite takes no second close.
   */
  override async closeFs(): Promise<void> {
    try {
      while (this.#hold) await this.#hold;
      await this.#drain?.catch(() => undefined);
      if (this.#ready && !this.#fatal && (this.hasDirty() || this.#owesStrict)) await this.syncToFs(false);
    } finally {
      if (this.#unsettled) wipeSnapshot(this.#unsettled.snap);
      this.#wipe();
      this.#ready = false;
      this.#FS = null;
      this.#MEMFS = null;
      this.#mod = null;
      this.#tracker = null;
      this.#map = null;
      this.#unsettled = null;
      await Promise.all(this.#slots.map((backend) => backend.close()));
      await super.closeFs();
      delete this.pg;
    }
  }

  // Zeroes every tracked MEMFS file and the wasm memory. Best effort: app copies, engine-internal copies and swap are
  // not covered; never replaces the close error.
  #wipe(): void {
    try {
      for (const { node } of this.#tracker?.files() ?? []) if (node.contents instanceof Uint8Array) node.contents.fill(0);
      const mod = this.#mod;
      if (mod) (mod.HEAPU8 ?? (mod.wasmMemory && new Uint8Array(mod.wasmMemory.buffer)))?.fill(0);
    } catch {
      // best effort
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
