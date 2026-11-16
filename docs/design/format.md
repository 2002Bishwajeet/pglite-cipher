# On-disk format v1

`FORMAT.md` is the byte-exact specification, and `test/format/independent.node.test.ts` reads a
store from it with `node:crypto` alone. This page explains the shape and the reasons. All
integers are big-endian.

## A packed block space

The store is one key-value space with three fixed slots and a flat set of blocks:

| Key | Record | Stored value |
|---|---|---|
| `0`, `1` | header, two identical copies | 168 bytes |
| `2` | root | sealed, `44 + blockSize` bytes |
| 32 hex characters | a file-table block or a data block | sealed, `44 + blockSize` bytes |

Block ids are 16 random bytes (`newBlockId` in `src/format/records.ts`). A file-table block and a
data block look the same from outside; only the encrypted root and file table say which is which.
The block size is 8192, 32768 or 65536 bytes (`BLOCK_SIZES` in `src/format/codec.ts`), 65536 by
default. It is chosen when the store is created and kept in the encrypted header.

Why this layout: with one group of records per file, the keys would show the number of files,
their sizes and which records belong together. With one flat pool of equal-size records under
random ids, the stored bytes show only how many blocks there are. The idea follows CryFS, which
stores all data and metadata as fixed-size blocks under random ids.

## The header

`src/format/keys.ts`, `HEADER_LENGTH = 168`.

| Offset | Length | Content |
|---|---|---|
| 0 | 12 | `wrapNonce`, random |
| 12 | 48 | the data key (DEK) wrapped with AES-256-GCM under the KEK, AAD `"pglite-cipher/wrap"`, tag included |
| 60 | 16 | `metaSalt`, random |
| 76 | 12 | `metaNonce`, random |
| 88 | 80 | the 64-byte meta sealed with AES-256-GCM under the header key, tag included |

The header key is `HKDF-SHA256(DEK, metaSalt, "pglite-cipher/header")`. The meta's AAD is
`"pglite-cipher/header" ‖ header bytes 0–59`, so the meta of one header cannot be put beside the
wrap of another. The meta (`encodeMeta` in `src/format/codec.ts`) holds the version `v` = 1, the
cipher (AES-256-GCM), the KDF (raw key), the subkey scheme (HKDF, one per session), the block size,
the key id and the 16-byte random `storeId`.

**Why two envelopes.** `unwrapKey` turns the wrapped bytes straight into a non-extractable
`CryptoKey`, so the DEK is never in the JavaScript heap when a store opens. But `unwrapKey` can
return nothing else, so the parameters travel in a second envelope under a key derived from the
DEK. Without the KEK nobody can make or change either part.

**Why no readable version.** No byte in a store names the format, the version, the cipher or the
application. A reader learns the version by opening the meta with the caller's key. The first 88
bytes of the header, their use, and the position of `v` are frozen for every future version
(`FORMAT.md` section 1), so an old reader that opens a newer store reports
`UnsupportedFormatError`, never a wrong key.

**Why two copies.** A damaged copy is repaired from the other at the next write. And the pair tells
a wrong key from damage, which one opaque copy cannot (see [integrity.md](integrity.md)).

## Sealed records

The root, every table block and every data block have one shape (`src/format/records.ts`):

```
salt16 ‖ nonce12 ‖ AES-256-GCM(subkey, blockSize bytes, AAD) ‖ tag16
```

- `salt16` names the session subkey, `HKDF-SHA256(DEK, salt16, "pglite-cipher/v1/record")` (see
  [keys.md](keys.md)).
- `nonce12` is drawn at random for this one encryption. No nonce is a counter or derived.
- The plaintext is always padded with zeros to the block size, so every sealed value is exactly
  `44 + blockSize` bytes (`SEALED_OVERHEAD = 44`). A file's true size is in its table entry.
- The **tag** of a record is the last 16 bytes of its stored value. The digests hash tags.

### What the AAD binds

| Record | AAD | Bytes |
|---|---|---|
| Root | `"r" ‖ storeId ‖ keyId` | 21 |
| File-table block | `"t" ‖ storeId ‖ keyId ‖ blockId` | 37 |
| Data block | `"b" ‖ storeId ‖ keyId ‖ fileId ‖ index (u32)` | 41 |

