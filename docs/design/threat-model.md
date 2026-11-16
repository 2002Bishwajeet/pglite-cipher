# Threat model, summarised

`SECURITY.md` is the full text, with the primitives and how to report a vulnerability. This page is
the short version.

## Who the attacker is

Someone who has a copy of the stored files (a copy of the browser or webview profile, a backup, a
stolen disk) and does not have the KEK the application passes in.

## What they learn

- that a database exists (an IndexedDB database with the name the app chose);
- the number of block records and their common length, so the block size and the total size of
  the store to the block;
- write timing: which records changed between two copies, and, within one copy, which records were
  last written in the same writer session, because those share a 16-byte salt.

## What they do not learn

The format, its version, the application, the number of files, any file's name, size or mode, or
which block belongs to which file. No byte and no name says it is a pglite-cipher store. See
[format.md](format.md) for why.

## What they cannot do unnoticed

Modify, truncate, swap, move, add, delete or replay a block; delete a file; change the file table;
change or downgrade the version or cipher. Each fails the next open with `CorruptStoreError` (or
`UnsupportedFormatError`), and nothing is loaded. See [integrity.md](integrity.md).

## What is not protected

| Gap | Why |
|---|---|
| Whole-store rollback to an earlier full copy | That copy is valid in every byte. A counter outside the store would make a relaxed sync lost in a crash look like an attack |
| Memory while the database is open | All of it is plaintext in the page's or worker's memory, as without encryption. Keys are non-extractable `CryptoKey`s, but JavaScript cannot lock or reliably wipe memory. Close makes a best-effort wipe: it overwrites the data directory files in memory and the wasm memory with zeros, and `src/` zeroes the plaintext snapshot and block copies it owns once they are sealed, committed, requeued or copied (not the short-lived encodings of the file table and root). Copies the app made (query results), engine-internal copies and swap are not covered. The raw KEK passes through the heap once and is zeroed by `importKek` |
| Software running as the same user while the database is open | It can read memory, and on some platforms the key from the keychain |
| Passphrases | There is no PBKDF2 or Argon2 in the package; the KEK must be random key material |
| Exports | `dumpTar`, `pg.dumpDataDir()` and `pg_dump` output are plaintext by design |
| Temp storage outside the data directory | Only files under the data directory are encrypted; keep `temp_tablespaces` and tablespaces inside it |
| Two header copies damaged identically | Read as a wrong key, not as damage |

## Choices that follow from it

- **Raw keys only.** The intended KEK is a random key from the OS keychain. A passphrase KDF, if
  ever needed, belongs to the caller.
- **`changeKey` is cheap but limited;** `rotateDataKey` is the operation that defeats a copied old
  header. After a suspected exposure, do both. See [keys.md](keys.md).
- **Errors and stats carry no secrets.** Error messages name slots and block ids, never paths,
  keys or plaintext. `stats()` reports counts and timings only.
- **No claims beyond this.** The code is new, has had no external review, and the composition is
  not FIPS validated. Only standard primitives are used, all through WebCrypto; there is no
  hand-written or third-party cryptography and there are no runtime dependencies.
