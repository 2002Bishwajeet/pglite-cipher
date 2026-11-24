// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// File table: pack, encode, decode and assemble round-trip; every defect is CorruptStoreError, the limit StoreFullError.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { u32, type Bytes } from '../../src/format/bytes.ts';
import {
  BLOCK_SIZES,
  decodeTable,
  encodeTable,
  type BlockSize,
  type FileEntry,
  type FileType,
  type TableEntry,
} from '../../src/format/codec.ts';
import { CorruptStoreError, StoreFullError } from '../../src/format/errors.ts';
import {
  assembleFiles,
  blockCount,
  entrySize,
  maxRunIds,
  maxTableBlocks,
  packEntries,
  type FileTable,
  type StoredFile,
} from '../../src/format/table.ts';
import { hex, seeded } from './helpers.ts';
import { runs, timeout } from '../long.ts';

const idOf = (tag: number, n: number, seed: number): Bytes => {
  const out = seeded(seed ^ n, 16);
  out[0] = tag;
  out.set(u32(n), 1);
  return out;
};

const fileSpec = fc.record({
  type: fc.constantFrom<FileType>('file', 'file', 'file', 'directory', 'symlink'),
  mode: fc.nat({ max: 0o177777 }),
  blocks: fc.oneof(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 3000 })),
  tail: fc.nat(),
  path: fc.string({ unit: 'binary', maxLength: 50 }),
  target: fc.string({ unit: 'binary', minLength: 1, maxLength: 50 }),
});

const filesArb = fc
  .record({
    blockSize: fc.constantFrom(...BLOCK_SIZES),
    seed: fc.integer(),
    specs: fc.uniqueArray(fileSpec, { maxLength: 12, selector: (s) => s.path }),
  })
  .map(({ blockSize, seed, specs }) => {
    let n = 0;
    const utf8 = new TextEncoder();
    const files: StoredFile[] = specs
      .filter((s) => utf8.encode(s.path).length <= 200)
      .map((s, i) => {
        const regular = s.type === 'file';
        const blocks = regular ? s.blocks : 0;
        const size = blocks === 0 ? 0 : (blocks - 1) * blockSize + 1 + (s.tail % blockSize);
        return {
          fileId: idOf(0xf0, i, seed),
          path: s.path,
          type: s.type,
          mode: s.mode,
          size,
          target: s.type === 'symlink' ? s.target : '',
          ids: Array.from({ length: blocks }, () => idOf(0xb0, n++, seed)),
        };
      });
    return { blockSize, files };
  });

const rootFor = (files: StoredFile[], tableIds: Bytes[]) => ({
  fileCount: files.length,
  dataBlocks: files.reduce((n, f) => n + f.ids.length, 0),
  tableIds,
});

const tableIdsFor = (count: number) => Array.from({ length: count }, (_, i) => idOf(0x7a, i, 1));

const roundTrip = (groups: TableEntry[][], files: StoredFile[], blockSize: BlockSize): FileTable => {
  const entries = groups.flatMap((g) => decodeTable(encodeTable(g, blockSize)));
  return assembleFiles(entries, rootFor(files, tableIdsFor(groups.length)), blockSize);
};

const asComparable = (table: FileTable) =>
  [...table.files.values()]
    .map((f) => ({ ...f, fileId: hex(f.fileId), ids: f.ids.map(hex) }))
    .sort((a, b) => (a.fileId < b.fileId ? -1 : 1));

const expectSameFiles = (table: FileTable, files: StoredFile[]) => {
  expect(asComparable(table)).toEqual(
    asComparable({ files: new Map(files.map((f) => [hex(f.fileId), f])), blocks: new Map() }),
  );
  for (const f of files) {
    f.ids.forEach((id, index) => {
      expect(table.blocks.get(hex(id))).toEqual({ fileId: f.fileId, index });
    });
  }
};

