// The store behind the encrypted filesystem: three fixed slots plus blocks under random ids. A backend sees keys and
// opaque bytes only: no key, no decryption, no file ids.
import { equalBytes } from '../format/bytes.ts';

export type BlockId = string;
/** 0 and 1: the header copies. 2: the root. */
export type Slot = 0 | 1 | 2;
export type RecordKey = Slot | BlockId;

export interface CommitBatch {
  /** Abort unless slot 2 equals this byte for byte; null = must be absent, undefined = no check. */
  expectRoot?: Uint8Array | null;
  puts: Array<[RecordKey, Uint8Array]>;
  /** Deleting a key that is not there is not an error. */
  deletes: RecordKey[];
  durability: 'relaxed' | 'strict';
}

export interface StorageBackend {
  isEmpty(): Promise<boolean>;
  count(): Promise<number>;
  get(slot: Slot): Promise<Uint8Array | undefined>;
  /** Follows the order of `ids`; undefined for a missing block. */
  getMany(ids: BlockId[]): Promise<Array<Uint8Array | undefined>>;
  /** Blocks only, ascending, at most `limit` per page; resume with `after`. */
  readRange(after: BlockId | null, limit: number): Promise<Array<[BlockId, Uint8Array]>>;
  /** All or nothing; deletes run before puts. Rejects with StaleWriterError when expectRoot mismatches. */
  commit(batch: CommitBatch): Promise<void>;
  clear(): Promise<void>;
  /** Optional: removes the storage itself (IndexedDB: the database); the backend stays usable, empty. */
  destroy?(): Promise<void>;
  close(): Promise<void>;
}

export const ROOT: Slot = 2;

const BLOCK_ID = /^[0-9a-f]{32}$/;

// A slot number or well-formed block id; a backend stores nothing else.
export const isRecordKey = (key: unknown): key is RecordKey =>
  key === 0 || key === 1 || key === 2 || (typeof key === 'string' && BLOCK_ID.test(key));

export const invalidKey = (): TypeError => new TypeError('commit: a key is neither a slot nor a block id');

export const rootMatches = (stored: Uint8Array | undefined, expected: Uint8Array | null | undefined): boolean => {
  if (expected === undefined) return true;
  if (expected === null) return stored === undefined;
  return stored !== undefined && equalBytes(stored, expected);
};
