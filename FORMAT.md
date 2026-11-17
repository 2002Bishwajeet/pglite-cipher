# pglite-cipher on-disk format, version 1

This document specifies every byte that pglite-cipher stores. It is enough to read a store
without the package: `test/format/independent.node.test.ts` does so with `node:crypto` alone.

## 1. The frozen outer envelope

No byte in a store names the format, the version, the cipher or the application. A reader finds
the version by opening the header with the caller's key, never by trying layouts. For that to
work in every future version, these parts are **frozen** and are the same in every version:

- a header copy is exactly 168 bytes long;
- header bytes 0–87 and how they are used: `wrapNonce` at 0 (12 bytes), the wrapped data key at
  12 (32 bytes plus a 16-byte tag), `metaSalt` at 60 (16 bytes), `metaNonce` at 76 (12 bytes);
  the wrap is AES-256-GCM under the caller's key with AAD = `"pglite-cipher/wrap"`;
  the header key is `HKDF-SHA256(key = DEK, salt = metaSalt, info = "pglite-cipher/header")`;
- the meta is AES-256-GCM under the header key at bytes 88–167 (64 bytes of ciphertext and a
  16-byte tag) with AAD = `"pglite-cipher/header" ‖ header bytes 0–59`;
- `v`, a u16 BE at meta offset 0.

A later version may redefine meta bytes 2–63 and everything outside the header. A reader that
opens a header and finds a `v` it does not know reports an unsupported format; it never reports
a wrong key for a store a later version wrote.

## 2. Notation and primitives

- `‖` is concatenation. `u8`, `u16`, `u32` and `u64` are unsigned integers, **big-endian**.
  A v1 writer never writes a `u64` of 2^53 or more, and a reader treats one as corruption.
- Labels and `info` strings are ASCII bytes with no terminator. They are inputs to the cipher and
  are never stored:
  - `WRAP_AAD` = `"pglite-cipher/wrap"` (18 bytes)
  - `HEADER_LABEL` = `"pglite-cipher/header"` (20 bytes)
  - `RECORD_INFO` = `"pglite-cipher/v1/record"` (23 bytes)
- **AES-256-GCM**: a 32-byte key, a 12-byte nonce, a 16-byte tag appended to the ciphertext
  (`ciphertext ‖ tag`, as WebCrypto returns it). Every nonce is drawn at random for its one
  encryption. No nonce is a counter and none is derived.
- **HKDF-SHA256** is RFC 5869 with SHA-256, input key material = the 32 DEK bytes, the given
  salt and `info`, and an output of 32 bytes, used as an AES-256-GCM key.
- **KEK**: the caller's key, 32 bytes, used only to wrap and unwrap the DEK. There is no
  passphrase KDF: the KEK is raw key material (`kdf` = 0).
- **DEK**: 32 random bytes, drawn once per store (and again at data-key rotation). It never
  encrypts a record itself: it is only the input key of HKDF.
- `storeId`, `fileId` and block ids are 16 random bytes each. `keyId` is a u32 the caller
  chooses to name its KEK.

## 3. The store

The store is one key-value space. Values are byte strings.

| Record | Key | Stored value | Plaintext | AAD |
|---|---|---|---|---|
| Header, copy 0 and 1 | `0`, `1` | 168 bytes (section 4) | – | section 4 |
| Root | `2` | sealed | root body (section 6), zero-padded to `blockSize` | `"r" ‖ storeId ‖ keyId` |
| File-table block | a block id | sealed | table body (section 7), zero-padded to `blockSize` | `"t" ‖ storeId ‖ keyId ‖ blockId` |
| Data block | a block id | sealed | the block's bytes, zero-padded to `blockSize` | `"b" ‖ storeId ‖ keyId ‖ fileId ‖ index` |

In a backend's keys a block id is written as 32 lowercase hexadecimal characters; inside the root
and the file table it is the 16 raw bytes. The keys `0`, `1` and `2` are numbers in IndexedDB.

## 4. Header

Both copies are byte-identical and are always written together.

