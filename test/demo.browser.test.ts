// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// The demo page's three checks (examples/demo), in every browser: what the page shows must be true.
import { afterAll, describe, expect, it } from 'vitest';
import { newKey, proof, reset, speed, storeKeys, tamper } from '../examples/demo/demo.mjs';

describe('examples/demo', () => {
  afterAll(reset);

  it('writes and reopens both stores, hides the word only in the encrypted one, and refuses a tampered block', async () => {
    const key = await newKey();
    const timing = await speed(key, 500, 'pineapple');
    expect(timing.plain.count).toBe(500);
    expect(timing.encrypted.count).toBe(500);

    const keys = await storeKeys();
    expect(keys.plain.length).toBe(6);
    expect(keys.encrypted.slice(0, 3)).toEqual(['0', '1', '2']);

    // The viewer shows the stored bytes, so the word must be in them where the page marks it.
    for (const word of ['pineapple', 'ананас 🍍']) {
      if (word !== 'pineapple') await speed(key, 50, word);
      const needle = new TextEncoder().encode(word);
      const found = await proof(word);
      expect(found.plain.found).toBe(true);
      const [from, to] = found.plain.match ?? [0, 0];
      expect(found.plain.bytes.slice(from - found.plain.start, to - found.plain.start)).toEqual(needle);
      expect(found.encrypted.records).toBeGreaterThan(3);
      expect(found.encrypted.found).toBe(false);
      expect(found.encrypted.key).toMatch(/^[0-9a-f]{32}$/);
      expect(found.encrypted.bytes.length).toBe(48);
    }

    const t = await tamper(key);
    expect(t.error).toBe('CorruptStoreError');
    expect(t.offset).toBe(t.size - 1);
    expect(t.before ^ t.after).toBe(1);
  }, 180_000);
});
