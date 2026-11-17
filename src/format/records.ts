// Sealing and opening the root, table blocks and data blocks (FORMAT.md section 5): every value is
// `salt16 ‖ nonce12 ‖ AES-256-GCM(subkey, blockSize bytes) ‖ tag16`, `44 + blockSize` bytes.
import { concat, randomBytes, toHex, u32, type Bytes } from './bytes.ts';
import type { Meta } from './codec.ts';
import { CorruptStoreError } from './errors.ts';
import type { SubkeyCache } from './keys.ts';

export const SEALED_OVERHEAD = 44;

export interface RecordContext {
  readonly subkeys: SubkeyCache;
  readonly meta: Meta;
  /** Attempted encryptions under this DEK; every `seal*` counts before it encrypts. */
  encryptions: number;
}

const TYPE_ROOT = 0x72; // "r"
const TYPE_TABLE = 0x74; // "t"
const TYPE_BLOCK = 0x62; // "b"

const aad = (type: number, meta: Meta, tail: Uint8Array[]): Bytes =>
  concat([Uint8Array.of(type), meta.storeId, u32(meta.keyId), ...tail]);

const seal = async (ctx: RecordContext, body: Bytes, additionalData: Bytes): Promise<Bytes> => {
  const { blockSize } = ctx.meta;
  if (body.length > blockSize) throw new RangeError('a record body is longer than the block size');
  let plain = body;
  if (body.length < blockSize) {
    plain = new Uint8Array(blockSize);
    plain.set(body);
  }
  ctx.encryptions++;
  const { key, salt } = await ctx.subkeys.current();
  const nonce = randomBytes(12);
  const sealed = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData }, key, plain);
  const out = new Uint8Array(SEALED_OVERHEAD + blockSize);
  out.set(salt, 0);
  out.set(nonce, 16);
  out.set(new Uint8Array(sealed), 28);
  return out;
};

/** Any failure is CorruptStoreError naming the record by slot or block id only. */
const open = async (ctx: RecordContext, sealed: Bytes, additionalData: Bytes, record: string): Promise<Bytes> => {
  if (sealed.length !== SEALED_OVERHEAD + ctx.meta.blockSize) throw new CorruptStoreError(`${record}: wrong length`);
  try {
    const key = await ctx.subkeys.forSalt(sealed.slice(0, 16));
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.subarray(16, 28), additionalData },
      key,
      sealed.subarray(28),
    );
    return new Uint8Array(plain);
  } catch {
    throw new CorruptStoreError(`${record}: does not open`);
  }
};

/** A data block: AAD `"b" ‖ storeId ‖ keyId ‖ fileId ‖ index`. */
export const sealBlock = (ctx: RecordContext, fileId: Bytes, index: number, body: Bytes): Promise<Bytes> =>
  seal(ctx, body, aad(TYPE_BLOCK, ctx.meta, [fileId, u32(index)]));

export const openBlock = (
  ctx: RecordContext,
  blockId: Bytes,
  fileId: Bytes,
  index: number,
  sealed: Bytes,
): Promise<Bytes> => open(ctx, sealed, aad(TYPE_BLOCK, ctx.meta, [fileId, u32(index)]), `block ${toHex(blockId)}`);

/** A file-table block: AAD `"t" ‖ storeId ‖ keyId ‖ blockId`. */
export const sealTable = (ctx: RecordContext, blockId: Bytes, body: Bytes): Promise<Bytes> =>
  seal(ctx, body, aad(TYPE_TABLE, ctx.meta, [blockId]));

export const openTable = (ctx: RecordContext, blockId: Bytes, sealed: Bytes): Promise<Bytes> =>
  open(ctx, sealed, aad(TYPE_TABLE, ctx.meta, [blockId]), `table block ${toHex(blockId)}`);

/** The root, key `2`: AAD `"r" ‖ storeId ‖ keyId`. */
export const sealRoot = (ctx: RecordContext, body: Bytes): Promise<Bytes> =>
  seal(ctx, body, aad(TYPE_ROOT, ctx.meta, []));

export const openRoot = (ctx: RecordContext, sealed: Bytes): Promise<Bytes> =>
  open(ctx, sealed, aad(TYPE_ROOT, ctx.meta, []), 'root (slot 2)');

/** The writer draws again if the id is already live. */
export const newBlockId = (): Bytes => randomBytes(16);

export const tagOf = (sealed: Bytes): Bytes => sealed.subarray(sealed.length - 16);
