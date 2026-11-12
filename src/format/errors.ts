// The errors the store reports. Messages name a record by its slot or block id, never a path, and
// never hold plaintext or key material.

/** The key opens neither header copy, and both copies are present and identical. */
export class WrongKeyError extends Error {
  override name = 'WrongKeyError';
}

/** A record failed its tag, a body failed to decode, or the file table is inconsistent. */
export class CorruptStoreError extends Error {
  override name = 'CorruptStoreError';
}

/** The store has records but no header. */
export class IncompleteStoreError extends Error {
  override name = 'IncompleteStoreError';
}

/** Another writer committed since this one last read the root. */
export class StaleWriterError extends Error {
  override name = 'StaleWriterError';
}

/** The header opened, but names a version, cipher, KDF or subkey scheme this reader does not know. */
export class UnsupportedFormatError extends Error {
  override name = 'UnsupportedFormatError';
}

/** A write would pass the format's limit on table blocks or on ids in a run. */
export class StoreFullError extends Error {
  override name = 'StoreFullError';
}

/** WebCrypto on this platform computes something other than the known answer. */
export class CryptoSelfTestError extends Error {
  override name = 'CryptoSelfTestError';
}
