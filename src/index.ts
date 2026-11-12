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
