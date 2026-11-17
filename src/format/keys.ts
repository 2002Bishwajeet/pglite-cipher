// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// The two key tiers (FORMAT.md section 4): the caller's KEK wraps a random DEK in the 168-byte
// header, and the DEK only ever feeds HKDF, for the header key and for one subkey per session.
import { ascii, concat, equalBytes, randomBytes, toHex, type Bytes } from './bytes.ts';
import { decodeMeta, encodeMeta, type BlockSize, type Meta } from './codec.ts';
import { CorruptStoreError, WrongKeyError } from './errors.ts';

export const HEADER_LENGTH = 168;
const WRAP_AAD = ascii('pglite-cipher/wrap');
const HEADER_LABEL = ascii('pglite-cipher/header');
const RECORD_INFO = ascii('pglite-cipher/v1/record');

/** Encryptions under one session subkey before a new salt is drawn. */
export const SUBKEY_MAX_ENCRYPTIONS = 2 ** 24;
let subkeyMaxEncryptions = SUBKEY_MAX_ENCRYPTIONS;

/** Test hook: lower the subkey limit (`null` restores `SUBKEY_MAX_ENCRYPTIONS`). */
export const setSubkeyMaxEncryptions = (n: number | null): void => {
  subkeyMaxEncryptions = n ?? SUBKEY_MAX_ENCRYPTIONS;
};

const hkdfToAesGcm = (dek: CryptoKey, salt: Bytes, info: Bytes): Promise<CryptoKey> =>
  globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    dek,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

/** `HKDF-SHA256(key = DEK, salt, info = "pglite-cipher/v1/record")`, the key records are sealed with. */
export const deriveRecordKey = (dek: CryptoKey, salt: Bytes): Promise<CryptoKey> =>
  hkdfToAesGcm(dek, salt, RECORD_INFO);

const wrapParams = (wrapNonce: Bytes): AesGcmParams => ({ name: 'AES-GCM', iv: wrapNonce, additionalData: WRAP_AAD });

/** Imports 32 raw bytes as a non-extractable AES-GCM KEK (wrap/unwrap only); zeroes `raw` before returning, even on failure. */
export const importKek = async (raw: Bytes): Promise<CryptoKey> => {
  try {
    if (raw.length !== 32) throw new RangeError('a KEK is 32 bytes');
    return await globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
  } finally {
    raw.fill(0);
  }
};

const sealHeader = async (dek: CryptoKey, wrapNonce: Bytes, wrapped: Uint8Array, meta: Bytes): Promise<Bytes> => {
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(wrapNonce, 0);
  header.set(wrapped, 12);
  const metaSalt = randomBytes(16);
  const metaNonce = randomBytes(12);
  header.set(metaSalt, 60);
  header.set(metaNonce, 76);
  const key = await hkdfToAesGcm(dek, metaSalt, HEADER_LABEL);
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: metaNonce, additionalData: concat([HEADER_LABEL, header.subarray(0, 60)]) },
    key,
    meta,
  );
  header.set(new Uint8Array(sealed), 88);
  return header;
};

export interface CreatedHeader {
  dek: CryptoKey;
  meta: Meta;
  header: Bytes;
}

/** A new store's DEK, `storeId` and header; the DEK bytes are zeroed once imported. */
export const createHeader = async (
  kek: CryptoKey,
  { blockSize, keyId }: { blockSize: BlockSize; keyId: number },
): Promise<CreatedHeader> => {
  const meta: Meta = { blockSize, keyId, storeId: randomBytes(16) };
  const metaPlain = encodeMeta(meta);
  const raw = randomBytes(32);
  const wrapNonce = randomBytes(12);
  let dek: CryptoKey;
  let wrapped: ArrayBuffer;
  try {
    const { subtle } = globalThis.crypto;
    const temporary = await subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt']);
    wrapped = await subtle.wrapKey('raw', temporary, kek, wrapParams(wrapNonce));
    dek = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  } finally {
    raw.fill(0);
  }
  return { dek, meta, header: await sealHeader(dek, wrapNonce, new Uint8Array(wrapped), metaPlain) };
};

const isOperationError = (e: unknown): boolean => (e as { name?: unknown } | null)?.name === 'OperationError';

type CopyResult = { opened: true; dek: CryptoKey; meta: Bytes } | { opened: false; unwrapped: boolean };

