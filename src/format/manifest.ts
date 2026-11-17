// The two whole-store digests in the root (FORMAT.md section 8). Both are SHA-256 over record tags;
// the root's own AEAD protects them, so no MAC key is needed.
import { compareBytes, concat, u32, type Bytes } from './bytes.ts';

const sha256 = async (data: Bytes): Promise<Bytes> =>
  new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));

export const computeTableDigest = (tags: readonly Uint8Array[]): Promise<Bytes> => sha256(concat(tags));

// SHA-256 of `fileId ‖ blocks (u32 BE) ‖ tag16 × blocks` per regular file, ascending `fileId`; `blockTags` is in index order.
export const computeManifest = (files: Iterable<{ fileId: Uint8Array; blockTags: Uint8Array }>): Promise<Bytes> => {
  const sorted = [...files].sort((a, b) => compareBytes(a.fileId, b.fileId));
  const parts: Uint8Array[] = [];
  for (const { fileId, blockTags } of sorted) {
    if (blockTags.length % 16 !== 0) throw new RangeError('blockTags is not a whole number of tags');
    parts.push(fileId, u32(blockTags.length / 16), blockTags);
  }
  return sha256(concat(parts));
};
