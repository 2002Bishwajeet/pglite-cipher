// Fixed binary encodings of the header meta, the root body and table-block bodies (FORMAT.md
// sections 4, 6 and 7). Decoders throw only CorruptStoreError or UnsupportedFormatError; encoders
// throw RangeError for a value that does not fit its field.
import type { Bytes } from './bytes.ts';
import { CorruptStoreError, UnsupportedFormatError } from './errors.ts';

export const BLOCK_SIZES = [8192, 32768, 65536] as const;
export type BlockSize = (typeof BLOCK_SIZES)[number];
/** The owner's choice from the spike (#3). */
export const DEFAULT_BLOCK_SIZE: BlockSize = 65536;

export const META_LENGTH = 64;
export const FORMAT_V1 = 1;
const CIPHER_AES_256_GCM = 1;
const KDF_RAW = 0;
const SUBKEY_HKDF_SESSION = 1;

/** Root bytes before the table-block ids. */
export const ROOT_FIXED_LENGTH = 96;
export const MAX_ORIGIN_BYTES = 255;

export const isBlockSize = (n: number): n is BlockSize => (BLOCK_SIZES as readonly number[]).includes(n);

const TWO_32 = 2 ** 32;
const utf8 = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF in a path instead of dropping it.
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const utf8Length = (text: string): number => utf8.encode(text).length;

class Writer {
  readonly bytes: Bytes;
  private readonly view: DataView;
  at = 0;

  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }

  private check(n: number, max: number, field: string): void {
    if (!Number.isInteger(n) || n < 0 || n > max) throw new RangeError(`${field} does not fit its field`);
  }

  u8(n: number, field: string): void {
    this.check(n, 0xff, field);
    this.view.setUint8(this.at, n);
    this.at += 1;
  }

  u16(n: number, field: string): void {
    this.check(n, 0xffff, field);
    this.view.setUint16(this.at, n);
    this.at += 2;
  }

  u32(n: number, field: string): void {
    this.check(n, 0xffffffff, field);
    this.view.setUint32(this.at, n);
    this.at += 4;
  }

  u64(n: number, field: string): void {
    this.check(n, Number.MAX_SAFE_INTEGER, field);
    this.view.setUint32(this.at, Math.floor(n / TWO_32));
    this.view.setUint32(this.at + 4, n % TWO_32);
    this.at += 8;
  }

  raw(b: Uint8Array, length: number, field: string): void {
    if (b.length !== length) throw new RangeError(`${field} must be ${String(length)} bytes`);
    this.bytes.set(b, this.at);
    this.at += length;
  }

  /** A u16 length, then the UTF-8 bytes. */
  text(s: string, field: string): void {
    const b = utf8.encode(s);
    this.u16(b.length, field);
    this.raw(b, b.length, field);
  }
}

class Reader {
  private readonly bytes: Uint8Array;
  private readonly what: string;
  private readonly view: DataView;
  at = 0;

  constructor(bytes: Uint8Array, what: string) {
    this.bytes = bytes;
    this.what = what;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  corrupt(reason: string): CorruptStoreError {
    return new CorruptStoreError(`${this.what}: ${reason}`);
  }

  private need(n: number): void {
    if (this.at + n > this.bytes.length) throw this.corrupt('a field runs past the end');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.at++);
  }

  u16(): number {
    this.need(2);
    const n = this.view.getUint16(this.at);
    this.at += 2;
    return n;
  }

  u32(): number {
    this.need(4);
    const n = this.view.getUint32(this.at);
    this.at += 4;
    return n;
  }

  u64(): number {
    this.need(8);
    const hi = this.view.getUint32(this.at);
    const lo = this.view.getUint32(this.at + 4);
    this.at += 8;
    if (hi >= 2 ** 21) throw this.corrupt('a u64 field is 2^53 or more');
    return hi * TWO_32 + lo;
  }

  take(n: number): Bytes {
    this.need(n);
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }

  utf8(n: number): string {
    this.need(n);
    let text: string;
    try {
      text = utf8Strict.decode(this.bytes.subarray(this.at, this.at + n));
    } catch {
      throw this.corrupt('text is not valid UTF-8');
    }
    this.at += n;
    return text;
  }

