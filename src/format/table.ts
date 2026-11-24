// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Pure functions over file-table entries (FORMAT.md section 7): joining them into files, and
// packing a whole table densely into table blocks.
import { toHex, type Bytes } from './bytes.ts';
import {
  maxTableBlocks,
  utf8Length,
  type BlockSize,
  type FileEntry,
  type FileType,
  type RootBody,
  type RunEntry,
  type TableEntry,
} from './codec.ts';
import { CorruptStoreError, StoreFullError } from './errors.ts';

export { maxTableBlocks };

const COUNT_LENGTH = 2;
const FILE_ENTRY_FIXED = 34;
const RUN_ENTRY_FIXED = 23;

/** `floor((blockSize − 25) / 16)`: the ids one run can hold, the most that fit in one table block. */
export const maxRunIds = (blockSize: BlockSize): number =>
  Math.floor((blockSize - COUNT_LENGTH - RUN_ENTRY_FIXED) / 16);

export const entrySize = (entry: TableEntry): number =>
  entry.kind === 'file'
    ? FILE_ENTRY_FIXED + utf8Length(entry.path) + utf8Length(entry.target)
    : RUN_ENTRY_FIXED + 16 * entry.ids.length;

export interface StoredFile {
  fileId: Bytes;
  path: string;
  type: FileType;
  mode: number;
  size: number;
  target: string;
  ids: Bytes[];
}

export interface BlockPlace {
  fileId: Bytes;
  index: number;
}

export interface FileTable {
  /** Keyed by the file id in hex. */
  files: Map<string, StoredFile>;
  /** Data-block id in hex → the file and index stored under it. */
  blocks: Map<string, BlockPlace>;
}

const corrupt = (reason: string) => new CorruptStoreError(`file table: ${reason}`);

export const blockCount = (type: FileType, size: number, blockSize: BlockSize): number =>
  type === 'file' ? Math.ceil(size / blockSize) : 0;

/** Joins entries into files and checks them against the root: runs cover each file's blocks exactly once, no id repeats,
 * no two files share a path, counts match. */
export const assembleFiles = (
  entries: Iterable<TableEntry>,
  root: Pick<RootBody, 'fileCount' | 'dataBlocks' | 'tableIds'>,
  blockSize: BlockSize,
): FileTable => {
  const files = new Map<string, StoredFile>();
  const runs = new Map<string, RunEntry[]>();
  const paths = new Set<string>();
  for (const e of entries) {
    const key = toHex(e.fileId);
    if (e.kind === 'file') {
      if (files.has(key)) throw corrupt('two file entries for one file');
      if (paths.has(e.path)) throw corrupt('two files with one path');
      paths.add(e.path);
      const { fileId, path, type, mode, size, target } = e;
      files.set(key, { fileId, path, type, mode, size, target, ids: [] });
    } else {
      const list = runs.get(key);
      if (list) list.push(e);
      else runs.set(key, [e]);
    }
  }
  if (files.size !== root.fileCount) throw corrupt('the number of files differs from the root');
  for (const key of runs.keys()) if (!files.has(key)) throw corrupt('a run without a file entry');

  const seen = new Set<string>();
  const claim = (id: Uint8Array): string => {
    const hex = toHex(id);
    if (seen.has(hex)) throw corrupt(`block ${hex} is listed twice`);
    seen.add(hex);
    return hex;
  };
  for (const id of root.tableIds) claim(id);

  const blocks = new Map<string, BlockPlace>();
  for (const [key, file] of files) {
    const expected = blockCount(file.type, file.size, blockSize);
    const list = (runs.get(key) ?? []).sort((a, b) => a.first - b.first);
    for (const run of list) {
      if (run.first < file.ids.length) throw corrupt('two runs overlap');
      if (run.first > file.ids.length) throw corrupt('a gap between runs');
      if (run.first + run.ids.length > expected) throw corrupt('a run past the end of its file');
      for (const id of run.ids) {
        blocks.set(claim(id), { fileId: file.fileId, index: file.ids.length });
        file.ids.push(id);
      }
    }
    if (file.ids.length !== expected) throw corrupt('a file is missing blocks at its end');
  }
  if (blocks.size !== root.dataBlocks) throw corrupt('the number of data blocks differs from the root');
  return { files, blocks };
};

/** Packs the table densely into table blocks in the order given, splitting a run where a block fills. StoreFullError past
 * `maxTableBlocks` or for an entry larger than a table block. */
export const packEntries = (files: Iterable<StoredFile>, blockSize: BlockSize): TableEntry[][] => {
  const room = blockSize - COUNT_LENGTH;
  const limit = maxTableBlocks(blockSize);
  const blocks: TableEntry[][] = [];
  let current: TableEntry[] = [];
  let free = room;
  const next = () => {
    blocks.push(current);
    if (blocks.length >= limit) throw new StoreFullError(`the file table needs more than ${String(limit)} blocks`);
    current = [];
    free = room;
  };
  for (const f of files) {
    const entry: FileEntry = { kind: 'file', fileId: f.fileId, type: f.type, mode: f.mode, size: f.size, path: f.path, target: f.target };
    const size = entrySize(entry);
    if (size > room) throw new StoreFullError('a path or symlink target does not fit in one table block');
    if (size > free) next();
    current.push(entry);
    free -= size;
    for (let first = 0; first < f.ids.length; ) {
      if (free < RUN_ENTRY_FIXED + 16) next();
      const n = Math.min(f.ids.length - first, Math.floor((free - RUN_ENTRY_FIXED) / 16));
      current.push({ kind: 'run', fileId: f.fileId, first, ids: f.ids.slice(first, first + n) });
      free -= RUN_ENTRY_FIXED + 16 * n;
      first += n;
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
};
