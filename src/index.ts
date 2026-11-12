export const VERSION = '0.0.0';
export const FORMAT_VERSION = 1;

export {
  CorruptStoreError,
  CryptoSelfTestError,
  IncompleteStoreError,
  StaleWriterError,
  StoreFullError,
  UnsupportedFormatError,
  WrongKeyError,
} from './format/errors.ts';

export type { BlockId, CommitBatch, RecordKey, Slot, StorageBackend } from './backend/backend.ts';
export { IndexedDbBackend } from './backend/indexeddb.ts';
export { MemoryBackend } from './backend/memory.ts';
