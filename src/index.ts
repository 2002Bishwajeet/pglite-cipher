// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0

export const VERSION = '0.1.2';
export const FORMAT_VERSION = 1;

export {
  CorruptStoreError,
  CryptoSelfTestError,
  IncompleteStoreError,
  KeyChangeUnknownError,
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
  type RotateOptions,
  type RotateProgress,
  type SyncStats,
} from './encryptedFs.ts';
export { verifyStore, type VerifyOptions, type VerifyProblem, type VerifyProgress, type VerifyReason, type VerifyResult } from './verify.ts';
export type { BlockId, CommitBatch, RecordKey, Slot, StorageBackend } from './backend/backend.ts';
export { IndexedDbBackend } from './backend/indexeddb.ts';
export { MemoryBackend } from './backend/memory.ts';
