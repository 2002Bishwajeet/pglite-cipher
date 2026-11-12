// The store behind the encrypted filesystem. A backend sees keys and opaque bytes only: three fixed
// slots and a flat set of blocks under random ids. It never holds a key, never decrypts, and cannot
// tell which file a block belongs to, so it has no file ids, no block indexes and no range deletes.
import { equalBytes } from '../format/bytes.ts';

/** 16 random bytes as 32 lowercase hex characters. */
export type BlockId = string;
/** 0 and 1: the header copies. 2: the root. */
export type Slot = 0 | 1 | 2;
export type RecordKey = Slot | BlockId;

export interface CommitBatch {
  /** Abort unless the stored value of slot 2 equals this, byte for byte. null = must be absent. undefined = no check. */
  expectRoot?: Uint8Array | null;
  puts: Array<[RecordKey, Uint8Array]>;
  /** Deleting a key that is not there is not an error. */
  deletes: RecordKey[];
  durability: 'relaxed' | 'strict';
}

export interface StorageBackend {
  /** Zero records of any kind. */
  isEmpty(): Promise<boolean>;
  /** Slots and blocks together. */
  count(): Promise<number>;
  get(slot: Slot): Promise<Uint8Array | undefined>;
  /** One read for many blocks; the result has the order of `ids`, with undefined for a missing one. */
  getMany(ids: BlockId[]): Promise<Array<Uint8Array | undefined>>;
  /** Blocks only, never the slots. Ascending id order, at most `limit` per page; resume with `after`. */
  readRange(after: BlockId | null, limit: number): Promise<Array<[BlockId, Uint8Array]>>;
  /** All or nothing. Deletes run before puts. Rejects with StaleWriterError when expectRoot does not match. */
  commit(batch: CommitBatch): Promise<void>;
  /** Removes every record. */
  clear(): Promise<void>;
  /** Optional: removes the storage itself (IndexedDB: the database). The backend stays usable and starts empty. */
  destroy?(): Promise<void>;
  close(): Promise<void>;
}

/** The root slot, the one `expectRoot` checks. */
export const ROOT: Slot = 2;

const BLOCK_ID = /^[0-9a-f]{32}$/;

/** A slot number or a well-formed block id. Anything else is refused, so a backend stores nothing else. */
export const isRecordKey = (key: unknown): key is RecordKey =>
  key === 0 || key === 1 || key === 2 || (typeof key === 'string' && BLOCK_ID.test(key));

/** The error a commit rejects with for a key that is neither a slot nor a block id. */
export const invalidKey = (): TypeError => new TypeError('commit: a key is neither a slot nor a block id');

/** Whether the stored root satisfies a batch's `expectRoot`. Plain byte comparison. */
export const rootMatches = (stored: Uint8Array | undefined, expected: Uint8Array | null | undefined): boolean => {
  if (expected === undefined) return true;
  if (expected === null) return stored === undefined;
  return stored !== undefined && equalBytes(stored, expected);
};
