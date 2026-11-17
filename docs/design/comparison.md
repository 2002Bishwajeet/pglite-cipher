# Compared to other options

Other ways to keep an embedded database encrypted in a browser or webview, as of November 2026. All of them, pglite-cipher included, hold plaintext in memory while the database is open; they differ in how much, where the key lives, and what the stored bytes give away.

| | Engine | What is encrypted | Crypto | Key while open | Plaintext in memory |
|---|---|---|---|---|---|
| **pglite-cipher** | Postgres (PGlite) | every file under PGDATA, with names, sizes and file count hidden; tampering detected at open | AES-256-GCM, WebCrypto | non-extractable `CryptoKey` | the whole database |
| [PGlite `idb://`](https://pglite.dev/docs/filesystems) | Postgres (PGlite) | no encryption is documented; each changed file is saved whole as a blob | none documented | n/a | the whole database |
| [pglite-encrypted-fs](https://github.com/davidmuggleton/pglite-encrypted-fs) | Postgres (PGlite), Node only | page contents, one file per PGDATA file; `.conf`, `PG_VERSION`, `postmaster.*` and a few other files are left unencrypted | AES-256-GCM, Node `crypto`, key from a PBKDF2 passphrase | key held in a Node `Buffer`; `destroy()` zeroes it, best effort | pages Postgres has loaded |
| SQLite WASM with [SQLite3 Multiple Ciphers](https://utelle.github.io/SQLite3MultipleCiphers/docs/ciphers/cipher_chacha20/) (the web builds of [PowerSync](https://github.com/powersync-ja/powersync-js/tree/main/packages/web) and [Notesnook](https://github.com/streetwriters/notesnook/blob/master/apps/web/src/common/sqlite/sqlite.worker.ts)) | SQLite | every page, with a Poly1305 tag per page; the file's first 16 bytes hold the salt | ChaCha20-Poly1305 is the library's default cipher and PowerSync's default, compiled into WASM | key held by the cipher inside the WASM | the page cache |
| [Evolu `sqlite-wasm`](https://github.com/evoluhq/evolu/blob/main/packages/sqlite-wasm/README.md) | SQLite | every page and rollback-journal record, in SQLCipher 4's page format | AES-256-CBC + HMAC-SHA512, Evolu's own C codec (BearSSL AES) compiled into WASM | key in WASM memory, shared with SQLite's heap | the page cache |
| [RxDB encryption](https://rxdb.info/encryption.html) | none (document store over IndexedDB and others) | the schema fields you list (and attachments, if set); encrypted fields cannot be indexed | AES via crypto-js (free plugin, unauthenticated CBC); WebCrypto AES-GCM in the premium plugin | a password you pass at `createRxDatabase()` | decrypted documents in use |
| [dexie-encrypted](https://github.com/dexie/dexie-encrypted) | none (IndexedDB through Dexie) | the tables and top-level fields you choose; indexes stay plain | TweetNaCl by default, or your own functions | a 32-byte `Uint8Array` you pass in | decrypted records in use |

In short: of these, pglite-cipher is the only one that encrypts Postgres in a webview, hides the file layout, and keeps the key where JavaScript cannot read it, using the browser's own WebCrypto rather than crypto compiled into WASM. The costs are the whole database in memory while it is open and a full decrypt at open (the README compares pglite-cipher with SQLCipher row by row; [performance.md](performance.md) has the open-time numbers).

## Compared to SQLCipher

The same idea, encryption underneath the database engine, adapted to Postgres in a webview, weaker rows included:

| | SQLCipher | pglite-cipher | Verdict |
|---|---|---|---|
| Cipher | v4: AES-256-CBC + HMAC-SHA512; v5 beta: AES-256-GCM | AES-256-GCM through WebCrypto | parity |
| Unit | one SQLite page (4 KB in v4) | one block of a Postgres file (64 KB by default), every file under PGDATA | parity; covers more files |
| Nonce and subkey | v5 beta: random IV and a one-time subkey per page write | random 96-bit nonce per record, under a subkey derived once per writer session (HKDF-SHA256) | parity by a cheaper route; a session's records share a salt |
| Header | 16-byte random salt, the rest encrypted | 168 bytes stored twice; only random nonces and salts are readable; version, cipher and block size inside an authenticated envelope | parity |
| What the stored bytes show | file size, which pages change | that a database exists, the total number of blocks, write timing (which records change, which were written in one session) | parity |
| What the tag binds | ciphertext, IV, page number | ciphertext, nonce, record type, store id, key id, file id and block index | stronger |
| What is detected | modified or swapped pages | also truncation, a replayed older block, a deleted file; every open checks every record. Neither detects a rollback of the whole store | stronger |
| Rekey | `PRAGMA rekey` re-encrypts every page | `changeKey` re-wraps the data key at once; `rotateDataKey` re-encrypts into a fresh store | stronger, but only `rotateDataKey` defeats a copied old header |
| Memory | page cache only; keys `mlock`ed and wiped | the whole database in memory, plus two pages of ciphertext while opening (about 64 MB at 64 KB blocks); JavaScript cannot lock or wipe keys | weaker, accepted |
| Open cost | random access, opens at once | decrypts everything at open (budget: 100 MB in 1.5 s on desktop, 3 s on the slowest phone; missed on Android Chrome: a 100 MB open took 8.6 s on a Redmi Note 5 Pro, see [the known limit](performance.md#known-limit-slow-encrypted-open-on-android-chrome)) | weaker, accepted |
| Passphrase | PBKDF2-HMAC-SHA512 | none: the key is 32 random bytes from the keychain | weaker if a passphrase is ever wanted |
| Compliance, maturity | FIPS-validated enterprise builds; in wide use since 2008 | not FIPS validated; new code, no external review yet | weaker |