  zeros(from: number, to: number): void {
    for (let i = from; i < to; i++) if (this.bytes[i] !== 0) throw this.corrupt('a byte that must be zero is not');
  }

  zerosToEnd(): void {
    this.zeros(this.at, this.bytes.length);
  }
}

const blockBody = (body: Uint8Array, what: string): Reader => {
  const r = new Reader(body, what);
  if (!isBlockSize(body.length)) throw r.corrupt('the body is not one block long');
  return r;
};

// ---- header meta ---------------------------------------------------------------------------

export interface Meta {
  blockSize: BlockSize;
  keyId: number;
  storeId: Bytes;
}

export const encodeMeta = (meta: Meta): Bytes => {
  const w = new Writer(META_LENGTH);
  w.u16(FORMAT_V1, 'v');
  w.u8(CIPHER_AES_256_GCM, 'cipher');
  w.u8(KDF_RAW, 'kdf');
  w.u8(SUBKEY_HKDF_SESSION, 'subkey');
  w.at = 8;
  if (!isBlockSize(meta.blockSize)) throw new RangeError('blockSize must be 8192, 32768 or 65536');
  w.u32(meta.blockSize, 'blockSize');
  w.u32(meta.keyId, 'keyId');
  w.raw(meta.storeId, 16, 'storeId');
  return w.bytes;
};

export const decodeMeta = (bytes: Uint8Array): Meta => {
  const r = new Reader(bytes, 'header meta');
  if (bytes.length !== META_LENGTH) throw r.corrupt('wrong length');
  const v = r.u16();
  if (v !== FORMAT_V1) throw new UnsupportedFormatError(`format version ${String(v)} is not supported`);
  const cipher = r.u8();
  const kdf = r.u8();
  const subkey = r.u8();
  if (cipher !== CIPHER_AES_256_GCM || kdf !== KDF_RAW || subkey !== SUBKEY_HKDF_SESSION) {
    throw new UnsupportedFormatError(
      `cipher ${String(cipher)}, kdf ${String(kdf)}, subkey ${String(subkey)} are not supported`,
    );
  }
  r.zeros(5, 8);
  r.at = 8;
  const blockSize = r.u32();
  if (!isBlockSize(blockSize)) throw r.corrupt('unknown block size');
  const keyId = r.u32();
  const storeId = r.take(16);
  r.zerosToEnd();
  return { blockSize, keyId, storeId };
};

// ---- root body -----------------------------------------------------------------------------

export type RootState = 'ready' | 'populating' | 'rotating';
const STATES: readonly RootState[] = ['ready', 'populating', 'rotating'];

export interface RootBody {
  gen: number;
  /** Attempted record encryptions under the current DEK. Telemetry. */
  encryptions: number;
  state: RootState;
  /** At most 255 UTF-8 bytes. */
  origin: string;
  /** File-table entries of kind "file" (regular files, directories and symlinks). */
  fileCount: number;
  /** Data-block ids in the file table. */
  dataBlocks: number;
  tableDigest: Bytes;
  manifest: Bytes;
  /** The file-table block ids, in list order. */
  tableIds: Bytes[];
}

/** `floor((blockSize − 96 − 255) / 16)`: the table-block ids a root can hold (FORMAT.md section 9). */
export const maxTableBlocks = (blockSize: BlockSize): number =>
  Math.floor((blockSize - ROOT_FIXED_LENGTH - MAX_ORIGIN_BYTES) / 16);

export const encodeRoot = (root: RootBody, blockSize: BlockSize): Bytes => {
  if (root.tableIds.length > maxTableBlocks(blockSize)) throw new RangeError('too many table blocks for one root');
  const w = new Writer(blockSize);
  w.u64(root.gen, 'gen');
  w.u64(root.encryptions, 'encryptions');
  w.u8(STATES.indexOf(root.state) + 1, 'state');
  w.at = 18;
  const origin = utf8.encode(root.origin);
  if (origin.length > MAX_ORIGIN_BYTES) throw new RangeError('origin is longer than 255 bytes');
  w.u16(origin.length, 'origin');
  w.u32(root.fileCount, 'fileCount');
  w.u32(root.dataBlocks, 'dataBlocks');
  w.raw(root.tableDigest, 32, 'tableDigest');
  w.raw(root.manifest, 32, 'manifest');
  w.u32(root.tableIds.length, 'tableCount');
  for (const id of root.tableIds) w.raw(id, 16, 'table block id');
  w.raw(origin, origin.length, 'origin');
  return w.bytes;
};

