export const VERSION = '0.0.0';
export const FORMAT_VERSION = 1;

export {
  CorruptStoreError,
  CryptoSelfTestError,
  IncompleteStoreError,
  StaleWriterError,
  StoreExistsError,
  StoreFullError,
  StoreMissingError,
  UnsupportedFormatError,
  WrongKeyError,
} from './format/errors.ts';

export type { BlockSize } from './format/codec.ts';
export { importKek } from './format/keys.ts';
export {
  EncryptedFs,
  type EncryptedFsOptions,
  type EncryptedFsStats,
  type OpenMode,
  type OpenProgress,
  type SyncStats,
} from './encryptedFs.ts';
export type { BlockId, CommitBatch, RecordKey, Slot, StorageBackend } from './backend/backend.ts';
export { IndexedDbBackend } from './backend/indexeddb.ts';
export { MemoryBackend } from './backend/memory.ts';
