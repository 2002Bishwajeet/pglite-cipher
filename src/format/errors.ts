// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// The errors the store reports. Messages name a record by its slot or block id, never a path, and
// never hold plaintext or key material.

/** The key opens neither header copy, and both copies are present and identical. */
export class WrongKeyError extends Error {
  override name = 'WrongKeyError';
}

export class CorruptStoreError extends Error {
  override name = 'CorruptStoreError';
}

/** The store was never completely written (no header, no root, or root still `populating`); `rotation` marks an interrupted rotation. */
export class IncompleteStoreError extends Error {
  override name = 'IncompleteStoreError';
  readonly rotation: boolean;

  constructor(message: string, { rotation = false }: { rotation?: boolean } = {}) {
    super(message);
    this.rotation = rotation;
  }
}

export class StoreMissingError extends Error {
  override name = 'StoreMissingError';
}

export class StoreExistsError extends Error {
  override name = 'StoreExistsError';
}

/** Another writer committed since this one last read the root. */
export class StaleWriterError extends Error {
  override name = 'StaleWriterError';
}

export class UnsupportedFormatError extends Error {
  override name = 'UnsupportedFormatError';
}

export class StoreFullError extends Error {
  override name = 'StoreFullError';
}

export class CryptoSelfTestError extends Error {
  override name = 'CryptoSelfTestError';
}

/** A `changeKey` commit failed and the header read-back was inconclusive: either key may open the store. */
export class KeyChangeUnknownError extends Error {
  override name = 'KeyChangeUnknownError';
}