export const decodeRoot = (body: Uint8Array): RootBody => {
  const r = blockBody(body, 'root');
  const gen = r.u64();
  const encryptions = r.u64();
  const state = STATES[r.u8() - 1];
  if (state === undefined) throw r.corrupt('unknown state');
  r.zeros(17, 18);
  r.at = 18;
  const originLen = r.u16();
  if (originLen > MAX_ORIGIN_BYTES) throw r.corrupt('origin is too long');
  const fileCount = r.u32();
  const dataBlocks = r.u32();
  const tableDigest = r.take(32);
  const manifest = r.take(32);
  const tableCount = r.u32();
  if (tableCount > maxTableBlocks(body.length as BlockSize)) throw r.corrupt('too many table blocks');
  const tableIds: Bytes[] = [];
  for (let i = 0; i < tableCount; i++) tableIds.push(r.take(16));
  const origin = r.utf8(originLen);
  r.zerosToEnd();
  return { gen, encryptions, state, origin, fileCount, dataBlocks, tableDigest, manifest, tableIds };
};

// ---- table-block body ----------------------------------------------------------------------

export type FileType = 'file' | 'directory' | 'symlink';
const TYPES: readonly FileType[] = ['file', 'directory', 'symlink'];

const KIND_FILE = 0x01;
const KIND_RUN = 0x02;

/** The inode of a regular file, a directory or a symlink. */
export interface FileEntry {
  kind: 'file';
  fileId: Bytes;
  type: FileType;
  mode: number;
  /** Bytes; the true size (blocks are padded). */
  size: number;
  path: string;
  /** A symlink's target; empty for other types. */
  target: string;
}

/** Blocks `first … first + ids.length − 1` of a file live under `ids`. */
export interface RunEntry {
  kind: 'run';
  fileId: Bytes;
  first: number;
  ids: Bytes[];
}

export type TableEntry = FileEntry | RunEntry;

/** `count (u16) ‖ entries ‖ zeros`, `blockSize` bytes. RangeError when the entries do not fit. */
export const encodeTable = (entries: readonly TableEntry[], blockSize: BlockSize): Bytes => {
  const w = new Writer(blockSize);
  w.u16(entries.length, 'entry count');
  for (const e of entries) {
    if (e.kind === 'file') {
      w.u8(KIND_FILE, 'kind');
      w.raw(e.fileId, 16, 'fileId');
      w.u8(TYPES.indexOf(e.type) + 1, 'type');
      w.u32(e.mode, 'mode');
      w.u64(e.size, 'size');
      w.text(e.path, 'path');
      w.text(e.target, 'target');
    } else {
      w.u8(KIND_RUN, 'kind');
      w.raw(e.fileId, 16, 'fileId');
      w.u32(e.first, 'first');
      if (e.ids.length === 0) throw new RangeError('a run needs at least one id');
      w.u16(e.ids.length, 'run length');
      for (const id of e.ids) w.raw(id, 16, 'block id');
    }
  }
  return w.bytes;
};

export const decodeTable = (body: Uint8Array): TableEntry[] => {
  const r = blockBody(body, 'table block');
  const count = r.u16();
  const entries: TableEntry[] = [];
  for (let i = 0; i < count; i++) {
    const kind = r.u8();
    const fileId = r.take(16);
    if (kind === KIND_FILE) {
      const type = TYPES[r.u8() - 1];
      if (type === undefined) throw r.corrupt('unknown file type');
      const mode = r.u32();
      const size = r.u64();
      const path = r.utf8(r.u16());
      const target = r.utf8(r.u16());
      entries.push({ kind: 'file', fileId, type, mode, size, path, target });
    } else if (kind === KIND_RUN) {
      const first = r.u32();
      const n = r.u16();
      if (n === 0) throw r.corrupt('an empty run');
      const ids: Bytes[] = [];
      for (let j = 0; j < n; j++) ids.push(r.take(16));
      entries.push({ kind: 'run', fileId, first, ids });
    } else {
      throw r.corrupt('unknown entry kind');
    }
  }
  r.zerosToEnd();
  return entries;
};
