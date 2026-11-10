<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-05).
Title: On-disk format v1 and the crypto core (records, headers, keys, session subkeys, manifest digest)
Labels: agent-ready, security
Origin: 2002Bishwajeet/journal#553 ("Design", "Key", tamper criteria). Resolves review findings S1, S2, S3, the S9 package parts, and the nits on the DEK and the write counter. Folds in prior art (docs/research/2026-11-10-prior-art.md): SQLCipher 5's per-write subkeys, the frozen reference store, the open-time self-test, the independent decoder.
-->
## Context
`pglite-cipher` is a PGlite filesystem that stores the Postgres data directory encrypted, in the manner of SQLCipher: a fixed-size unit, fresh randomness on every write, an integrity tag bound to the unit's position. This issue is the part with no PGlite and no IndexedDB in it: the byte format and the pure functions that seal and open records. Everything else in the package calls these functions, and the format is frozen once this ships, so the tests here are the strictest in the plan.

The owner's decisions from the spike are in the closing comment of #<PC-04> (`Block size:` line). Use that block size as the default; the format carries the size in the header, so all three sizes must work.

Design decisions already made (do not reopen):
- AES-256-GCM through WebCrypto. No deterministic nonces, no counters as nonces.
- Two key tiers: the caller's key (KEK) wraps a random data key (DEK).
- **The DEK never encrypts data directly. Each session derives a subkey from it** (below). This is the WebCrypto-sized version of what SQLCipher 5.0.0-beta.1 does per page write (a one-time subkey from random context, "modeled after XAES-256-GCM") to escape the NIST SP 800-38D limit of 2^32 random-nonce encryptions per key. A subkey per record would cost four WebCrypto calls per block; a subkey per session costs one call per session and gives the same result: no key ever comes near the limit, and data-key rotation is an option, not a safety requirement.
- The package has no passphrase KDF. `kdf` is always `"raw"`.
- Integrity covers the whole store through a **manifest digest**, not only single records.

