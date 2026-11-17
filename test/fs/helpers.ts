// Shared by the filesystem tests: PGlite on an EncryptedFs, backend record copies, and a reader of a store's file table using the format functions alone.
import { MemoryFS, PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { expect } from 'vitest';
import type { RecordKey, StorageBackend } from '../../src/backend/backend.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { EncryptedFs, type EncryptedFsOptions, type OpenMode } from '../../src/encryptedFs.ts';
import { ascii, concat, toHex, type Bytes } from '../../src/format/bytes.ts';
import { decodeRoot, decodeTable, encodeMeta, encodeRoot, type BlockSize, type RootBody, type TableEntry } from '../../src/format/codec.ts';
import { importKek, openHeader, SubkeyCache } from '../../src/format/keys.ts';
import { computeManifest, computeTableDigest } from '../../src/format/manifest.ts';
import { openBlock, openRoot, openTable, sealRoot, tagOf, type RecordContext } from '../../src/format/records.ts';
import { assembleFiles, type FileTable } from '../../src/format/table.ts';

export const inBrowser = 'document' in globalThis;
export const PGDATA = '/pglite/data';
export const BLOCK_SIZES: readonly BlockSize[] = [8192, 32768, 65536];

export const fromHex = (s: string): Bytes => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

export const newKey = async (): Promise<CryptoKey> => importKek(crypto.getRandomValues(new Uint8Array(32)));

export interface TestFS {
  analyzePath(path: string): { exists: boolean };
  readdir(path: string): string[];
  lstat(path: string): { mode: number; size: number };
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  readlink(path: string): string;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  mkdir(path: string, mode?: number): void;
  mkdirTree(path: string): void;
  symlink(target: string, path: string): void;
  truncate(path: string, length: number): void;
  chmod(path: string, mode: number): void;
  isDir(mode: number): boolean;
  isLink(mode: number): boolean;
  open(path: string, flags: number): { fd: number };
  write(stream: { fd: number }, buf: Uint8Array, offset: number, length: number, position?: number): number;
  close(stream: { fd: number }): void;
}

export const fsOf = (pg: PGlite): TestFS => (pg.Module as unknown as { FS: TestFS }).FS;

let templatePromise: Promise<File | Blob> | null = null;

/** A fresh data directory tarball, made once per test file with MemoryFS; loading it skips initdb. */
export const template = (): Promise<File | Blob> =>
  (templatePromise ??= (async () => {
    const pg = await PGlite.create({ fs: new MemoryFS() });
    const tar = await pg.dumpDataDir('none');
    await pg.close();
    return tar;
  })());

export interface Opened {
  pg: PGlite;
  fs: EncryptedFs;
}

export interface OpenOptions extends Partial<EncryptedFsOptions> {
  backend: StorageBackend;
  key: CryptoKey;
  mode?: OpenMode;
  initdb?: boolean;
  pglite?: Partial<PGliteOptions>;
}

export async function openStore(options: OpenOptions): Promise<Opened> {
  const { initdb = false, pglite = {}, mode = 'open-or-create', ...rest } = options;
  const fs = new EncryptedFs({ mode, ...rest });
  const isNew = await options.backend.isEmpty();
  const loadDataDir = isNew && !initdb && mode !== 'open' ? await template() : undefined;
  const pg = await PGlite.create({ fs, ...(loadDataDir ? { loadDataDir } : {}), ...pglite });
  return { pg, fs };
}

export async function records(backend: StorageBackend): Promise<Map<RecordKey, Uint8Array>> {
  const out = new Map<RecordKey, Uint8Array>();
  for (const slot of [0, 1, 2] as const) {
    const v = await backend.get(slot);
    if (v !== undefined) out.set(slot, v.slice());
  }
  for (let after: string | null = null; ; ) {
    const page = await backend.readRange(after, 1000);
    for (const [id, v] of page) out.set(id, v.slice());
    if (page.length < 1000) break;
    after = (page[page.length - 1] as [string, Uint8Array])[0];
  }
  return out;
}

export async function restore(recs: Map<RecordKey, Uint8Array>): Promise<MemoryBackend> {
  const backend = new MemoryBackend();
  await backend.commit({ puts: [...recs].map(([k, v]) => [k, v.slice()]), deletes: [], durability: 'relaxed' });
  return backend;
}

export const sameRecords = (a: Map<RecordKey, Uint8Array>, b: Map<RecordKey, Uint8Array>): boolean =>
  a.size === b.size && [...a].every(([k, v]) => {
    const w = b.get(k);
    return w !== undefined && w.length === v.length && w.every((x, i) => x === v[i]);
  });

export interface Inspected {
  ctx: RecordContext;
  root: RootBody;
  table: FileTable;
  blocks: Array<{ id: string; entries: TableEntry[] }>;
}

export async function inspect(backend: StorageBackend, key: CryptoKey): Promise<Inspected> {
  const h0 = (await backend.get(0)) as Bytes | undefined;
  const h1 = (await backend.get(1)) as Bytes | undefined;
  const { dek, meta } = await openHeader(key, h0, h1);
  const ctx: RecordContext = { subkeys: new SubkeyCache(dek), meta, encryptions: 0 };
  const root = decodeRoot(await openRoot(ctx, (await backend.get(2)) as Bytes));
  const ids = root.tableIds.map(toHex);
  const values = await backend.getMany(ids);
  const blocks = await Promise.all(
    ids.map(async (id, i) => ({ id, entries: decodeTable(await openTable(ctx, fromHex(id), values[i] as Bytes)) })),
  );
  const table = assembleFiles(
    blocks.flatMap((b) => b.entries),
    root,
    meta.blockSize,
  );
  return { ctx, root, table, blocks };
}

export function idsOf(inspected: Inspected, path: string): string[] {
  for (const f of inspected.table.files.values()) if (f.path === path) return f.ids.map(toHex);
  throw new Error(`no file ${path} in the store`);
}

export function listTree(fs: TestFS, root = PGDATA): Map<string, { mode: number; size: number }> {
  const out = new Map<string, { mode: number; size: number }>();
  const visit = (dir: string, prefix: string) => {
    for (const name of fs.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const stat = fs.lstat(`${dir}/${name}`);
      out.set(prefix + name, { mode: stat.mode, size: stat.size });
      if (fs.isDir(stat.mode)) visit(`${dir}/${name}`, `${prefix}${name}/`);
    }
  };
  visit(root, '');
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Checks, without the filesystem's loader, that the store is exactly what MEMFS holds: records, digests, and every file's type, mode, size and bytes. */
export async function expectStoreEquals(backend: StorageBackend, key: CryptoKey, fs: TestFS): Promise<void> {
  const ins = await inspect(backend, key);
  const { ctx, root, table } = ins;
  const B = ctx.meta.blockSize;
  expect(await backend.count()).toBe(3 + root.tableIds.length + root.dataBlocks);
  const tableValues = await backend.getMany(root.tableIds.map(toHex));
  expect(await computeTableDigest(tableValues.map((v) => tagOf(v as Bytes)))).toEqual(root.tableDigest);
  const tree = listTree(fs);
  expect([...table.files.values()].map((f) => f.path).sort()).toEqual([...tree.keys()].sort());
  const manifest: Array<{ fileId: Uint8Array; blockTags: Uint8Array }> = [];
  for (const f of table.files.values()) {
    const stat = tree.get(f.path) as { mode: number; size: number };
    expect(f.mode, f.path).toBe(stat.mode);
    if (f.type === 'symlink') expect(f.target).toBe(fs.readlink(`${PGDATA}/${f.path}`));
    if (f.type !== 'file') continue;
    expect(f.size, f.path).toBe(stat.size);
    const want = fs.readFile(`${PGDATA}/${f.path}`);
    const values = await backend.getMany(f.ids.map(toHex));
    const tags = new Uint8Array(16 * values.length);
    for (const [i, value] of values.entries()) {
      const plain = await openBlock(ctx, f.ids[i] as Bytes, f.fileId, i, value as Bytes);
      const end = Math.min(B, f.size - i * B);
      if (!sameBytes(plain.subarray(0, end), want.subarray(i * B, i * B + end))) throw new Error(`block ${String(i)} of ${f.path} differs`);
      tags.set(tagOf(value as Bytes), 16 * i);
    }
    manifest.push({ fileId: f.fileId, blockTags: tags });
  }
  expect(await computeManifest(manifest)).toEqual(root.manifest);
}

export async function rejection(promise: Promise<unknown>, type: abstract new (...args: never[]) => Error): Promise<Error> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  return error as Error;
}

/** Wraps a backend shared by several instances: closing one instance leaves it open. */
export const shared = (backend: StorageBackend): StorageBackend =>
  new Proxy(backend, {
    get(target, prop, receiver) {
      if (prop === 'close') return () => Promise.resolve();
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

/** An EncryptedFs that records every path created under PGDATA, and keeps the module's FS. */
export class WatchedFs extends EncryptedFs {
  readonly created: string[] = [];
  moduleFs: TestFS | null = null;

  override async init(pg: PGlite, options: Parameters<EncryptedFs['init']>[1]) {
    const { emscriptenOpts } = await super.init(pg, options);
    const watch = (mod: { FS: unknown }) => {
      const FS = mod.FS as TestFS & Record<'mknod' | 'symlink', (...args: unknown[]) => unknown>;
      this.moduleFs = FS;
      for (const name of ['mknod', 'symlink'] as const) {
        const original = FS[name].bind(FS);
        FS[name] = (...args: unknown[]) => {
          const path = String(name === 'mknod' ? args[0] : args[1]);
          if (path.startsWith(`${PGDATA}/`)) this.created.push(path);
          return original(...args);
        };
      }
    };
    return { emscriptenOpts: { ...emscriptenOpts, preRun: [...(emscriptenOpts.preRun ?? []), watch] } };
  }
}

export async function resealRoot(backend: StorageBackend, key: CryptoKey, change: (root: RootBody) => RootBody): Promise<void> {
  const { ctx, root } = await inspect(backend, key);
  const sealed = await sealRoot(ctx, encodeRoot(change(root), ctx.meta.blockSize));
  await backend.commit({ puts: [[2, sealed]], deletes: [], durability: 'relaxed' });
}

/** A header that opens under `key` and whose meta says format version `v`: what a later writer stores. */
export async function headerWithVersion(backend: StorageBackend, key: CryptoKey, v: number): Promise<Bytes> {
  const header = (await backend.get(0)) as Bytes;
  const { dek, meta } = await openHeader(key, header, header);
  const plain = encodeMeta(meta);
  new DataView(plain.buffer).setUint16(0, v);
  const label = ascii('pglite-cipher/header');
  const { subtle } = globalThis.crypto;
  const headerKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: header.subarray(60, 76), info: label },
    dek,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const sealed = await subtle.encrypt(
    { name: 'AES-GCM', iv: header.subarray(76, 88), additionalData: concat([label, header.subarray(0, 60)]) },
    headerKey,
    plain,
  );
  return concat([header.subarray(0, 88), new Uint8Array(sealed)]);
}
