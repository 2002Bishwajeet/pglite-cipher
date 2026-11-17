import { expect } from 'vitest';
import { toHex, type Bytes } from '../../src/format/bytes.ts';
import type { BlockSize } from '../../src/format/codec.ts';
import { createHeader, importKek, SubkeyCache } from '../../src/format/keys.ts';
import type { RecordContext } from '../../src/format/records.ts';
import { setRandomSource } from '../../src/testing.ts';

export const inBrowser = 'document' in globalThis;

export const hex = toHex;

export const fromHex = (s: string): Bytes => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

export const random = (n: number): Bytes => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** `length` pseudo-random bytes from a seed (xorshift32), so that fast-check cases replay. */
export const seeded = (seed: number, length: number): Bytes => {
  const out = new Uint8Array(length);
  let x = (seed * 2 + 1) | 0;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
};

export const run = (n: number, start: number): Bytes => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);

export const newKek = (): Promise<CryptoKey> => importKek(random(32));

export const contextFor = (dek: CryptoKey, meta: RecordContext['meta']): RecordContext => ({
  subkeys: new SubkeyCache(dek),
  meta,
  encryptions: 0,
});

export const newStore = async (blockSize: BlockSize = 8192, keyId = 1) => {
  const kek = await newKek();
  const { dek, meta, header } = await createHeader(kek, { blockSize, keyId });
  return { kek, dek, meta, header, ctx: contextFor(dek, meta) };
};

export const flipBit = (bytes: Bytes, bit: number): Bytes => {
  const out = bytes.slice();
  out[bit >> 3] = (out[bit >> 3] ?? 0) ^ (1 << (bit & 7));
  return out;
};

export const injectRandom = (draws: Bytes[]): void => {
  const queue = [...draws];
  setRandomSource((n) => {
    const next = queue.shift();
    if (next?.length !== n) throw new Error(`injected random draw of ${String(n)} bytes does not match the queue`);
    return next.slice();
  });
};

export const restoreRandom = (): void => {
  setRandomSource(null);
};

export const rejection = async (promise: Promise<unknown>, type: abstract new (...args: never[]) => Error): Promise<Error> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  return error as Error;
};
