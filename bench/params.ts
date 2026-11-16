// Parsing of the bench page's query parameters (kept apart from bench.ts, which needs a browser).
import { DEFAULT_BLOCK_SIZE, isBlockSize, type BlockSize } from '../src/format/codec.ts';

/** `?block=`: absent or empty is the default (#73); anything else must be one of BLOCK_SIZES. */
export function parseBlockSize(raw: string | null): BlockSize {
  if (raw === null || raw === '') return DEFAULT_BLOCK_SIZE;
  const n = Number(raw);
  if (!isBlockSize(n)) throw new Error(`?block=${raw} is not a supported block size`);
  return n;
}