describe('file table', () => {
  it('has the documented limits', () => {
    expect(BLOCK_SIZES.map(maxTableBlocks)).toEqual([490, 2026, 4074]);
    expect(BLOCK_SIZES.map(maxRunIds)).toEqual([510, 2046, 4094]);
    expect(entrySize({ kind: 'file', fileId: idOf(1, 1, 1), type: 'symlink', mode: 0, size: 0, path: 'é/a', target: 'xy' })).toBe(
      34 + 4 + 2,
    );
    expect(entrySize({ kind: 'run', fileId: idOf(1, 1, 1), first: 0, ids: [idOf(2, 1, 1), idOf(2, 2, 1)] })).toBe(23 + 32);
  });

  it('round-trips random files through packEntries → encode → decode → assembleFiles', () => {
    fc.assert(
      fc.property(filesArb, ({ blockSize, files }) => {
        const groups = packEntries(files, blockSize);
        for (const g of groups) expect(g.reduce((n, e) => n + entrySize(e), 2)).toBeLessThanOrEqual(blockSize);
        expectSameFiles(roundTrip(groups, files, blockSize), files);
      }),
      { numRuns: runs(100) },
    );
  }, timeout(120_000));

  it('splits a file with more ids than one table block holds into runs, and joins them again', () => {
    const blockSize = 8192;
    const ids = Array.from({ length: 1200 }, (_, i) => idOf(0xb0, i, 2));
    const file: StoredFile = { fileId: idOf(0xf0, 0, 2), path: 'base/1/16384', type: 'file', mode: 0o100600, size: 1200 * blockSize, target: '', ids };
    const groups = packEntries([file], blockSize);
    const runs = groups.flat().filter((e) => e.kind === 'run');
    expect(groups.length).toBe(3);
    expect(runs.length).toBe(3);
    for (const r of runs) expect(r.ids.length).toBeLessThanOrEqual(maxRunIds(blockSize));
    expectSameFiles(roundTrip(groups, [file], blockSize), [file]);
  });

  it('assembles entries shuffled across table blocks to the same files', () => {
    fc.assert(
      fc.property(filesArb, fc.integer(), ({ blockSize, files }, seed) => {
        const entries = packEntries(files, blockSize).flat();
        const r = seeded(seed, entries.length * 4);
        for (let i = entries.length - 1; i > 0; i--) {
          const j = (((r[i * 4] ?? 0) << 8) | (r[i * 4 + 1] ?? 0)) % (i + 1);
          [entries[i], entries[j]] = [entries[j] as TableEntry, entries[i] as TableEntry];
        }
        const groups: TableEntry[][] = [];
        let free = 0;
        for (const e of entries) {
          const size = entrySize(e);
          if (size > free) {
            groups.push([]);
            free = blockSize - 2;
          }
          groups[groups.length - 1]?.push(e);
          free -= size;
        }
        fc.pre(groups.length <= maxTableBlocks(blockSize));
        expectSameFiles(roundTrip(groups, files, blockSize), files);
      }),
      { numRuns: runs(100) },
    );
  }, timeout(120_000));

  describe('assembleFiles rejects', () => {
    const blockSize = 8192;
    const a: StoredFile = {
      fileId: idOf(0xf0, 1, 3),
      path: 'base/1/1259',
      type: 'file',
      mode: 0o100600,
      size: 3 * blockSize,
      target: '',
      ids: [idOf(0xb0, 1, 3), idOf(0xb0, 2, 3), idOf(0xb0, 3, 3)],
    };
    const d: StoredFile = { fileId: idOf(0xf0, 2, 3), path: 'base/1', type: 'directory', mode: 0o40700, size: 0, target: '', ids: [] };
    const fileEntry = (f: StoredFile): FileEntry => ({
      kind: 'file',
      fileId: f.fileId,
      type: f.type,
      mode: f.mode,
      size: f.size,
      path: f.path,
      target: f.target,
    });
    const runOf = (f: StoredFile, first: number, n: number): TableEntry => ({
      kind: 'run',
      fileId: f.fileId,
      first,
      ids: f.ids.slice(first, first + n),
    });
    const valid = (): TableEntry[] => [fileEntry(a), fileEntry(d), runOf(a, 0, 1), runOf(a, 1, 1), runOf(a, 2, 1)];
    const root = { fileCount: 2, dataBlocks: 3, tableIds: [idOf(0x7a, 0, 3)] };
    const rejects = (entries: TableEntry[], reason: string, r = root) => {
      expect(() => assembleFiles(entries, r, blockSize)).toThrow(CorruptStoreError);
      expect(() => assembleFiles(entries, r, blockSize)).toThrow(reason);
    };

    it('nothing in a valid table', () => {
      expectSameFiles(assembleFiles(valid(), root, blockSize), [a, d]);
    });

    it('a gap between runs', () => {
      const e = valid().filter((_, i) => i !== 3);
      rejects(e, 'a gap between runs', { ...root, dataBlocks: 2 });
    });

    it('missing blocks at the end of a file', () => {
      rejects(valid().slice(0, 4), 'missing blocks', { ...root, dataBlocks: 2 });
    });

    it('two runs that overlap', () => {
      rejects([...valid().slice(0, 3), runOf(a, 0, 2), runOf(a, 1, 2)], 'overlap', { ...root, dataBlocks: 4 });
    });

    it('a run past the end of its file', () => {
      const extra: TableEntry = { kind: 'run', fileId: a.fileId, first: 3, ids: [idOf(0xb0, 9, 3)] };
      rejects([...valid(), extra], 'past the end', { ...root, dataBlocks: 4 });
    });

    it('a run for a directory', () => {
      const run: TableEntry = { kind: 'run', fileId: d.fileId, first: 0, ids: [idOf(0xb0, 9, 3)] };
      rejects([...valid(), run], 'past the end', { ...root, dataBlocks: 4 });
    });

    it('an id used twice: in two runs, or as a data block and a table block', () => {
      const b: StoredFile = { ...a, fileId: idOf(0xf0, 3, 3), path: 'base/1/1260', size: 1, ids: [a.ids[1] as Bytes] };
      rejects([...valid(), fileEntry(b), runOf(b, 0, 1)], 'listed twice', { ...root, fileCount: 3, dataBlocks: 4 });
      rejects(valid(), 'listed twice', { ...root, tableIds: [a.ids[2] as Bytes] });
      rejects(valid(), 'listed twice', { ...root, tableIds: [idOf(0x7a, 0, 3), idOf(0x7a, 0, 3)] });
    });

    it('a run without a file entry', () => {
      rejects(valid().filter((_, i) => i !== 0), 'without a file entry', { ...root, fileCount: 1 });
    });

    it('two file entries for one file', () => {
      rejects([...valid(), { ...fileEntry(a), path: 'other' }], 'two file entries', { ...root, fileCount: 3 });
    });

    it('two files with one path', () => {
      rejects([...valid(), { ...fileEntry(d), fileId: idOf(0xf0, 4, 3) }], 'one path', { ...root, fileCount: 3 });
    });

    it('a count that differs from fileCount or dataBlocks', () => {
      rejects(valid(), 'number of files', { ...root, fileCount: 3 });
      rejects(valid(), 'number of files', { ...root, fileCount: 1 });
      rejects(valid(), 'number of data blocks', { ...root, dataBlocks: 2 });
      rejects(valid(), 'number of data blocks', { ...root, dataBlocks: 4 });
    });
  });

  it('fails with StoreFullError one id past the limit', () => {
    const blockSize = 8192;
    const limit = maxTableBlocks(blockSize);
    // The first table block also holds the file entry (34 bytes with an empty path): 2 ids fewer.
    const capacity = maxRunIds(blockSize) - 2 + (limit - 1) * maxRunIds(blockSize);
    const fileWith = (n: number): StoredFile => ({
      fileId: idOf(0xf0, 0, 4),
      path: '',
      type: 'file',
      mode: 0o100600,
      size: n * blockSize,
      target: '',
      ids: Array.from({ length: n }, (_, i) => idOf(0xb0, i, 4)),
    });
    const full = fileWith(capacity);
    const groups = packEntries([full], blockSize);
    expect(groups.length).toBe(limit);
    expect(assembleFiles(groups.flat(), rootFor([full], tableIdsFor(limit)), blockSize).blocks.size).toBe(capacity);
    expect(() => packEntries([fileWith(capacity + 1)], blockSize)).toThrow(StoreFullError);
  }, 60_000);

  it('fails with StoreFullError for a file entry larger than a table block', () => {
    const file: StoredFile = { fileId: idOf(0xf0, 0, 5), path: 'p', type: 'symlink', mode: 0, size: 0, target: 'x'.repeat(8192), ids: [] };
    expect(() => packEntries([file], 8192)).toThrow(StoreFullError);
  });

  it('computes block counts from size', () => {
    expect(blockCount('file', 0, 8192)).toBe(0);
    expect(blockCount('file', 1, 8192)).toBe(1);
    expect(blockCount('file', 8192, 8192)).toBe(1);
    expect(blockCount('file', 8193, 8192)).toBe(2);
    expect(blockCount('directory', 4096, 8192)).toBe(0);
  });
});
