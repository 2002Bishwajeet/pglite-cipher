# Compared to other options

Other ways to keep an embedded database encrypted in a browser or webview, as of November 2026. All of them, pglite-cipher included, hold plaintext in memory while the database is open; they differ in how much, where the key lives, and what the stored bytes give away.

| | Engine | What is encrypted | Crypto | Key while open | Plaintext in memory |
|---|---|---|---|---|---|
| **pglite-cipher** | Postgres (PGlite) | every file under PGDATA, with names, sizes and file count hidden; tampering detected at open | AES-256-GCM, WebCrypto | non-extractable `CryptoKey` | the whole database |
| PGlite `idb://` | Postgres (PGlite) | nothing | none | n/a | the whole database |
| [pglite-encrypted-fs](https://github.com/davidmuggleton/pglite-encrypted-fs) | Postgres (PGlite), Node only | page contents; file names and several PGDATA files stay readable; not crash-atomic | AES-256-GCM, Node `crypto` | key bytes in the heap | pages in use |
| SQLite WASM with [SQLite3 Multiple Ciphers](https://github.com/utelle/SQLite3MultipleCiphers) (as in PowerSync, Notesnook) | SQLite | every page except a small header | ChaCha20-Poly1305 by default, compiled into WASM | key bytes in WASM memory | the page cache |
| [Evolu `sqlite-wasm`](https://github.com/evoluhq/evolu) | SQLite | every page (SQLCipher 4 format) | AES-256-CBC + HMAC-SHA512, compiled into WASM | key bytes in WASM memory | the page cache |
| Field-level encryption in IndexedDB (RxDB encryption, dexie-encrypted) | none (key-value) | chosen field values; keys and indexed fields stay readable | varies | varies | decrypted records in use |

In short: of these, pglite-cipher is the only one that encrypts Postgres in a webview, hides the file layout, and keeps the key where JavaScript cannot read it, using the browser's own WebCrypto rather than crypto compiled into WASM. The costs are the whole database in memory while it is open and a full decrypt at open (the README compares pglite-cipher with SQLCipher row by row; [performance.md](performance.md) has the open-time numbers).
