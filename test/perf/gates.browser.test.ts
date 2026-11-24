// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// PR perf gates (Chromium only): G1, G2, G4, G9 at 10 MB, as ratios against plain idb:// in the same run so they hold on any machine; absolute ms are the nightly bench's.
// G9: a sync that changes no file writes no table block; GIN pending-list growth may, counted in `g1.fileChanges`. G2: 20 interleaved opens per variant, each timed open after an untimed one of the same variant.
// G4's denominator is the plain normal sync; `ratios` also records the switch ratios, unasserted.
import { describe, expect, it } from 'vitest';
import { ratios, runPair } from '../../bench/measure.ts';

const MB = 10;
const RUNS = 10;
const OPENS = 20;

describe('perf gates at 10 MB, against plain idb:// in the same run', () => {
  it('G1 ≤ 2×, G2 ≤ 2×, G4 ≤ 10× a plain normal sync, G9 open ≤ 5 % and no table block in a G1 sync that changed no file', async () => {
    const log = () => undefined;
    const { plain, encrypted } = await runPair(MB, RUNS, log, { opens: OPENS });
    const r = ratios(plain, encrypted);
    console.log(JSON.stringify({ sizeMB: MB, runs: RUNS, opens: OPENS, ratios: r, plain, encrypted }));
    expect.soft(r.g1, 'G1: encrypted ÷ plain one-row-update sync, p50').toBeLessThanOrEqual(2);
    expect.soft(r.g2, 'G2: encrypted ÷ plain open, p50').toBeLessThanOrEqual(2);
    expect.soft(r.g4, 'G4: encrypted segment-switch sync ÷ plain normal sync, p50').toBeLessThanOrEqual(10);
    expect.soft(r.g9Open, 'G9: file-table phase ÷ encrypted open, p50').toBeLessThanOrEqual(0.05);
    expect.soft(encrypted.g1.tableBlocksWithoutFileChange, 'G9: G1 syncs that changed no file and wrote a table block').toBe(0);
    expect.soft(encrypted.g1.tableBlocks?.p50, 'G9: table blocks of a G1 sync, p50').toBe(0);
    expect.soft(encrypted.g1.maxTableBlocksPerChangedFile, 'G9: table blocks per changed file, most of any G1 sync').toBeLessThanOrEqual(1);
  }, 900_000);
});
