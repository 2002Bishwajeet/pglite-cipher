// Parsing of the bench page's query parameters (kept apart from bench.ts, which needs a browser).
import { DEFAULT_BLOCK_SIZE, isBlockSize, type BlockSize } from '../src/format/codec.ts';

/** `?block=`: absent or empty is the default; anything else must be one of BLOCK_SIZES. */
export function parseBlockSize(raw: string | null): BlockSize {
  if (raw === null || raw === '') return DEFAULT_BLOCK_SIZE;
  const n = Number(raw);
  if (!isBlockSize(n)) throw new Error(`?block=${raw} is not a supported block size`);
  return n;
}

const PACKS: readonly number[] = [1, 4, 8, 16];

/** `?pack=`: blocks per IndexedDB record (bench/patches/pack.patch); absent or empty is 1, the unpatched layout. */
export function parsePack(raw: string | null): number {
  if (raw === null || raw === '') return 1;
  const n = Number(raw);
  if (!PACKS.includes(n)) throw new Error(`?pack=${raw} is not one of ${PACKS.join(', ')}`);
  return n;
}
