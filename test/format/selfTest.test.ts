// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// The known-answer self-test passes on this engine and fails loudly when WebCrypto computes something else.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoSelfTestError } from '../../src/format/errors.ts';
import { selfTest } from '../../src/format/selfTest.ts';
import { resetSelfTest } from '../../src/testing.ts';
import { rejection } from './helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  resetSelfTest();
});

describe('selfTest', () => {
  it('passes, once per process', async () => {
    resetSelfTest();
    const first = selfTest();
    await first;
    expect(selfTest()).toBe(first);
  });

  it('throws CryptoSelfTestError when encrypt returns altered bytes', async () => {
    const { subtle } = globalThis.crypto;
    const encrypt = subtle.encrypt.bind(subtle);
    vi.spyOn(subtle, 'encrypt').mockImplementation(async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      const out = new Uint8Array(await encrypt(...args));
      out[5] = (out[5] ?? 0) ^ 0x10;
      return out.buffer;
    });
    resetSelfTest();
    await rejection(selfTest(), CryptoSelfTestError);
    // No store is written after a failed self-test.
    await rejection(selfTest(), CryptoSelfTestError);
  });

  it('throws CryptoSelfTestError when WebCrypto itself throws', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'deriveKey').mockRejectedValue(new Error('not supported'));
    resetSelfTest();
    await rejection(selfTest(), CryptoSelfTestError);
  });
});