| Offset | Length | Content |
|---|---|---|
| 0 | 12 | `wrapNonce`, random |
| 12 | 32 | the DEK, encrypted with AES-256-GCM under the KEK, nonce `wrapNonce`, AAD = `WRAP_AAD` |
| 44 | 16 | GCM tag of the wrap |
| 60 | 16 | `metaSalt`, random |
| 76 | 12 | `metaNonce`, random |
| 88 | 64 | `meta`, encrypted with AES-256-GCM under the header key, nonce `metaNonce`, AAD = `HEADER_LABEL ‖ header bytes 0–59` |
| 152 | 16 | GCM tag of the meta |

Header key = `HKDF-SHA256(key = DEK, salt = metaSalt, info = HEADER_LABEL)`.

`meta` plaintext (64 bytes):

| Offset | Length | Content |
|---|---|---|
| 0 | 2 | `v` (u16) = 1 |
| 2 | 1 | `cipher` (u8): 1 = AES-256-GCM |
| 3 | 1 | `kdf` (u8): 0 = raw |
| 4 | 1 | `subkey` (u8): 1 = HKDF-SHA256, one per session |
| 5 | 3 | zero |
| 8 | 4 | `blockSize` (u32): 8192, 32768 or 65536 |
| 12 | 4 | `keyId` (u32) |
| 16 | 16 | `storeId`, random |
| 32 | 32 | zero (reserved) |

Why two envelopes. WebCrypto's `unwrapKey` turns the wrapped bytes straight into a key that
JavaScript cannot read, so the DEK never sits in the JavaScript heap when a store opens. It cannot
hand back anything else, so the parameters travel in a second envelope under a key derived from
the DEK. Nobody without the KEK can make or change either part: the wrap needs the KEK, and the
meta needs the DEK that only the wrap gives. The meta's AAD holds the wrap's bytes, so the meta of
one header cannot be put beside the wrap of another, even when both hold the same DEK (after a
key change).

### Reading a header copy

1. The copy must be 168 bytes long.
2. Unwrap bytes 12–59 with the KEK (nonce = bytes 0–11, AAD = `WRAP_AAD`). A tag failure means
   the copy does not open under this KEK.
3. Derive the header key from the DEK and bytes 60–75. Decrypt bytes 88–167 with nonce =
   bytes 76–87 and AAD = `HEADER_LABEL ‖ bytes 0–59`. A tag failure means the copy does not open.
4. Check the meta, in this order: `v` = 1, else **unsupported format**; `cipher` = 1, `kdf` = 0,
   `subkey` = 1, else **unsupported format**; `blockSize` one of the three sizes and bytes 5–7
   and 32–63 zero, else **corrupt**.

### Two copies

A copy *opens* when it is 168 bytes long, its wrap unwraps under the KEK and its meta decrypts. A
reader uses the first copy that opens (copy 0 before copy 1). When the other copy is not
byte-identical to it, the reader reports that the header needs repair, and the next write
rewrites both copies. When neither copy opens:

- if a wrap unwrapped (so the key is right), or the copies differ, or one is missing or has the
  wrong length: **corrupt**;
- if both are present, identical and neither unwraps: **wrong key**.

An opaque header cannot say more than that. Two identical copies that fail to unwrap are a wrong
key, unless someone overwrote both with the same bytes; a reader cannot tell those two apart.
(Both copies missing is not a header question: a store with records and no header is
incomplete, and a store with no records at all is new.) There is no separate key-check value:
the wrap's GCM tag is the key check.

## 5. Sealed records

The root, every table block and every data block are **sealed** in one shape:

```
salt16 ‖ nonce12 ‖ ciphertext ‖ tag16
```

- `salt16` names the subkey: `subkey = HKDF-SHA256(key = DEK, salt = salt16, info = RECORD_INFO)`.
- `nonce12` is random for this one encryption.
- `ciphertext ‖ tag16` is AES-256-GCM of the `blockSize`-byte plaintext under the subkey, with
  the record's AAD.

Every sealed value is `44 + blockSize` bytes long, whatever it holds. The **tag** of a record is
the last 16 bytes of its stored value.

AAD, by record type. The type is one ASCII byte; `storeId`, `fileId` and `blockId` are their 16
raw bytes; `keyId` and `index` are u32.

| Record | AAD | Length |
|---|---|---|
| Root | `0x72 ("r") ‖ storeId ‖ keyId` | 21 |
| File-table block | `0x74 ("t") ‖ storeId ‖ keyId ‖ blockId` | 37 |
| Data block | `0x62 ("b") ‖ storeId ‖ keyId ‖ fileId ‖ index` | 41 |

