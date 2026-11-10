<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-05).
Title: On-disk format v1 and the crypto core (opaque header, packed block space, file table, keys, session subkeys, digests)
Labels: agent-ready, security
Origin: 2002Bishwajeet/journal#553 ("Design", "Key", tamper criteria). Resolves review findings S1, S2, S3, the S9 package parts, and the nits on the DEK and the write counter. Folds in prior art (docs/research/2026-11-10-prior-art.md): SQLCipher 5's per-write subkeys, the frozen reference store, the open-time self-test, the independent decoder. Owner decisions of 2026-11-10 after the first draft: the header is opaque, and the store is one packed space of blocks with an encrypted file table.
-->
## Context
`pglite-cipher` is a PGlite filesystem that stores the Postgres data directory encrypted, in the manner of SQLCipher: a fixed-size unit, fresh randomness on every write, an integrity tag bound to the unit's position, and nothing readable in the store except random bytes. This issue is the part with no PGlite and no IndexedDB in it: the byte format and the pure functions that seal and open records. Everything else in the package calls these functions, and the format is frozen once this ships, so the tests here are the strictest in the plan.

The owner's decisions from the spike are in the closing comment of #<PC-04> (`Block size:` line). Use that block size as the default; the format carries the size in the header, so all three sizes must work.

Design decisions already made (do not reopen):
- AES-256-GCM through WebCrypto. No deterministic nonces, no counters as nonces.
- Two key tiers: the caller's key (KEK) wraps a random data key (DEK).
- **The DEK never encrypts data directly. Each session derives a subkey from it** (below). This is the WebCrypto-sized version of what SQLCipher 5.0.0-beta.1 does per page write (a one-time subkey from random context, "modeled after XAES-256-GCM") to escape the NIST SP 800-38D limit of 2^32 random-nonce encryptions per key. A subkey per record would cost four WebCrypto calls per block; a subkey per session costs one call per session and gives the same result: no key ever comes near the limit, and data-key rotation is an option, not a safety requirement.
- The package has no passphrase KDF. `kdf` is always `"raw"`.
- Integrity covers the whole store through **two digests in the encrypted root**, not only single records.
- **Opaque header.** No byte in the store names the format, the version, the cipher or the application. A SQLCipher file shows a random salt and nothing else; this store shows random nonces and salts and nothing else. Version, cipher, block size, store id and key id are inside an AEAD envelope.
- **Packed block space.** The store does not keep one group of records per Postgres file. It keeps one flat space of equal-size encrypted blocks under random ids, and an encrypted file table that says which blocks make up which file. Someone with the files sees the total number of blocks and when they are written. They do not see how many files there are, how big each is, or which block belongs to which file.

