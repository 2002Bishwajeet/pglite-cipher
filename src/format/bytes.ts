// Byte helpers shared by the format modules, and the one source of randomness they draw from.

/** Bytes WebCrypto accepts as a `BufferSource`. */
export type Bytes = Uint8Array<ArrayBuffer>;

let source: ((n: number) => Bytes) | null = null;

/** `n` random bytes from `crypto.getRandomValues`, or from the source a test installed. */
export const randomBytes = (n: number): Bytes =>
  source ? source(n) : globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Test hook: replace the random source (`null` restores `crypto.getRandomValues`). */
export const setRandomSource = (fn: ((n: number) => Bytes) | null): void => {
  source = fn;
};

export const ascii = (text: string): Bytes => Uint8Array.from(text, (c) => c.charCodeAt(0));

export const concat = (parts: readonly Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const u32 = (n: number): Bytes => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Lowercase hex: the form a block id takes in a backend's keys. */
export const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += HEX[b] ?? '';
  return out;
};

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Byte-order comparison, for sorting ids. */
export const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
};