What binds a block to its place: a data block's AAD names its file and its index. The id it is
stored under is only an address: the authenticated file table says which file and index live at
that address, the reader opens the value with that file and index as AAD, and a value moved or
swapped to another address fails its tag. A table block has no file, so its AAD names its own id.
The type byte keeps a data block, a table block and the root from standing in for one another.
`RECORD_INFO` carries the version, so records written under one version do not open under another.

### Session subkeys

When a writer opens a store it draws one random `salt16` and derives one subkey. Every record it
writes carries that salt. After `2^24` encryptions under one subkey it draws a new salt. A reader
derives a subkey once per distinct salt it meets and caches it. With random 96-bit nonces and at
most 2^24 uses per subkey, the chance of a nonce collision is about 2^-49 per subkey, and no
lifetime limit applies to the DEK.

## 6. Root body

The plaintext of key `2`, `blockSize` bytes:

| Offset | Length | Content |
|---|---|---|
| 0 | 8 | `gen` (u64) |
| 8 | 8 | `encryptions` (u64): every attempted record encryption under the current DEK, including ones whose write later failed. Telemetry, not a limit. |
| 16 | 1 | `state` (u8): 1 = ready, 2 = populating, 3 = rotating |
| 17 | 1 | zero |
| 18 | 2 | `originLen` (u16), at most 255 |
| 20 | 4 | `fileCount` (u32): the number of file-table entries of kind "file" (regular files, directories and symlinks) |
| 24 | 4 | `dataBlocks` (u32): the number of data-block ids in the file table |
| 28 | 32 | `tableDigest` (section 8) |
| 60 | 32 | `manifest` (section 8) |
| 92 | 4 | `tableCount` (u32), at most `maxTableBlocks` (section 9) |
| 96 | 16 × `tableCount` | the block ids of the file-table blocks, in list order |
| 96 + 16 × `tableCount` | `originLen` | `origin`, UTF-8 |
| … | to `blockSize` | zero |

A reader rejects as corrupt: an unknown `state`, a non-zero byte 17, `originLen` over 255,
`tableCount` over the limit, an `origin` that is not valid UTF-8, and any non-zero byte after
`origin`.

## 7. File table

The file table is the set of all entries of all table blocks the root lists. Entries may sit in
any table block in any order.

Table-block body, `blockSize` bytes:

```
count (u16) ‖ entry × count ‖ zeros to blockSize
```

| Kind | Layout | Length |
|---|---|---|
| File | `0x01 ‖ fileId16 ‖ type (u8) ‖ mode (u32) ‖ size (u64) ‖ pathLen (u16) ‖ path ‖ targetLen (u16) ‖ target` | 34 + pathLen + targetLen |
| Run | `0x02 ‖ fileId16 ‖ first (u32) ‖ n (u16, at least 1) ‖ blockId16 × n` | 23 + 16 × n |

- `type`: 1 = regular file, 2 = directory, 3 = symlink. `mode` is the POSIX mode. `size` is the
  file's length in bytes. `path` is UTF-8, relative to the data directory, `/`-separated; `target`
  is a symlink's target in UTF-8 and empty for any other type.
- A file entry is the inode: the path exists nowhere else. Modification times are not stored; a
  file gets the time of the open when it is loaded.
- A run entry says that blocks `first … first + n − 1` of that file are stored under the listed
  ids. A file's block list is its runs joined in order of `first`. The runs of one regular file
  cover `0 … ceil(size / blockSize) − 1` exactly once; directories, symlinks and empty files have
  no run. A run never spans table blocks.

A reader rejects as corrupt: an unknown entry kind or `type`, `n` = 0, a length that runs past the
body, a `path` or `target` that is not valid UTF-8, any non-zero byte after the last entry; and,
across the whole table, a run without a file entry, two file entries for one `fileId`, a gap or an
overlap in a file's runs, a run past a file's last block, an id that appears twice (among the
data-block ids and the table-block ids), two files with one path, and a number of file entries or
data-block ids that differs from the root's `fileCount` or `dataBlocks`.

### Block ids and the block space

1. `fileId` is drawn when a file is created and never changes on rename. It exists only inside the
   file table and in AAD.
