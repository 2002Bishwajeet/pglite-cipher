// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Keys and header copies: what is extractable, what each wrong input gives, and rule 5.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bytes } from '../../src/format/bytes.ts';
import { CorruptStoreError, WrongKeyError } from '../../src/format/errors.ts';
import { createHeader, HEADER_LENGTH, importKek, openHeader, rewrapHeader, SubkeyCache } from '../../src/format/keys.ts';
import { openBlock, sealBlock } from '../../src/format/records.ts';
import { contextFor, flipBit, newKek, newStore, random, rejection } from './helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const sorted = (usages: readonly string[]) => [...usages].sort();

describe('keys', () => {
  it('importKek zeroes its input and makes a non-extractable key that only wraps and unwraps', async () => {
    const raw = random(32);
    const kek = await importKek(raw);
    expect(raw.every((b) => b === 0)).toBe(true);
    expect(kek.extractable).toBe(false);
    expect(kek.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(sorted(kek.usages)).toEqual(['unwrapKey', 'wrapKey']);
  });

  it('importKek refuses a key that is not 32 bytes, and zeroes it too', async () => {
    const raw = random(16);
    await rejection(importKek(raw), RangeError);
    expect(raw.every((b) => b === 0)).toBe(true);
  });

  it('the DEK is a non-extractable HKDF key, from createHeader and from openHeader', async () => {
    const kek = await newKek();
    const created = await createHeader(kek, { blockSize: 65536, keyId: 3 });
    const opened = await openHeader(kek, created.header, created.header.slice());
    for (const dek of [created.dek, opened.dek]) {
      expect(dek.algorithm.name).toBe('HKDF');
      expect(dek.extractable).toBe(false);
      expect(sorted(dek.usages)).toEqual(['deriveKey']);
      await rejection(globalThis.crypto.subtle.exportKey('raw', dek), Error);
    }
    expect(opened.meta).toEqual(created.meta);
  });

  it('the header key and the subkeys are not extractable', async () => {
    const derive = vi.spyOn(globalThis.crypto.subtle, 'deriveKey');
    const { kek, header, ctx } = await newStore();
    await openHeader(kek, header, header.slice());
    await ctx.subkeys.current();
    await ctx.subkeys.forSalt(random(16));
    expect(derive).toHaveBeenCalledTimes(4);
    for (const result of derive.mock.results) {
      const key = await (result.value as Promise<CryptoKey>);
      expect(key.extractable).toBe(false);
      expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    }
    for (const call of derive.mock.calls) expect(call[3]).toBe(false);
  });

  it('a wrong KEK gives WrongKeyError', async () => {
    const { header } = await newStore();
    await rejection(openHeader(await newKek(), header, header.slice()), WrongKeyError);
  });

  it('a KEK without unwrapKey is a caller error, never a wrong key', async () => {
    const { header } = await newStore();
    const encryptOnly = await globalThis.crypto.subtle.importKey('raw', random(32), 'AES-GCM', false, ['encrypt']);
    const error = await rejection(openHeader(encryptOnly, header, header.slice()), Error);
    expect(error).not.toBeInstanceOf(WrongKeyError);
    expect(error).not.toBeInstanceOf(CorruptStoreError);
  });

  it('rewrapHeader: the new header opens with the new key, not the old, and holds the same meta and DEK', async () => {
    const { kek, header, meta, ctx } = await newStore();
    const fileId = random(16);
    const blockId = random(16);
    const plain = random(100);
    const sealed = await sealBlock(ctx, fileId, 0, plain);

    const kek2 = await newKek();
    const rewrapped = await rewrapHeader(kek, kek2, header);
    expect(rewrapped.length).toBe(HEADER_LENGTH);
    expect(rewrapped.subarray(0, 12)).not.toEqual(header.subarray(0, 12));
    expect(rewrapped.subarray(60, 88)).not.toEqual(header.subarray(60, 88));

    const opened = await openHeader(kek2, rewrapped, rewrapped.slice());
    expect(opened.meta).toEqual(meta);
    const reader = contextFor(opened.dek, opened.meta);
    expect((await openBlock(reader, blockId, fileId, 0, sealed)).subarray(0, 100)).toEqual(plain);
    await rejection(openHeader(kek, rewrapped, rewrapped.slice()), WrongKeyError);
    await rejection(rewrapHeader(kek2, kek, header), WrongKeyError);
  });
});

describe('header copies', () => {
  const damageWrap = (h: Bytes) => flipBit(h, 20 * 8);
  const damageMeta = (h: Bytes) => flipBit(h, 100 * 8);

  it('reads copy 1 when copy 0 is damaged, and asks for a repair', async () => {
    const { kek, header, meta } = await newStore();
    for (const damaged of [damageWrap(header), damageMeta(header), header.subarray(0, 100), undefined]) {
      const opened = await openHeader(kek, damaged, header);
      expect(opened.meta).toEqual(meta);
      expect(opened.header).toEqual(header);
      expect(opened.headerRepairNeeded).toBe(true);
    }
  });

  it('reads copy 0 when copy 1 is damaged or missing, and asks for a repair', async () => {
    const { kek, header } = await newStore();
    for (const damaged of [damageWrap(header), damageMeta(header), new Uint8Array(0), undefined]) {
      expect((await openHeader(kek, header, damaged)).headerRepairNeeded).toBe(true);
    }
    expect((await openHeader(kek, header, header.slice())).headerRepairNeeded).toBe(false);
  });

  it('gives CorruptStoreError when both copies are damaged in different ways', async () => {
    const { kek, header } = await newStore();
    await rejection(openHeader(kek, damageWrap(header), damageMeta(header)), CorruptStoreError);
    await rejection(openHeader(kek, damageWrap(header), flipBit(header, 0)), CorruptStoreError);
  });

  it('gives CorruptStoreError when only the meta part of both copies is damaged', async () => {
    const { kek, header } = await newStore();
    await rejection(openHeader(kek, damageMeta(header), damageMeta(header)), CorruptStoreError);
    await rejection(openHeader(kek, damageMeta(header), flipBit(header, 160 * 8)), CorruptStoreError);
  });

  it('gives CorruptStoreError when a copy is missing or has the wrong length and the other does not open', async () => {
    const { kek, header } = await newStore();
    const wrong = await newKek();
    await rejection(openHeader(wrong, header, undefined), CorruptStoreError);
    await rejection(openHeader(wrong, undefined, header), CorruptStoreError);
    await rejection(openHeader(wrong, header.subarray(0, 167), header), CorruptStoreError);
    const short = header.subarray(0, 100);
    await rejection(openHeader(kek, short, short.slice()), CorruptStoreError);
    await rejection(openHeader(kek, undefined, undefined), CorruptStoreError);
  });

  it('gives WrongKeyError when both copies are intact and the key is wrong', async () => {
    const { header } = await newStore();
    await rejection(openHeader(await newKek(), header, header.slice()), WrongKeyError);
  });

  it('reads two copies overwritten with the same random bytes as a wrong key: the documented limit of rule 5', async () => {
    const { kek } = await newStore();
    const noise = random(HEADER_LENGTH);
    await rejection(openHeader(kek, noise, noise.slice()), WrongKeyError);
  });
});

describe('session subkeys', () => {
  it('cache one deriveKey per salt', async () => {
    const { dek } = await newStore();
    const derive = vi.spyOn(globalThis.crypto.subtle, 'deriveKey');
    const cache = new SubkeyCache(dek);
    const salts = new Set<string>();
    for (let i = 0; i < 10; i++) salts.add(String((await cache.current()).salt));
    expect(salts.size).toBe(1);
    expect(derive).toHaveBeenCalledTimes(1);
    const a = random(16);
    const b = random(16);
    const keys = [await cache.forSalt(a), await cache.forSalt(b), await cache.forSalt(a.slice()), await cache.forSalt(b)];
    expect(derive).toHaveBeenCalledTimes(3);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[1]).toBe(keys[3]);
  });
});
