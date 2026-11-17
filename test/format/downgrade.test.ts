// Every parameter a reader acts on is authenticated before it is acted on.
import { describe, expect, it } from 'vitest';
import { ascii, concat, randomBytes, type Bytes } from '../../src/format/bytes.ts';
import { encodeMeta, encodeRoot, type Meta } from '../../src/format/codec.ts';
import { CorruptStoreError, UnsupportedFormatError, WrongKeyError } from '../../src/format/errors.ts';
import { createHeader, HEADER_LENGTH, openHeader, rewrapHeader } from '../../src/format/keys.ts';
import { openRoot, sealRoot } from '../../src/format/records.ts';
import { flipBit, newKek, newStore, rejection } from './helpers.ts';

const { subtle } = globalThis.crypto;

const hkdf = (dek: CryptoKey, salt: Bytes, info: string) =>
  subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: ascii(info) }, dek, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
  ]);

/** Seals `metaPlain` into `header`, as a writer of that meta would. */
const resealMeta = async (dek: CryptoKey, header: Bytes, metaPlain: Bytes): Promise<Bytes> => {
  const key = await hkdf(dek, header.subarray(60, 76), 'pglite-cipher/header');
  const sealed = await subtle.encrypt(
    { name: 'AES-GCM', iv: header.subarray(76, 88), additionalData: concat([ascii('pglite-cipher/header'), header.subarray(0, 60)]) },
    key,
    metaPlain,
  );
  return concat([header.subarray(0, 88), new Uint8Array(sealed)]);
};

const withMetaByte = (meta: Meta, at: number, value: number) => {
  const plain = encodeMeta(meta);
  plain[at] = value;
  return plain;
};

describe('downgrade and splicing fail', () => {
  it('fails to open a header with any one bit flipped', async () => {
    const { kek, header } = await newStore();
    for (let bit = 0; bit < HEADER_LENGTH * 8; bit++) {
      const damaged = flipBit(header, bit);
      // Bytes 0–59 are the wrap, 60–167 the meta.
      await rejection(openHeader(kek, damaged, damaged.slice()), bit < 60 * 8 ? WrongKeyError : CorruptStoreError);
    }
  }, 120_000);

  it('reports a correctly sealed meta of an unknown version or scheme as unsupported, not as a wrong key', async () => {
    const { kek, dek, meta, header } = await newStore();
    const cases: [number, number, typeof UnsupportedFormatError | typeof CorruptStoreError][] = [
      [1, 2, UnsupportedFormatError], // v = 2
      [0, 1, UnsupportedFormatError], // v = 257
      [2, 2, UnsupportedFormatError], // cipher
      [3, 1, UnsupportedFormatError], // kdf
      [4, 2, UnsupportedFormatError], // subkey
      [10, 0x10, CorruptStoreError], // blockSize 8192 → 4096
      [6, 1, CorruptStoreError], // a zero byte
      [40, 1, CorruptStoreError], // a reserved byte
    ];
    for (const [at, value, type] of cases) {
      const forged = await resealMeta(dek, header, withMetaByte(meta, at, value));
      await rejection(openHeader(kek, forged, forged.slice()), type);
    }
    const same = await resealMeta(dek, header, encodeMeta(meta));
    expect((await openHeader(kek, same, same.slice())).meta).toEqual(meta);
  });

  it('checks the version before the scheme', async () => {
    const { kek, dek, meta, header } = await newStore();
    const plain = withMetaByte(meta, 1, 2);
    plain[2] = 9;
    plain[8] = 0xff;
    const forged = await resealMeta(dek, header, plain);
    const error = await rejection(openHeader(kek, forged, forged.slice()), UnsupportedFormatError);
    expect(error.message).toContain('version 2');
  });

  it('does not open the meta of one header beside the wrap of another: two stores under one key', async () => {
    const kek = await newKek();
    const a = (await createHeader(kek, { blockSize: 8192, keyId: 1 })).header;
    const b = (await createHeader(kek, { blockSize: 8192, keyId: 1 })).header;
    for (const [wrap, meta] of [
      [a, b],
      [b, a],
    ] as const) {
      const spliced = concat([wrap.subarray(0, 60), meta.subarray(60)]);
      await rejection(openHeader(kek, spliced, spliced.slice()), CorruptStoreError);
    }
  });

  it('does not open the meta of one header beside the wrap of another: one store before and after rewrapHeader', async () => {
    const { kek, header: before } = await newStore();
    const kek2 = await newKek();
    const after = await rewrapHeader(kek, kek2, before);
    const newWrapOldMeta = concat([after.subarray(0, 60), before.subarray(60)]);
    await rejection(openHeader(kek2, newWrapOldMeta, newWrapOldMeta.slice()), CorruptStoreError);
    const oldWrapNewMeta = concat([before.subarray(0, 60), after.subarray(60)]);
    await rejection(openHeader(kek, oldWrapNewMeta, oldWrapNewMeta.slice()), CorruptStoreError);
  });

  it('does not open a root sealed under the record info of a pretend version 2', async () => {
    const { dek, meta, ctx } = await newStore();
    const body = encodeRoot(
      {
        gen: 1,
        encryptions: 1,
        state: 'ready',
        origin: '',
        fileCount: 0,
        dataBlocks: 0,
        tableDigest: new Uint8Array(32),
        manifest: new Uint8Array(32),
        tableIds: [],
      },
      meta.blockSize,
    );
    const sealUnder = async (info: string) => {
      const salt = randomBytes(16);
      const nonce = randomBytes(12);
      const key = await hkdf(dek, salt, info);
      const aad = concat([ascii('r'), meta.storeId, new Uint8Array([0, 0, 0, meta.keyId])]);
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, body);
      return concat([salt, nonce, new Uint8Array(ct)]);
    };
    expect(await openRoot(ctx, await sealUnder('pglite-cipher/v1/record'))).toEqual(body);
    await rejection(openRoot(ctx, await sealUnder('pglite-cipher/v2/record')), CorruptStoreError);
    expect(await openRoot(ctx, await sealRoot(ctx, body))).toEqual(body);
  });
});