2. A block id is drawn when a block first comes to exist (a new index of a file, or a new table
   block). The block keeps its id for as long as that position exists: a rewrite is an overwrite
   under the same id. When a position stops existing (truncate, unlink, a file replaced by a
   rename, a table block left empty) its record is deleted in the same commit, and a block that
   comes to exist later always gets a new random id. A writer draws again if a new id equals a
   live one.
3. The block space has no free list, no append-only log and no compaction. One write is one
   all-or-nothing transaction, so writing a block in place is crash-safe. Space a delete frees is
   the backend's to reuse. The one thing ever rewritten to save space is the file table itself,
   when it falls under half full; that moves no data block.
4. Every sealed value has the same length. A file's true size is in its file entry. Nothing else
   is padded: the store grows and shrinks with the data.

## 8. Digests

Both are SHA-256 and both sit in the root, which is itself authenticated, so no MAC key is needed.

- `tableDigest` = SHA-256 of the tags of the file-table blocks, concatenated in the root's list
  order. A reader checks it as soon as it has read the table blocks, before it builds anything
  from them.
- `manifest` = SHA-256 of, for every regular file in ascending `fileId` byte order,
  `fileId ‖ blocks (u32) ‖ tag16 × blocks`, the data-block tags in index order. A regular file
  with no blocks contributes `fileId ‖ 0x00000000`. Directories and symlinks contribute nothing.

Together they change when any record is modified, deleted, added or replaced by an older valid
version of itself. Block ids are not hashed: they are inside the table blocks, whose tags are.

## 9. Limits

- The root holds at most `maxTableBlocks = floor((blockSize − 96 − 255) / 16)` table-block ids:
  490 at 8 KB, 2,026 at 32 KB, 4,074 at 64 KB.
- A run holds at most `maxRunIds = floor((blockSize − 25) / 16)` ids, the most that fit in one
  table block: 510, 2,046 and 4,094.
- That caps a store at about 2 GB of data with 8 KB blocks and far above 100 GB with the larger
  sizes. A write that would pass the cap fails before anything is committed. v1 has no second
  level of table index.

## 10. What an observer learns

What an observer of the stored bytes learns: that an IndexedDB database (or a file) exists; the
number of block records and their common length, so the block size and the total size to the
block; write timing, which is two things: which records changed between two looks at the store,
and, inside one copy, which records were last written in the same session, because a session's
records carry the same 16-byte salt (section 5, session subkeys). Not: the format, the version,
the application, the number of files, any file's size, or which block belongs to what. The salt
grouping is the price of one `deriveKey` per session instead of one per record; SQLCipher 5 draws
fresh subkey context for every page write and has no such grouping. Someone who knows this
document can recognise the *shape* (two 168-byte values, the rest of equal length under random
keys), as someone who knows SQLCipher can guess at a high-entropy file whose length is a multiple
of the page size. No byte and no name says it.

## 11. Not detected

Two things are not detected. **Whole-store rollback**: neither digest detects the whole store
being replaced by an older copy of itself, because that copy is valid in every byte. **A wrong
key against two header copies damaged identically**: two identical header copies that fail to
unwrap are reported as a wrong key, so a store whose two copies someone overwrote with the same
bytes reads as a wrong key, not as corruption (section 4).

## 12. Prior art

SQLCipher 4 stores a random salt as the first 16 bytes of the database file and nothing else in
clear; this store likewise shows only random nonces and salts. SQLCipher 5.0.0-beta.1 derives a
one-time subkey from random context for every page write ("modeled after XAES-256-GCM") to stay
clear of the 2^32 random-nonce limit of NIST SP 800-38D; the session subkeys here are the
WebCrypto-sized version of that, one `deriveKey` per session instead of per write. XAES-256-GCM
(C2SP, https://github.com/C2SP/C2SP/blob/main/XAES-256-GCM.md) is the construction both follow:
a subkey derived from a random nonce extension, then AES-256-GCM. gocryptfs authenticates each
block with a random per-file id and the block number as AAD, which is what binds a data block to
its file and index here. CryFS splits all data into fixed-size blocks stored under random ids,
with the directory structure and metadata in further encrypted blocks of the same pool
(https://www.cryfs.org/howitworks), which is the packed block space and encrypted file table here.
