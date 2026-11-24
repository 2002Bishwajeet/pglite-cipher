// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Decoder fuzz: every decoder and assembleFiles gives a value or a documented error, never another exception or a hang.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Bytes } from '../../src/format/bytes.ts';
import {
  BLOCK_SIZES,
  decodeMeta,
  decodeRoot,
  decodeTable,
  encodeMeta,
  encodeRoot,
  encodeTable,
  type BlockSize,
  type TableEntry,
} from '../../src/format/codec.ts';
import { CorruptStoreError, UnsupportedFormatError } from '../../src/format/errors.ts';
import { assembleFiles, packEntries, type StoredFile } from '../../src/format/table.ts';
import { seeded } from './helpers.ts';
import { LONG, timeout } from '../long.ts';

// Decoder fuzz: 1,000,000 cases each under CIPHER_LONG.
const RUNS = LONG ? 1_000_000 : 20_000;
const BUDGET_MS = 50;
const RETIMES = 3;

type ErrorType = typeof CorruptStoreError | typeof UnsupportedFormatError;

const timed = <T>(fn: () => T, allowed: ErrorType[]): { value: T | null; ms: number } => {
  const start = performance.now();
  let value: T | null = null;
  try {
    value = fn();
  } catch (e) {
    if (!allowed.some((type) => e instanceof type)) throw e;
  }
  return { value, ms: performance.now() - start };
};

/**
 * Fails on any outcome but a value or one of `allowed`, or on taking over 50 ms. A slow case is
 * timed again up to 3 times and fails only if every run is slow: one GC pause or stalled runner
 * in a million cases is not a slow input.
 */
const outcome = <T>(fn: () => T, allowed: ErrorType[]): T | null => {
  const { value, ms } = timed(fn, allowed);
  let fastest = ms;
  for (let i = 0; i < RETIMES && fastest > BUDGET_MS; i++) fastest = Math.min(fastest, timed(fn, allowed).ms);
  if (fastest > BUDGET_MS) throw new Error(`one case took ${fastest.toFixed(1)} ms at best of ${String(RETIMES + 1)} runs`);
  return value;
};

const id = (n: number): Bytes => seeded(n, 16);

const files = (blockSize: BlockSize): StoredFile[] => [
  { fileId: id(1), path: 'base/1/1259', type: 'file', mode: 0o100600, size: 3 * blockSize - 5, target: '', ids: [id(10), id(11), id(12)] },
  { fileId: id(2), path: 'base/1', type: 'directory', mode: 0o40700, size: 0, target: '', ids: [] },
  { fileId: id(3), path: 'pg_tblspc/x', type: 'symlink', mode: 0o120777, size: 0, target: '../t', ids: [] },
  { fileId: id(4), path: 'PG_VERSION', type: 'file', mode: 0o100600, size: 3, target: '', ids: [id(13)] },
  { fileId: id(5), path: 'empty', type: 'file', mode: 0o100600, size: 0, target: '', ids: [] },
];

interface Base {
  blockSize: BlockSize;
  bytes: Bytes;
  used: number;
}

const base = (blockSize: BlockSize, bytes: Bytes): Base => {
  let used = bytes.length;
  while (used > 0 && bytes[used - 1] === 0) used--;
  return { blockSize, bytes, used };
};

const tableEntries = (blockSize: BlockSize): TableEntry[] => packEntries(files(blockSize), blockSize).flat();
const tableIds = [id(20)];
const rootOf = () => ({
  gen: 9,
  encryptions: 99,
  state: 'ready' as const,
  origin: 'https://app.example',
  fileCount: 5,
  dataBlocks: 4,
  tableDigest: seeded(30, 32),
  manifest: seeded(31, 32),
  tableIds,
});

