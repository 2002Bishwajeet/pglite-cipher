# Format v1 reference store

`records.bin` is a whole store written by format v1 (`EncryptedFs`, 8 KB blocks), frozen when
v1 shipped, the way SQLCipher 5 ships `sqlcipher-5.0-testkey.db`. Every later version must open it:
`test/fs/reference.test.ts` does. Never regenerate it; a format change adds a new fixture next to it.

- **Test key** (published, not a secret): the 32 bytes `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` (hex), passed to `importKek`.
- **Known row:** `SELECT id, note FROM reference` gives `1, 'written by pglite-cipher format v1'`.
- **Layout of the file:** per record, u8 key length ‖ key in ASCII (`0`, `1`, `2` or a 32-character hex id) ‖ u32 big-endian value length ‖ value. `test/fs/recordFile.ts` reads it.
- **Made by** `node scripts/make-v1-reference.ts`. The databases `template0` and `template1` were dropped to keep the file small; PGlite's 16 MB WAL segment is most of its 25 MB.