- **Type byte:** a data block, a table block and the root cannot stand in for one another.
- **`storeId`:** a record from another store, even under the same DEK, does not open.
- **`keyId`:** names the data key; it goes up by one at each data-key rotation.
- **`fileId` and `index`:** a data block opens only as the block of the file and position that the
  authenticated file table says is stored under its id. A value moved or swapped to another id
  fails its tag. This is the same idea as gocryptfs, which uses a per-file id and the block number
  as AAD.
- **A table block's own id:** a table block has no file, so it is bound to its address.
- **`RECORD_INFO` carries the version,** so records of one format version do not open under
  another.

## The root

The root's plaintext (`encodeRoot` in `src/format/codec.ts`), padded to the block size:

| Field | Meaning |
|---|---|
| `gen` (u64) | goes up with each commit |
| `encryptions` (u64) | attempted record encryptions under this DEK; telemetry, not a limit |
| `state` (u8) | `ready`, `populating` or `rotating` |
| `fileCount`, `dataBlocks` (u32) | must equal what the file table holds |
| `tableDigest` (32) | SHA-256 of the table blocks' tags, in list order |
| `manifest` (32) | SHA-256 over every regular file's data-block tags |
| `tableCount` and the table-block ids | which blocks hold the file table |
| `origin` (at most 255 bytes) | during a rotation, the name of the store being written |

A reader rejects any non-zero padding byte, an unknown state, or an `origin` that is not UTF-8.

## The file table

The file table is the set of entries in all table blocks the root lists. Each table block body is
`count (u16) ‖ entries ‖ zeros` (`encodeTable`). There are two kinds of entry:

| Entry | Content | Bytes |
|---|---|---|
| File | `fileId`, type (file, directory, symlink), POSIX mode, size, path, symlink target | 34 + path + target |
| Run | `fileId`, `first`, then `n` block ids for blocks `first … first + n − 1` | 23 + 16 × n |

- The file entry is the inode. The path exists nowhere else, so a rename rewrites a table entry and
  no data block.
- Modification times are not stored. A loaded file gets the time of the open.
- A file's runs, joined in order of `first`, cover its blocks `0 … ceil(size / blockSize) − 1`
  exactly once. Directories, symlinks and empty files have no run.
- A block keeps its id while its position exists; a rewrite is an overwrite under the same id. A
  position that stops existing (truncate, unlink, a file replaced by a rename) has its record
  deleted in the same commit, and a later block always gets a new id.

`assembleFiles` (`src/format/table.ts`) rejects as corrupt: a run without a file entry, two file
entries for one file, a gap or overlap in a file's runs, a run past a file's end, a file missing
blocks at its end, an id listed twice (data or table blocks), two files with one path, and counts
that differ from the root.

## The digests

`src/format/manifest.ts`. Both are plain SHA-256; they sit inside the authenticated root, so no MAC
key is needed.

- `tableDigest`: the tags of the table blocks, concatenated in the root's list order.
- `manifest`: for every regular file in ascending `fileId` byte order,
  `fileId ‖ block count (u32) ‖ its data-block tags in index order`.

Each record's tag changes whenever it is re-encrypted (fresh nonce), so the digests change when any
record is modified, deleted, added or replaced by an older valid copy of itself.

## Limits

| | 8 KB | 32 KB | 64 KB |
|---|---|---|---|
| Table blocks per root, `floor((blockSize − 96 − 255) / 16)` | 490 | 2,026 | 4,074 |
| Ids per run, `floor((blockSize − 25) / 16)` | 510 | 2,046 | 4,094 |

`maxTableBlocks` is in `src/format/codec.ts`, `maxRunIds` in `src/format/table.ts`. v1 has no
second level of table index. `FORMAT.md` section 9 puts the cap at about 2 GB of data with 8 KB
blocks and far above 100 GB with the larger sizes. A sync that would pass a limit throws
`StoreFullError` before anything is committed.

## What is hidden, and what is not

| Visible to someone with the stored bytes | Hidden |
|---|---|
| that a database exists | the format, its version, the application |
| the number of records and their common length, so the block size and the total size to the block | the number of files |
| which records changed between two looks | every file's name, size and mode |
| within one copy, which records were last written in the same session (they share a salt) | which block belongs to which file, and which blocks are file table |

Someone who knows `FORMAT.md` can recognise the shape (two 168-byte values, the rest of one length),
as someone who knows SQLCipher can guess at a high-entropy file whose length is a multiple of the
page size. No byte and no name says it. The IndexedDB database name is the caller's choice; see
[backends.md](backends.md).