// A GCM tag failure means the copy doesn't open; any other WebCrypto error (a KEK without `unwrapKey`, say) is
// rethrown so it never reads as a wrong key.
const openCopy = async (kek: CryptoKey, copy: Bytes): Promise<CopyResult> => {
  let dek: CryptoKey;
  try {
    dek = await globalThis.crypto.subtle.unwrapKey(
      'raw',
      copy.subarray(12, 60),
      kek,
      wrapParams(copy.subarray(0, 12)),
      'HKDF',
      false,
      ['deriveKey'],
    );
  } catch (e) {
    if (isOperationError(e)) return { opened: false, unwrapped: false };
    throw e;
  }
  try {
    const key = await hkdfToAesGcm(dek, copy.subarray(60, 76), HEADER_LABEL);
    const meta = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: copy.subarray(76, 88), additionalData: concat([HEADER_LABEL, copy.subarray(0, 60)]) },
      key,
      copy.subarray(88),
    );
    return { opened: true, dek, meta: new Uint8Array(meta) };
  } catch (e) {
    if (isOperationError(e)) return { opened: false, unwrapped: true };
    throw e;
  }
};

export interface OpenedHeader {
  dek: CryptoKey;
  meta: Meta;
  header: Bytes;
  /** The other copy is missing or differs: the next write rewrites both. */
  headerRepairNeeded: boolean;
}

/** Opens the header from its two copies (FORMAT.md section 4). UnsupportedFormatError for an unknown version or scheme;
 * WrongKeyError when both copies are identical and do not unwrap; CorruptStoreError otherwise. */
export const openHeader = async (
  kek: CryptoKey,
  copy0: Bytes | undefined,
  copy1: Bytes | undefined,
): Promise<OpenedHeader> => {
  const copies = [copy0, copy1] as const;
  const same = copy0 !== undefined && copy1 !== undefined && equalBytes(copy0, copy1);
  let unwrapped = false;
  for (const [i, copy] of copies.entries()) {
    if (copy?.length !== HEADER_LENGTH) continue;
    // An identical copy fails the same way.
    if (i === 1 && same) break;
    const result = await openCopy(kek, copy);
    if (result.opened) {
      return { dek: result.dek, meta: decodeMeta(result.meta), header: copy, headerRepairNeeded: !same };
    }
    unwrapped ||= result.unwrapped;
  }
  if (unwrapped || !same || copy0.length !== HEADER_LENGTH) {
    throw new CorruptStoreError('header (slots 0 and 1): no copy opens');
  }
  throw new WrongKeyError('the key opens neither header copy');
};

/** The header re-sealed for a new KEK: same DEK with a fresh wrap nonce, meta with a fresh salt and nonce (AAD holds the new wrap). */
export const rewrapHeader = async (oldKek: CryptoKey, newKek: CryptoKey, header: Bytes): Promise<Bytes> => {
  if (header.length !== HEADER_LENGTH) throw new CorruptStoreError('header: wrong length');
  const result = await openCopy(oldKek, header);
  if (!result.opened) {
    throw result.unwrapped
      ? new CorruptStoreError('header: the meta does not open')
      : new WrongKeyError('the old key does not open the header');
  }
  decodeMeta(result.meta);
  const { subtle } = globalThis.crypto;
  const temporary = await subtle.unwrapKey(
    'raw',
    header.subarray(12, 60),
    oldKek,
    wrapParams(header.subarray(0, 12)),
    'AES-GCM',
    true,
    ['encrypt'],
  );
  const wrapNonce = randomBytes(12);
  const wrapped = await subtle.wrapKey('raw', temporary, newKek, wrapParams(wrapNonce));
  return sealHeader(result.dek, wrapNonce, new Uint8Array(wrapped), result.meta);
};

/** Session subkeys (FORMAT.md section 5). `current()` is the writer's: one encryption per call, a new salt at
 * `SUBKEY_MAX_ENCRYPTIONS`. `forSalt()` is the reader's, cached per salt. */
export class SubkeyCache {
  private readonly dek: CryptoKey;
  private readonly keys = new Map<string, Promise<CryptoKey>>();
  private salt: Bytes | null = null;
  private uses = 0;

  constructor(dek: CryptoKey) {
    this.dek = dek;
  }

  get size(): number {
    return this.keys.size;
  }

  forSalt(salt: Bytes): Promise<CryptoKey> {
    const hex = toHex(salt);
    let key = this.keys.get(hex);
    if (!key) {
      key = deriveRecordKey(this.dek, salt);
      this.keys.set(hex, key);
    }
    return key;
  }

  async current(): Promise<{ key: CryptoKey; salt: Bytes }> {
    if (this.salt === null || this.uses >= subkeyMaxEncryptions) {
      this.salt = randomBytes(16);
      this.uses = 0;
    }
    this.uses++;
    const salt = this.salt;
    return { key: await this.forSalt(salt), salt };
  }
}
