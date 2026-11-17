// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from 'vitest';
import { judgeGates, judgePart, type GatesResult } from '../bench/judge.ts';
import { parseBlockSize, parsePack } from '../bench/params.ts';

describe('bench: ?block= parsing', () => {
  it('falls back to the default for an absent or empty value', () => {
    expect(parseBlockSize(null)).toBe(65536);
    expect(parseBlockSize('')).toBe(65536);
  });
  it('accepts every supported block size', () => {
    for (const n of [8192, 32768, 65536]) expect(parseBlockSize(String(n))).toBe(n);
  });
  it('rejects a non-numeric value and a size outside BLOCK_SIZES', () => {
    for (const bad of ['abc', 'NaN', '12345', '0', '-8192', '8192abc']) expect(() => parseBlockSize(bad)).toThrow(/block/);
  });
});

describe('bench: ?pack= parsing', () => {
  it('is 1 for an absent or empty value', () => {
    expect(parsePack(null)).toBe(1);
    expect(parsePack('')).toBe(1);
  });
  it('accepts 1, 4, 8 and 16', () => {
    for (const n of [1, 4, 8, 16]) expect(parsePack(String(n))).toBe(n);
  });
  it('rejects anything else', () => {
    for (const bad of ['abc', '0', '2', '-8', '8x', '32']) expect(() => parsePack(bad)).toThrow(/pack/);
  });
});

describe('bench: gate table of a part whose key operations threw', () => {
  const stat = { p50: 1 };
  const encrypted = {
    g1: { ms: stat, tableBlocks: stat, tableBlocksWithoutFileChange: 0, maxTableBlocksPerChangedFile: 0 },
    g2: { ms: stat, tableMs: stat },
    g3: { source: 'performance.memory', bytes: 0 },
    g4: { ms: stat },
    dataDir: { bytes: 0 },
    keysError: 'QuotaExceededError',
  };
  const result = { sizeMB: 10, blockSize: 65536, encrypted } as unknown as GatesResult;

  it('reports the key operations as failed, not passed or skipped', () => {
    const row = judgeGates(result, 1).find((r) => r.gate.startsWith('Key operations'));
    expect(row?.pass).toBe(false);
  });

  it('is judged as a gate table when the part is named enc*, the dispatch gates.ts uses', () => {
    const row = judgePart('enc10', result, 1)?.find((r) => r.gate.startsWith('Key operations'));
    expect(row?.pass).toBe(false);
    expect(judgePart('other', result, 1)).toBeNull();
  });
});