## Change
The repository scaffold exists (#<PC-02>): TypeScript, vitest in Node and in three browsers, `fast-check`, `fake-indexeddb`. Source goes in `src/format/`, tests in `test/format/`, the specification in `FORMAT.md` at the repository root.

### Format v1 (write it down in `FORMAT.md` first, then implement to it)

Record keys are arrays, so IndexedDB orders them and range queries work. Values are `Uint8Array`.

Every sealed value has one shape: `salt16 ‖ nonce12 ‖ ciphertext ‖ tag16`, encrypted with AES-256-GCM under the **subkey** `HKDF-SHA256(key = DEK, salt = salt16, info = "pglite-cipher/v1/record")`.

| Record | Key | Sealed plaintext | AAD |
|---|---|---|---|
| Static header, copy 0 and 1 | `["h", 0]`, `["h", 1]` | Not sealed: canonical bytes of `{ magic: "PGLCIPHR", v: 1, cipher: "AES-256-GCM", kdf: "raw", subkey: "HKDF-SHA256/session", blockSize, storeId (16 random bytes), keyId (u32), wrappedDek }` | – |
| Mutable header | `["m"]` | `{ gen (u64), encryptions (u64), manifest (32 bytes), fileCount (u32), state: "ready" \| "populating" \| "rotating", origin?: string }` | `"m" ‖ storeId ‖ keyId` |
| Inode | `["i", fileId]` | `{ path, type: file \| dir \| symlink, mode, size (u64), mtime (ms), blocks (u32), target? }` | `"i" ‖ storeId ‖ keyId ‖ fileId` |
| Block | `["b", fileId, index]` | The block's bytes, padded with zeros to exactly `blockSize` | `"b" ‖ storeId ‖ keyId ‖ fileId ‖ index (u32 BE)` |

Rules:
1. `fileId` is 16 random bytes chosen when a file is created; it never changes on rename. Paths exist only inside inode bodies. In record keys it is written as 32 lowercase hex characters (string keys order the same way as the bytes and work in every IndexedDB); in AAD and in the manifest it is the 16 raw bytes.
2. **Every block value has the same length** (`16 + 12 + blockSize + 16`), whatever the file's size. The true size is in the inode (review S3).
3. **Session subkeys.** When a filesystem instance opens for writing it draws one random `salt16` and derives one subkey (`crypto.subtle.deriveKey`, non-extractable, `["encrypt", "decrypt"]`). Every record it writes carries that salt. After `SUBKEY_MAX_ENCRYPTIONS = 2 ** 24` encryptions under one subkey it draws a new salt. A reader derives a subkey once per distinct salt it meets and caches it. With random 96-bit nonces and at most 2^24 uses per subkey, the collision chance per subkey is about 2^-49; no lifetime cap applies to the DEK.
4. `wrappedDek` = `nonce12 ‖ GCM(KEK, dek32) ‖ tag16` with AAD = the canonical bytes of every other static field. A changed `v`, `cipher`, `blockSize` or `storeId` makes the unwrap fail (review S2). There is no separate key-check value.
5. The two header copies are byte-identical. A reader takes the first copy that parses and unwraps; if exactly one is damaged, it reports `headerRepairNeeded: true` so the next sync rewrites both.
6. **Manifest digest:** `SHA-256` over, for every inode in ascending `fileId` byte order: `fileId ‖ inodeTag16 ‖ blocks (u32 BE) ‖ blockTag16 × blocks` (block tags in index order), where a tag is the last 16 bytes of the stored value. The digest lives in the mutable header, which is itself AEAD-protected, so no MAC key is needed. It changes when any record is modified, deleted, added or replaced by an older valid version of itself (review S1). It does not detect the whole store being replaced by an older copy; `FORMAT.md` says so.
7. Body encoding is a fixed binary layout (length-prefixed fields in a fixed order), not JSON, so two implementations produce the same bytes. Document every field's width and endianness in `FORMAT.md`.
8. `encryptions` counts every **attempted** record encryption under the current DEK, including ones whose transaction later failed. It is telemetry (shown in `stats()`), not a limit.

### Code (`src/format/`)
- `codec.ts`: encode/decode of the static header, mutable header body and inode body. Decoders reject trailing bytes, unknown `v`, `cipher` or `subkey`, a `blockSize` not in {8192, 32768, 65536}, and lengths that run past the buffer. They never throw anything but `CorruptStoreError` or `UnsupportedFormatError`.
- `keys.ts`:
  - `importKek(raw: Uint8Array): Promise<CryptoKey>`: AES-GCM, non-extractable, usages `["wrapKey", "unwrapKey"]` only; fills `raw` with zeros before returning. Callers may also pass their own `CryptoKey` with those usages.
  - `createDek(kek, staticFields)`: 32 random bytes → import as an extractable temporary AES-GCM key → `wrapKey("raw", …)` → import the same bytes as an **HKDF** key (`["deriveKey"]`, never extractable) → zero the bytes. Returns `{ dek, wrappedDek }`.
  - `unwrapDek(kek, wrappedDek, staticFields)`: `unwrapKey` straight into a non-extractable HKDF key. A tag failure throws `WrongKeyError`.
  - `rewrapDek(oldKek, newKek, wrappedDek, staticFields)`: unwrap as an extractable temporary key, wrap under the new key, return the new `wrappedDek`. The temporary key is not kept.
  - `SubkeyCache(dek)`: `forSalt(salt)` derives on first use and caches by salt; `current()` returns the writing subkey and its salt, rolling to a new salt at `SUBKEY_MAX_ENCRYPTIONS`.
- `records.ts`: `sealBlock`, `openBlock`, `sealInode`, `openInode`, `sealMutable`, `openMutable`. Each `seal*` increments the counters before calling WebCrypto. `open*` maps any WebCrypto failure to `CorruptStoreError` with the record key in the message and never includes plaintext or key material.
- `manifest.ts`: `computeManifest(files: Iterable<{ fileId, inodeTag, blockTags: Uint8Array }>): Promise<Uint8Array>`.
- `selfTest.ts`: `selfTest()`: a fixed-key known-answer check of HKDF → AES-GCM seal → open against constants in the source, run once per process before the first real operation. Webview crypto differs by platform; a webview that computes something else must fail here, loudly, with `CryptoSelfTestError`, not write a store nobody can read.
- `errors.ts`: `WrongKeyError`, `CorruptStoreError`, `IncompleteStoreError`, `StaleWriterError`, `UnsupportedFormatError`, `CryptoSelfTestError`. Export all from `src/index.ts`.

### Tests (`test/format/*.test.ts`; they run in Node and, through `npm run test:browser`, in Chromium, Firefox and WebKit, except the `node:crypto` one)
- **Known-answer vectors:** `test/format/vectors.json` with fixed KEK, DEK, salts, nonces, and the expected bytes of one static header, mutable header, inode and block. Generated once with a test helper that injects salts and nonces; the committed file is the regression lock.
- **Independent decoder:** `test/format/independent.test.ts` opens the vectors with `node:crypto` only (`hkdfSync`, `createDecipheriv("aes-256-gcm")`), written from `FORMAT.md` without importing anything from `src/format/`. This proves the document is enough to read a store, and catches the class of bug where two implementations agree with themselves and not with each other (sqlite3mc 2.6.0's ChaCha20 counter bug decrypted silently to wrong data).
- **Property tests (fast-check):** seal→open round-trips for random bodies and all three block sizes; any single-bit flip in a value (salt, nonce, ciphertext or tag) makes `open*` throw `CorruptStoreError`; opening a record under another `fileId`, `index`, `storeId` or `keyId` throws; the manifest changes when any one tag changes, a file is removed, a block is removed, or two blocks of one file swap.
- **Decoder fuzz:** 20,000 random and mutated buffers into every decoder: the only outcomes are a value or one of the two documented errors; never another exception, never a hang (per-case budget 50 ms).
- **Key tests:** `importKek` zeroes its input and the key's `usages` are exactly `wrapKey`, `unwrapKey`; the DEK is an HKDF key and not extractable; subkeys are not extractable; a wrong KEK gives `WrongKeyError`; a changed `blockSize` in the header gives `WrongKeyError`; `rewrapDek` output opens with the new key and not the old.
- **Subkeys:** two sessions use different salts; the cache derives once per salt (spy on `deriveKey`); with `SUBKEY_MAX_ENCRYPTIONS` lowered by a test hook, the salt rolls and both old and new records open; salts and nonces never repeat across 100,000 seals.
- **Header copies:** damage copy 0 → reads from copy 1 with `headerRepairNeeded`; damage both → `CorruptStoreError`.
- **Self-test:** passes on Node; with WebCrypto's `encrypt` stubbed to return altered bytes it throws `CryptoSelfTestError`.
- **No plaintext, no secrets in errors:** a marker string sealed in a block does not appear in any sealed value or in any error message produced by the tamper tests.

## Verification
- `~/.claude/bin/heavy npx vitest run src/format` passes, including the vectors, the independent decoder, property, fuzz, key and subkey tests above.
- `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0.
- `FORMAT.md` exists and specifies every record byte for byte, with a "Prior art" paragraph naming SQLCipher 4, SQLCipher 5.0.0-beta.1 (per-write subkeys), XAES-256-GCM (C2SP) and gocryptfs (random file id and block number as AAD), and a "Not detected" paragraph (whole-store rollback).

## STOP and comment on the issue if
- #<PC-04> is not closed with `Go: yes` and a `Block size:` line.
- WebCrypto in Node 22+, in one of the three CI browsers, or in a target webview (per the spike's G6 results) lacks HKDF `deriveKey` to AES-GCM, or `wrapKey`/`unwrapKey` for AES-GCM with the raw format, or cannot unwrap into an HKDF key. Report which and where. The fallback is `HMAC-SHA256(DEK, salt)` as the subkey through `sign` + `importKey`, which puts subkey bytes in the JS heap: say so and wait for a decision.
- The spike measured more distinct session salts in a long-lived store than the open-time gate can pay for (one `deriveKey` per salt). Report the count.
- You find you need a dependency for crypto. The design uses WebCrypto only.
- Any part of the format seems to need a deterministic nonce or a counter nonce.

## Metadata
Depends on: #<PC-04>
Size: M
Area: db, security
Model: opus
Effort: xhigh
