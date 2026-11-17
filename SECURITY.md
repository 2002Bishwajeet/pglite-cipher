# Security

pglite-cipher encrypts a PGlite database at rest: every file under PGDATA is cut into blocks,
each block is sealed with AES-256-GCM through WebCrypto, and the blocks are stored in IndexedDB.
`FORMAT.md` is the exact format; this file says what that design claims and what it does not.

**Status, as of 2026-11-17 (0.1.0, the first public release):** new code. It has had no external
audit or review. The composition has not been FIPS validated, and no FIPS-validated build exists. Only
standard primitives are used, all through WebCrypto; no cryptography is written by hand or taken
from a third-party package.

## Threat model

The attacker has a copy of the stored files (a copy of the browser or webview profile, a backup,
a stolen disk) and does not have the key-encryption key (KEK) the application passes in.

### What they learn

In the words of `FORMAT.md` section 10: that an IndexedDB database (or a file) exists; the number
of block records and their common length, so the block size and the total size to the block; and
write timing, which is two things: which records changed between two looks at the store, and,
inside one copy, which records were last written in the same session, because a session's records
carry the same 16-byte salt.

### What they do not learn

The format, its version, the application, the number of files, any file's name, size or mode, or
which block belongs to which file. No byte and no name says that the store is a pglite-cipher
store. Someone who knows `FORMAT.md` can recognise its shape (two 168-byte values, the rest of one
length), as someone who knows SQLCipher can guess at a high-entropy file whose length is a multiple
of the page size.

### What they cannot do unnoticed

Every open decrypts and checks every record. A modified, truncated, swapped, moved, added, deleted
or replayed block, a deleted file, a changed file table, and a changed or downgraded version or
cipher all fail the open with `CorruptStoreError` (or `UnsupportedFormatError`), and nothing is
loaded. A data block's AAD names its file and index, so it cannot stand in for another block; two
SHA-256 digests in the authenticated root cover the current tag of every record, so an older valid
copy of one record is caught too. `verify()` runs the same checks on demand.

### What is not protected

- **Whole-store rollback is not detected.** An older complete copy of the store is valid in every
  byte and opens, with its older data. Catching it would need a counter outside the store, and a
  relaxed sync lost in a crash would then look like an attack.
- **Memory is plain text.** While the database is open, all of it is plaintext in the page's or
  worker's memory, as it is without encryption. Keys are non-extractable `CryptoKey`s, but
  JavaScript cannot lock or wipe memory. The raw KEK passes through the heap once (`importKek`
  zeroes it afterwards).
- **No passphrase KDF.** The KEK is 32 random bytes, normally from the OS keychain. There is no
  PBKDF2 or Argon2 in this package; a passphrase must not be passed in as a key.
- **Not FIPS validated**, and no external audit, as of the date above.
- **Software running as the same user** while the database is open can read it, as it can read the
  key from the keychain on platforms that allow that.
- **Exports are plaintext**: `dumpTar`, `pg.dumpDataDir()` and `pg_dump` output.
- **Two header copies damaged identically** read as a wrong key (`WrongKeyError`), not as damage
  (`FORMAT.md` section 11).

## Primitives and where each is used

| Primitive (WebCrypto) | Used for | `FORMAT.md` |
| --- | --- | --- |
| AES-256-GCM, 12-byte random nonce, 16-byte tag | wrapping the data key (DEK) under the KEK (`WRAP_AAD`) | 4 |
| AES-256-GCM | the header's meta envelope (version, cipher, block size, store id, key id) under the header key | 4 |
| AES-256-GCM | every record: the root, each file-table block, each data block, under a session subkey, with the record's AAD (type, store id, key id, and the block id or the file id and index) | 5 |
| HKDF-SHA256 | the header key (`DEK`, `metaSalt`, `HEADER_LABEL`) and each session subkey (`DEK`, a 16-byte salt, `RECORD_INFO`) | 2, 4, 5 |
| SHA-256 | the two digests in the root: `tableDigest` over the table-block tags, `manifest` over every file's data-block tags | 8 |
| `crypto.getRandomValues` | the DEK, every nonce and salt, the store id, file ids and block ids | 2 |

At every open the package checks WebCrypto against known answers first (`CryptoSelfTestError`).

## Session subkeys, and why no rotation is forced

The DEK never encrypts a record itself. Each writer session draws a random 16-byte salt and
derives one AES-256-GCM subkey from the DEK with HKDF-SHA256; every record it writes carries the
salt, and after 2^24 encryptions it draws a new one. With random 96-bit nonces and at most 2^24
uses per subkey, the chance of a nonce collision is about 2^-49 per subkey, far below the NIST SP
800-38D bound, and the DEK has no lifetime limit. SQLCipher 5 does the same per page write; one
derivation per session is what WebCrypto can afford. The cost is the salt grouping above.

So nothing forces a key rotation. Rotate for one reason: the KEK, or an old copy of the header,
may have been exposed. `changeKey(newKek)` re-wraps the DEK at once; anyone who kept the old
header and the old KEK can still read later copies. `rotateDataKey()` draws a new DEK and re-seals
every record into a fresh store, which defeats a copied header. After a suspected exposure, do
both.

## Reporting a vulnerability

Report it privately: open a private security advisory on this repository (GitHub, **Security**,
**Report a vulnerability**), or, if that is not available to you, contact the repository owner
directly. Do not open a public issue. Include the version or commit, the engine and platform, and
the steps or the store that shows the problem. Never send a real key, a passphrase or a store that
holds personal data; a store made with a throwaway key is enough.