## Change
The repository scaffold exists (#<PC-02>): TypeScript, vitest in Node and in three browsers, `fast-check`, `fake-indexeddb`. Source goes in `src/format/`, tests in `test/format/`, the specification in `FORMAT.md` at the repository root.

### Format v1 (write it down in `FORMAT.md` first, then implement to it)

The store is one key-value space with three fixed keys and any number of block ids. Values are `Uint8Array`.

| Record | Key | Stored value | Plaintext | AAD |
|---|---|---|---|---|
| Header, copy 0 and 1 | `0`, `1` | 168 bytes, layout below | – | below |
| Root | `2` | sealed | Root body, padded with zeros to `blockSize` | `"r" ‖ storeId ‖ keyId` |
| File-table block | a block id | sealed | Table entries, padded with zeros to `blockSize` | `"t" ‖ storeId ‖ keyId ‖ blockId` |
| Data block | a block id | sealed | The block's bytes, padded with zeros to `blockSize` | `"b" ‖ storeId ‖ keyId ‖ fileId ‖ index (u32 BE)` |

"Sealed" is one shape: `salt16 ‖ nonce12 ‖ ciphertext ‖ tag16`, AES-256-GCM under the **subkey** `HKDF-SHA256(key = DEK, salt = salt16, info = "pglite-cipher/v1/record")`. The root, every table block and every data block have the same stored length, `44 + blockSize`. In AAD, the record type is one ASCII byte, `storeId`, `fileId` and `blockId` are their 16 raw bytes, and `keyId` is a u32 BE. Labels and `info` strings are ASCII with no terminator. They are inputs to the cipher and are never stored.

#### Header (168 bytes, the same in both copies)

| Offset | Length | Content |
|---|---|---|
| 0 | 12 | `wrapNonce`, random |
| 12 | 32 | The DEK, encrypted with AES-256-GCM under the KEK. AAD = `"pglite-cipher/wrap"` |
| 44 | 16 | GCM tag of the wrap |
| 60 | 16 | `metaSalt`, random |
| 76 | 12 | `metaNonce`, random |
| 88 | 64 | `meta`, encrypted with AES-256-GCM under the **header key**. AAD = `"pglite-cipher/header" ‖ bytes 0–59 of this header` |
| 152 | 16 | GCM tag of the meta |

Header key = `HKDF-SHA256(key = DEK, salt = metaSalt, info = "pglite-cipher/header")`, an AES-256-GCM key that is not extractable.

`meta` plaintext (64 bytes):

| Offset | Length | Content |
|---|---|---|
| 0 | 2 | `v` (u16 BE) = 1 |
| 2 | 1 | `cipher`: 1 = AES-256-GCM |
| 3 | 1 | `kdf`: 0 = raw |
| 4 | 1 | `subkey`: 1 = HKDF-SHA256, one per session |
| 5 | 3 | zero |
| 8 | 4 | `blockSize` (u32 BE): 8192, 32768 or 65536 |
| 12 | 4 | `keyId` (u32 BE) |
| 16 | 16 | `storeId`, random |
| 32 | 32 | zero (reserved) |

Why two envelopes and not one. WebCrypto's `unwrapKey` turns the wrapped bytes straight into a key that JavaScript cannot read, which is what keeps the DEK out of the heap at every open (review S9). It cannot hand back anything else, so the parameters cannot travel in the same ciphertext as the DEK. They travel in a second envelope under a key derived from the DEK. Nobody without the KEK can make or change either part: the wrap needs the KEK, and the meta needs the DEK that only the wrap gives.

**How a reader finds the version.** It does not try layouts. It unwraps bytes 12–59 with the KEK, derives the header key, decrypts `meta`, and reads `v` from the plaintext. The alternative, unwrapping once per known version with that version's parameters as AAD, was rejected for three reasons:
1. A store written by a later version would fail every attempt, and that is indistinguishable from a wrong key. The app would tell the user the key is lost and offer to delete the data, when the real problem is an old app. With the version inside the envelope, an old reader says `UnsupportedFormatError`.
2. The attempts multiply: every version times every block size is one WebCrypto call each, and `keyId` and `storeId` would have to leave the AAD or be stored in clear.
3. A fixed length says nothing. A header whose length depended on the version would show the version.

The price is a **frozen outer envelope**: the length of 168, bytes 0–87 and how they are used (the wrap, its AAD, the header-key derivation), the meta AAD, and `v` at meta offset 0 are the same in every future version. A later version may redefine meta bytes 2–63 and everything outside the header. `FORMAT.md` says this in its first section.

**Downgrade.** Every parameter a reader acts on is authenticated before it is acted on. A changed bit anywhere in the header fails a GCM tag. The meta is bound to the wrap it was written with (its AAD holds the wrap's bytes), so the meta of one header cannot be put beside the wrap of another, even when both hold the same DEK (after `changeKey`). The record subkeys carry the version in their `info`, so records written under one version do not open under another.

#### Root body (the plaintext of key `2`)

| Offset | Length | Content |
|---|---|---|
| 0 | 8 | `gen` (u64 BE) |
| 8 | 8 | `encryptions` (u64 BE) |
| 16 | 1 | `state`: 1 = ready, 2 = populating, 3 = rotating |
| 17 | 1 | zero |
| 18 | 2 | `originLen` (u16 BE), at most 255 |
| 20 | 4 | `fileCount` (u32 BE): file-table entries of kind "file" (regular files, directories and symlinks) |
| 24 | 4 | `dataBlocks` (u32 BE) |
| 28 | 32 | `tableDigest` |
| 60 | 32 | `manifest` |
| 92 | 4 | `tableCount` (u32 BE) |
| 96 | 16 × `tableCount` | The block ids of the file-table blocks, in list order |
| … | `originLen` | `origin` (UTF-8) |
| … | to `blockSize` | zero |

#### File-table block body

`count (u16 BE) ‖ entry × count ‖ zeros to blockSize`. An entry is one of:

| Kind | Layout |
|---|---|
| File | `0x01 ‖ fileId16 ‖ type (u8: 1 file, 2 directory, 3 symlink) ‖ mode (u32 BE) ‖ size (u64 BE) ‖ pathLen (u16 BE) ‖ path ‖ targetLen (u16 BE) ‖ target` |
| Run | `0x02 ‖ fileId16 ‖ first (u32 BE) ‖ n (u16 BE, at least 1) ‖ blockId16 × n` |

A file entry is the inode: the path exists nowhere else. A run entry says that blocks `first … first + n − 1` of that file are stored under the listed ids. A file's block list is its runs joined in order of `first`. The runs of one file must cover `0 … ceil(size / blockSize) − 1` exactly once; directories, symlinks and empty files have no run. A run never spans table blocks: a file with more ids than fit in one table block has several runs. Entries may sit in any table block in any order. The file table is the set of all entries of all table blocks listed in the root.

#### Rules
1. `fileId` is 16 random bytes chosen when a file is created; it never changes on rename. It exists only inside the file table and in AAD.
2. **Block ids.** A block id is 16 random bytes, drawn when a block first comes to exist (a new index of a file, or a new table block). The block keeps its id for as long as that position exists: **a rewrite is an overwrite under the same id**. When a position stops existing (truncate, unlink, a file replaced by a rename, a table block left empty) its record is deleted in the same commit, and a block that comes to exist later always gets a new random id. A writer draws again if a new id equals a live one; a reader treats an id that appears twice in the file table as corruption. In the backend's keys an id is written as 32 lowercase hex characters; inside the root and the table it is the 16 raw bytes.
   **The block space has no free list, no append-only log and no compaction.** One sync is one all-or-nothing transaction (#<PC-07>), so writing a block in place is already crash-safe, and a copy-on-write scheme would add nothing to that. It would cost a table-block write for every data-block write, because the table would have to record the new id each time. With stable ids, a sync that only changes the contents of existing blocks writes those blocks and the root, and no table block. Space freed by a delete is the backend's to reuse (IndexedDB does; a file backend keeps its own slot list). The one thing that is ever rewritten to save space is the file table itself, when it falls under half full (#<PC-08>); that moves no data block.
3. **Every sealed value has the same length** (`44 + blockSize`), whatever it holds. A file's true size is in its file entry (review S3). Nothing else is padded: the store grows and shrinks with the data, and its total block count is visible.
4. **Session subkeys.** When a filesystem instance opens for writing it draws one random `salt16` and derives one subkey (`crypto.subtle.deriveKey`, non-extractable, `["encrypt", "decrypt"]`). Every record it writes carries that salt. After `SUBKEY_MAX_ENCRYPTIONS = 2 ** 24` encryptions under one subkey it draws a new salt. A reader derives a subkey once per distinct salt it meets and caches it. With random 96-bit nonces and at most 2^24 uses per subkey, the collision chance per subkey is about 2^-49; no lifetime cap applies to the DEK.
5. **Header copies.** The two copies are byte-identical and are always written together. A copy *opens* when it is 168 bytes long, its wrap unwraps under the KEK and its meta decrypts. A reader uses the first copy that opens; if the other does not, it reports `headerRepairNeeded: true` so the next sync rewrites both. If neither opens: when a wrap unwrapped (so the key is right), or the copies differ, or one is missing or has the wrong length, that is `CorruptStoreError`; when both are present, identical and neither unwraps, that is `WrongKeyError`. (Both missing is not a header question: #<PC-08> calls a store with records and no header incomplete.) An opaque header cannot say more than that: two identical copies that fail are a wrong key unless someone overwrote both with the same bytes, and `FORMAT.md` says so. After a copy opens, `v` is checked first (`UnsupportedFormatError` when it is not 1), then `cipher`, `kdf`, `subkey` (`UnsupportedFormatError`), then `blockSize` and the zero bytes (`CorruptStoreError`). There is no separate key-check value.
6. **Digests**, both SHA-256, both in the root, which is itself AEAD-protected, so no MAC key is needed. A tag is the last 16 bytes of a stored value.
   - `tableDigest` = hash of the tags of the file-table blocks, in the root's list order. A reader checks it as soon as it has read the table blocks, **before it builds anything from them**.
   - `manifest` = hash of, for every regular file in ascending `fileId` byte order: `fileId ‖ blocks (u32 BE) ‖ blockTag16 × blocks` (tags in index order).
   Together they change when any record is modified, deleted, added or replaced by an older valid version of itself (review S1). Block ids are not hashed: they are inside the table blocks, whose tags are. Neither digest detects the whole store being replaced by an older copy; `FORMAT.md` says so.
7. **What binds a block to its place.** A data block's AAD names its file and its index, as before. The id it is stored under is only an address: the authenticated file table says which file and index live at that address, the reader opens the value with that file and index as AAD, and a value moved or swapped to another address fails its tag. A table block has no file, so its AAD names its own id. The type byte keeps a data block, a table block and the root from standing in for one another.
8. Body encoding is the fixed binary layout above, not JSON, so two implementations produce the same bytes. Document every field's width and endianness in `FORMAT.md`.
9. `encryptions` counts every **attempted** record encryption under the current DEK, including ones whose transaction later failed. It is telemetry (shown in `stats()`), not a limit.
10. **Modification times are not stored.** A file gets the time of the open when it is loaded. With one record per file an `mtime` cost a few bytes per sync; in a packed table it would cost a whole table block for every file a sync touches. Postgres does not decide anything from the modification time of its own files **[unverified]**.
11. **Limit.** The root holds `floor((blockSize − 96 − 255) / 16)` table block ids (490 at 8 KB, 2,026 at 32 KB, 4,074 at 64 KB), and a table block holds at most `floor((blockSize − 25) / 16)` block ids in one run (510, 2,046, 4,094). That caps a store at about 2 GB of data with 8 KB blocks and far above 100 GB with the larger sizes. A write that would pass the cap fails with `StoreFullError` before anything is committed. A second level of table index would lift the cap; v1 does not have one, because the database must fit in memory anyway.

What an observer of the stored bytes learns, to be stated in `FORMAT.md` in these words: that an IndexedDB database (or a file) exists; the number of block records and their common length, so the block size and the total size to the block; write timing, which is two things: which records changed between two looks at the store, and, inside one copy, which records were last written in the same session, because a session's records carry the same 16-byte salt (rule 4). Not: the format, the version, the application, the number of files, any file's size, or which block belongs to what. The salt grouping is the price of one `deriveKey` per session instead of one per record; SQLCipher 5 draws fresh subkey context for every page write and has no such grouping. Someone who knows this document can recognise the *shape* (two 168-byte values, the rest of equal length under random keys), as someone who knows SQLCipher can guess at a high-entropy file whose length is a multiple of the page size. No byte and no name says it.

### Code (`src/format/`)
- `codec.ts`: encode/decode of the header meta, the root body and table-block bodies. Decoders reject trailing non-zero bytes, unknown `v`, `cipher` or `subkey`, a `blockSize` not in {8192, 32768, 65536}, unknown entry kinds, and lengths that run past the buffer. They never throw anything but `CorruptStoreError` or `UnsupportedFormatError`.
- `table.ts`, pure functions over entries:
  - `assembleFiles(entries, root)`: joins file and run entries into `Map<fileId, { path, type, mode, size, target, ids }>` and an id → (file, index) index. Throws `CorruptStoreError` for a run without a file entry, a gap or an overlap, an id used twice, two files with one path, a count that differs from `fileCount` or `dataBlocks`.
  - `packEntries(files, blockSize)`: a dense packing of a whole file table into table-block bodies, splitting long block lists into runs. Used for first population, import and rotation. Throws `StoreFullError` past the limit of rule 11.
  - `entrySize(entry)`, `maxRunIds(blockSize)`, `maxTableBlocks(blockSize)`, for the incremental packer of #<PC-08>.
- `keys.ts`:
  - `importKek(raw: Uint8Array): Promise<CryptoKey>`: AES-GCM, non-extractable, usages `["wrapKey", "unwrapKey"]` only; fills `raw` with zeros before returning. Callers may also pass their own `CryptoKey` with those usages.
  - `createHeader(kek, { blockSize, keyId })`: 32 random bytes → import as an extractable temporary AES-GCM key → `wrapKey("raw", …)` → import the same bytes as an **HKDF** key (`["deriveKey"]`, never extractable) → zero the bytes → draw `storeId`, seal the meta. Returns `{ dek, meta, header }` (`header` is the 168 bytes).
  - `openHeader(kek, copy0, copy1)`: rule 5. `unwrapKey` straight into a non-extractable HKDF key. Returns `{ dek, meta, headerRepairNeeded }` or throws `WrongKeyError`, `CorruptStoreError` or `UnsupportedFormatError`.
  - `rewrapHeader(oldKek, newKek, header)`: unwrap as an extractable temporary key, wrap under the new key with a fresh nonce, seal the same meta again with a fresh salt and nonce (its AAD holds the new wrap), return the new 168 bytes. The temporary key is not kept.
  - `SubkeyCache(dek)`: `forSalt(salt)` derives on first use and caches by salt; `current()` returns the writing subkey and its salt, rolling to a new salt at `SUBKEY_MAX_ENCRYPTIONS`.
- `records.ts`: `sealBlock`, `openBlock`, `sealTable`, `openTable`, `sealRoot`, `openRoot`, `newBlockId()`. Each `seal*` increments the counters before calling WebCrypto. `open*` maps any WebCrypto failure to `CorruptStoreError` with the record's key in the message (a slot number or a block id, never a path) and never includes plaintext or key material.
- `manifest.ts`: `computeTableDigest(tags: Uint8Array[])`, `computeManifest(files: Iterable<{ fileId, blockTags: Uint8Array }>)`.
- `selfTest.ts`: `selfTest()`: a fixed-key known-answer check of HKDF → AES-GCM seal → open against constants in the source, run once per process before the first real operation. Webview crypto differs by platform; a webview that computes something else must fail here, loudly, with `CryptoSelfTestError`, not write a store nobody can read.
- `errors.ts`: `WrongKeyError`, `CorruptStoreError`, `IncompleteStoreError`, `StaleWriterError`, `UnsupportedFormatError`, `StoreFullError`, `CryptoSelfTestError`. Export all from `src/index.ts`.

### Tests (`test/format/*.test.ts`; they run in Node and, through `npm run test:browser`, in Chromium, Firefox and WebKit, except the `node:crypto` one)
- **Known-answer vectors:** `test/format/vectors.json` with fixed KEK, DEK, salts, nonces and ids, and the expected bytes of one header, one root, one table block (a file entry, a directory entry and a run) and one data block. Generated once with a test helper that injects salts, nonces and ids; the committed file is the regression lock.
- **Independent decoder:** `test/format/independent.test.ts` opens the vectors with `node:crypto` only (`hkdfSync`, `createDecipheriv("aes-256-gcm")`), written from `FORMAT.md` without importing anything from `src/format/`: header → DEK → meta → root → table block → data block. This proves the document is enough to read a store, and catches the class of bug where two implementations agree with themselves and not with each other (sqlite3mc 2.6.0's ChaCha20 counter bug decrypted silently to wrong data).
- **No recognisable bytes:**
  - *No fixed magic.* Create 2,000 headers and, with a fresh `SubkeyCache` for each one (a session's records share its salt, rule 4), seal 2,000 roots, table blocks and data blocks from **identical** plaintext and one DEK. For every bit position of the stored values (all 1,344 bits of the header; all bits of the sealed records at the smallest block size), the number of values with that bit set is between 843 and 1,157 (seven standard deviations around 1,000, so that about 200,000 positions do not make the test flaky). A constant byte, a version number or a length field in clear fails this.
  - The stored values of a small store contain none of the ASCII strings `pglite`, `cipher`, `PGLCIPHR`, `AES-256-GCM`, `HKDF-SHA256`, `journal`, and no path of the files in it.
  - The header is 168 bytes at every block size; every sealed value of one store has one length.
- **Downgrade fails:** flip each bit of a header in turn: every result fails to open (`WrongKeyError` or `CorruptStoreError`, never a parsed meta). A header whose meta was sealed correctly with `v = 2` (test helper) gives `UnsupportedFormatError`, not `WrongKeyError`; the same with an unknown `cipher`. The meta of header A beside the wrap of header B fails, for two stores and for one store before and after `rewrapHeader`. A root sealed under the `info` string of a pretend version 2 does not open as version 1.
- **Property tests (fast-check):** seal→open round-trips for random bodies and all three block sizes; any single-bit flip in a value (salt, nonce, ciphertext or tag) makes `open*` throw `CorruptStoreError`; opening a data block under another `fileId`, `index`, `storeId` or `keyId` throws; opening a table block under another block id throws; a data block does not open as a table block or as the root, and the reverse; the manifest changes when any one tag changes, a file is removed, a block is removed, or two blocks of one file swap; the table digest changes when a table-block tag changes or two table blocks swap places in the list.
- **Block swap across files fails:** seal block 3 of file A and block 3 of file B, exchange the stored values under their two ids, open each with the file and index the table gives for that id: both throw `CorruptStoreError`. The same for two indexes of one file.
- **File table:** random sets of files (0 to 3,000 blocks each, paths up to 200 bytes, directories, symlinks) go through `packEntries` → encode → decode → `assembleFiles` and come back equal; a file with more ids than one table block holds is split into runs and reassembled; entries shuffled across table blocks assemble to the same files; each defect of `assembleFiles` (gap, overlap, duplicate id, run without file, duplicate path, wrong counts) throws `CorruptStoreError`; one entry past the limit throws `StoreFullError`.
- **Decoder fuzz:** 20,000 random and mutated buffers into every decoder and into `assembleFiles`: the only outcomes are a value or one of the documented errors; never another exception, never a hang (per-case budget 50 ms).
- **Key tests:** `importKek` zeroes its input and the key's `usages` are exactly `wrapKey`, `unwrapKey`; the DEK is an HKDF key and not extractable; the header key and subkeys are not extractable; a wrong KEK gives `WrongKeyError`; `rewrapHeader` output opens with the new key and not the old, and holds the same meta.
- **Subkeys:** two sessions use different salts; the cache derives once per salt (spy on `deriveKey`); with `SUBKEY_MAX_ENCRYPTIONS` lowered by a test hook, the salt rolls and both old and new records open; salts and nonces never repeat across 100,000 seals; 100,000 block ids never repeat.
- **Header copies:** damage copy 0 → reads from copy 1 with `headerRepairNeeded`; damage both in different ways → `CorruptStoreError`; damage only the meta part of both → `CorruptStoreError`; both intact with a wrong key → `WrongKeyError`; both overwritten with the same random 168 bytes → `WrongKeyError` (a test named so that it reads as the documented limit of rule 5).
- **Self-test:** passes on Node; with WebCrypto's `encrypt` stubbed to return altered bytes it throws `CryptoSelfTestError`.
- **No plaintext, no secrets in errors:** a marker string sealed in a block, and one used as a path, do not appear in any sealed value or in any error message produced by the tamper tests.

## Verification
- `~/.claude/bin/heavy npx vitest run src/format` passes, including the vectors, the independent decoder, the no-recognisable-bytes, downgrade, swap, file-table, property, fuzz, key and subkey tests above.
- `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0.
- `FORMAT.md` exists and specifies every record byte for byte, with: the frozen outer envelope in its first section; the observer paragraph above; a "Prior art" paragraph naming SQLCipher 4 (salt-only header), SQLCipher 5.0.0-beta.1 (per-write subkeys), XAES-256-GCM (C2SP), gocryptfs (random file id and block number as AAD) and CryFS (equal-size blocks under random ids, with the directory structure inside them **[unverified: named from memory, check its design page before citing]**); and a "Not detected" paragraph (whole-store rollback; a wrong key against two header copies damaged identically).

## STOP and comment on the issue if
- #<PC-04> is not closed with `Go: yes` and a `Block size:` line.
- WebCrypto in Node 22+, in one of the three CI browsers, or in a target webview (per the spike's G6 results) lacks HKDF `deriveKey` to AES-GCM, or `wrapKey`/`unwrapKey` for AES-GCM with the raw format, or cannot unwrap into an HKDF key. Report which and where. The fallback is `HMAC-SHA256(DEK, salt)` as the subkey through `sign` + `importKey`, which puts subkey bytes in the JS heap: say so and wait for a decision.
- The spike measured more distinct session salts in a long-lived store than the open-time gate can pay for (one `deriveKey` per salt). Report the count.
- The spike's G9 result (`spike/RESULTS.md`) shows that an ordinary sync, one that creates, grows, shrinks, renames or removes no file, has to write a file-table block, or that the file-table phase of an open costs more than G9 allows. The packed layout is then wrong as specified; report the numbers and do not tune around them.
- You find that Postgres in this build reads the modification time of a file in PGDATA to decide something (rule 10). Report the call site.
- You find you need a dependency for crypto. The design uses WebCrypto only.
- Any part of the format seems to need a deterministic nonce or a counter nonce, or a byte in clear that is not random.

## Metadata
Depends on: #<PC-04>
Size: M
Area: db, security
Model: opus
Effort: xhigh
Review: fable
