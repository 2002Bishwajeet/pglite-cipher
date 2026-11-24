// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Session subkeys (rule 4) and fresh randomness: salts, nonces and ids never repeat.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bytes } from '../../src/format/bytes.ts';
import { SUBKEY_MAX_ENCRYPTIONS } from '../../src/format/keys.ts';
import { newBlockId, openBlock, sealBlock } from '../../src/format/records.ts';
import { setSubkeyMaxEncryptions } from '../../src/testing.ts';
import { contextFor, hex, newStore, random, rejection } from './helpers.ts';

afterEach(() => {
  setSubkeyMaxEncryptions(null);
  vi.restoreAllMocks();
});

const saltOf = (sealed: Bytes) => hex(sealed.subarray(0, 16));
const nonceOf = (sealed: Bytes) => hex(sealed.subarray(16, 28));

describe('session subkeys', () => {
  it('limit one subkey to 2^24 encryptions', () => {
    expect(SUBKEY_MAX_ENCRYPTIONS).toBe(2 ** 24);
  });

  it('give each session its own salt, shared by all its records', async () => {
    const { dek, meta } = await newStore();
    const fileId = random(16);
    const one = contextFor(dek, meta);
    const two = contextFor(dek, meta);
    const a = [await sealBlock(one, fileId, 0, random(8)), await sealBlock(one, fileId, 1, random(8))];
    const b = await sealBlock(two, fileId, 0, random(8));
    expect(saltOf(a[0] as Bytes)).toBe(saltOf(a[1] as Bytes));
    expect(saltOf(b)).not.toBe(saltOf(a[0] as Bytes));
  });

  it('roll to a new salt at the limit, and old and new records both open', async () => {
    setSubkeyMaxEncryptions(3);
    const { dek, meta } = await newStore();
    const writer = contextFor(dek, meta);
    const fileId = random(16);
    const sealed: Bytes[] = [];
    for (let i = 0; i < 10; i++) sealed.push(await sealBlock(writer, fileId, i, Uint8Array.of(i)));
    expect(sealed.map(saltOf).filter((s, i, all) => all.indexOf(s) === i).length).toBe(4);
    expect(new Set(sealed.slice(0, 3).map(saltOf)).size).toBe(1);
    expect(saltOf(sealed[3] as Bytes)).not.toBe(saltOf(sealed[2] as Bytes));
    const reader = contextFor(dek, meta);
    for (const [i, s] of sealed.entries()) expect((await openBlock(reader, newBlockId(), fileId, i, s))[0]).toBe(i);
  });

  it('count every attempted encryption, also one that fails', async () => {
    const { ctx } = await newStore();
    await sealBlock(ctx, random(16), 0, random(8));
    expect(ctx.encryptions).toBe(1);
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('simulated'));
    await rejection(sealBlock(ctx, random(16), 0, random(8)), Error);
    expect(ctx.encryptions).toBe(2);
  });

  it('never repeat a salt or a nonce across 100,000 seals', async () => {
    // A low limit rolls the writer through 100 salts.
    setSubkeyMaxEncryptions(1000);
    const { dek, meta } = await newStore();
    const ctx = contextFor(dek, meta);
    const fileId = random(16);
    const body = new Uint8Array(8);
    const salts = new Set<string>();
    const nonces = new Set<string>();
    let previous = '';
    for (let done = 0; done < 100_000; done += 500) {
      const batch = await Promise.all(Array.from({ length: 500 }, (_, i) => sealBlock(ctx, fileId, done + i, body)));
      for (const s of batch) {
        const salt = saltOf(s);
        if (salt !== previous) {
          expect(salts.has(salt)).toBe(false);
          salts.add(salt);
          previous = salt;
        }
        nonces.add(nonceOf(s));
      }
    }
    expect(salts.size).toBe(100);
    expect(nonces.size).toBe(100_000);
  }, 600_000);

  it('never repeat a block id across 100,000 draws', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100_000; i++) ids.add(hex(newBlockId()));
    expect(ids.size).toBe(100_000);
  });
});
