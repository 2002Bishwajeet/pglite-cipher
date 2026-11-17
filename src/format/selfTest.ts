// A known-answer check of HKDF-SHA256 → AES-256-GCM seal → open, run once per process before the
// first real operation. Webview crypto differs by platform; one that computes something else must
// fail here, not write a store nobody can read.
import { equalBytes, type Bytes } from './bytes.ts';
import { CryptoSelfTestError } from './errors.ts';
import { deriveRecordKey } from './keys.ts';

const run = (n: number, start: number): Bytes => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);

// Inputs: DEK 00..1f, salt a0..af, nonce c0..cb, AAD 40..54, plaintext 60..8f; info is the v1 record
// info. Expected output computed with node:crypto (hkdfSync, createCipheriv('aes-256-gcm')).
const DEK = run(32, 0x00);
const SALT = run(16, 0xa0);
const NONCE = run(12, 0xc0);
const AAD = run(21, 0x40);
const PLAINTEXT = run(48, 0x60);
const SEALED = Uint8Array.from(
  'ac08d0cc04cee6ff8e6ed900b6e61b0aa7175006f442f4204801dcbd408985b27befc4206338a99ff90f4bfb542ec164ace9500424a89dcd2f64dc5bb6268106'.match(
    /../g,
  ) ?? [],
  (h) => parseInt(h, 16),
);

const check = async (): Promise<void> => {
  const { subtle } = globalThis.crypto;
  try {
    const dek = await subtle.importKey('raw', DEK, 'HKDF', false, ['deriveKey']);
    const key = await deriveRecordKey(dek, SALT);
    const params = { name: 'AES-GCM', iv: NONCE, additionalData: AAD };
    const sealed = new Uint8Array(await subtle.encrypt(params, key, PLAINTEXT));
    const opened = new Uint8Array(await subtle.decrypt(params, key, SEALED));
    if (equalBytes(sealed, SEALED) && equalBytes(opened, PLAINTEXT)) return;
  } catch {
    // Reported below.
  }
  throw new CryptoSelfTestError('WebCrypto failed the HKDF-SHA256 / AES-256-GCM known-answer test');
};

let result: Promise<void> | null = null;

/** Resolves once WebCrypto has passed; rejects with CryptoSelfTestError, every time, if it did not. */
export const selfTest = (): Promise<void> => (result ??= check());

/** Test hook: forget the cached outcome so the next `selfTest()` runs again. */
export const resetSelfTest = (): void => {
  result = null;
};
