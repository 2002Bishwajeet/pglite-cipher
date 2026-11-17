// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// The demo page's three checks (examples/demo), in every browser: what the page shows must be true.
import { afterAll, describe, expect, it } from 'vitest';
import { newKey, proof, reset, speed, tamper } from '../examples/demo/demo.mjs';

describe('examples/demo', () => {
  afterAll(reset);

  it('writes and reopens both stores, hides the word only in the encrypted one, and refuses a tampered block', async () => {
    const key = await newKey();
    const timing = await speed(key, 500, 'pineapple');
    expect(timing.plain.count).toBe(500);
    expect(timing.encrypted.count).toBe(500);

    const found = await proof('pineapple');
    expect(found.plain.found).toBe(true);
    expect(found.encrypted.records).toBeGreaterThan(3);
    expect(found.encrypted.found).toBe(false);

    expect(await tamper(key)).toBe('CorruptStoreError');
  }, 180_000);
});