const metaBases = BLOCK_SIZES.map((blockSize) => base(blockSize, encodeMeta({ blockSize, keyId: 0xdeadbeef, storeId: id(40) })));
const rootBases = BLOCK_SIZES.map((blockSize) => base(blockSize, encodeRoot(rootOf(), blockSize)));
const tableBases = BLOCK_SIZES.map((blockSize) => base(blockSize, encodeTable(tableEntries(blockSize), blockSize)));

const buffer = (bases: Base[]) =>
  fc.oneof(
    {
      weight: 1,
      arbitrary: fc
        .record({ seed: fc.integer(), length: fc.oneof(fc.constantFrom(0, 1, 64, ...BLOCK_SIZES), fc.nat(70_000)) })
        .map(({ seed, length }) => seeded(seed, length)),
    },
    {
      weight: 4,
      arbitrary: fc
        .record({
          base: fc.constantFrom(...bases),
          edits: fc.array(fc.record({ at: fc.nat(), value: fc.nat(255) }), { maxLength: 6 }),
          // Mostly the base's own length: what a decoder reads past the length check.
          resize: fc.oneof({ weight: 7, arbitrary: fc.constant(0) }, fc.integer({ min: -100, max: 100 })),
        })
        .map(({ base: b, edits, resize }) => {
          const out = new Uint8Array(Math.max(0, b.bytes.length + resize));
          out.set(b.bytes.subarray(0, out.length));
          for (const { at, value } of edits) out[at % (b.used + 8)] = value;
          return out;
        }),
    },
  );

describe('decoder fuzz', () => {
  it('the 50 ms budget fails a case slow on every run, not one slow once', () => {
    const busy = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };
    expect(() => {
      outcome(() => {
        busy(BUDGET_MS + 10);
      }, []);
    }).toThrow(/at best of 4 runs/);
    let calls = 0;
    const once = () => {
      if (calls++ === 0) busy(BUDGET_MS + 10);
      return 1;
    };
    expect(outcome(once, [])).toBe(1);
    expect(calls).toBe(2);
  });

  it('decodeMeta', () => {
    fc.assert(
      fc.property(buffer(metaBases), (bytes) => {
        outcome(() => decodeMeta(bytes), [CorruptStoreError, UnsupportedFormatError]);
      }),
      { numRuns: RUNS },
    );
  }, timeout(300_000, 50));

  it('decodeRoot', () => {
    fc.assert(
      fc.property(buffer(rootBases), (bytes) => {
        outcome(() => decodeRoot(bytes), [CorruptStoreError]);
      }),
      { numRuns: RUNS },
    );
  }, timeout(300_000, 50));

  it('decodeTable', () => {
    fc.assert(
      fc.property(buffer(tableBases), (bytes) => {
        outcome(() => decodeTable(bytes), [CorruptStoreError]);
      }),
      { numRuns: RUNS },
    );
  }, timeout(300_000, 50));

  // Past counterexample (seed 905168194, path "6179"): 64 KiB block, edit at 68 makes a first run of 25,603 ids.
  it('decodeTable, a run longer than the block', () => {
    const bytes = encodeTable(tableEntries(65536), 65536);
    for (const [at, value] of [[27, 160], [68, 100], [224, 30], [308, 61]] as const) bytes[at] = value;
    expect(() => decodeTable(bytes)).toThrow(CorruptStoreError);
  });

  it('assembleFiles, over decoded mutated table blocks and roots', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BLOCK_SIZES),
        fc.oneof(buffer(tableBases), fc.constant(null)),
        fc.oneof(buffer(rootBases), fc.constant(null)),
        (blockSize, tableBytes, rootBytes) => {
          const entries = tableBytes ? outcome(() => decodeTable(tableBytes), [CorruptStoreError]) : tableEntries(blockSize);
          const root = rootBytes ? outcome(() => decodeRoot(rootBytes), [CorruptStoreError]) : rootOf();
          if (entries === null || root === null) return;
          outcome(() => assembleFiles(entries, root, blockSize), [CorruptStoreError]);
        },
      ),
      { numRuns: RUNS },
    );
  }, timeout(300_000, 50));
});
