# Performance and known limits

## Where the cost is

| Operation | Cost compared with plain PGlite `idb://` |
|---|---|
| Query | none: Postgres reads plaintext memory |
| Sync | usually less: only changed blocks are written, where `idb://` rewrites each changed file whole (a dirty WAL page rewrites its whole segment) |
| Open | more: every record is read and decrypted before Postgres starts |
| Memory | about the same: the whole data directory is in memory either way, plus up to two pages of ciphertext during an open |

The benchmark page and its gates are described in `bench/README.md`. The gates compare against
plain `idb://` in the same run, and the open budget is 100 MB in 1.5 s on desktop and 3 s on the
slowest phone (`README.md`, "Compared to SQLCipher").

## The block size

A store's block size is 8, 32 or 64 KB, chosen at creation; the default is 64 KB
(`DEFAULT_BLOCK_SIZE` in `src/format/codec.ts`). Postgres writes 8 KB pages, so a smaller block
would write fewer bytes per change. But each record costs a WebCrypto call and an IndexedDB value,
and the open pays that cost once per record: a 100 MB store is eight times as many records at 8 KB
as at 64 KB. The spike measured all three sizes (`bench/SPIKE-RESULTS.md`); 64 KB was the only
size that passed the 100 MB open gate in all three engines measured (Chromium, Firefox, WebKit).

## The open

The open reads every record, in pages of 512 by ascending id, and decrypts with at most 64
WebCrypto calls in flight (`src/fs/pool.ts`). It reads the next page while the current one
decrypts, so it holds at most two pages of ciphertext: about 64 MB at 64 KB blocks. Block ids are
random, so consecutive records belong to unrelated files; reading in key order keeps the reads
cheap for IndexedDB, and only the copy into memory is scattered.

`stats().lastOpen` reports `tableMs` (header, root and file table) and `blocksMs` (every block);
`onProgress` reports the `table` and `blocks` phases for a splash screen.

## Known limit: open time on some platforms

On Android (Chrome) and on Windows WebView2, the encrypted open of a large database measured slow.
On Android the time is in the IndexedDB reads of many 64 KB records, not in
decryption: an open that reads the records without decrypting them takes most of the same time.

This is being investigated as issue #76: measuring where the read time goes and which changes to
the read path help (for example how records are fetched per transaction). A change to the open's
read path, the storage layout or the backend may follow from it. None is promised, and none is
decided.

## Other limits

- **No random access.** The whole database is loaded at open, as with PGlite's `idb://`. Open time
  grows with the size of the data directory.
- **Memory.** The data directory is larger than the database: Postgres keeps WAL segments and
  caches. `README.md`, "Running on mobile", has Postgres settings that reduce it.
- **Format size limits** are in [format.md](format.md#limits).
- **Rotation** costs about one open plus one full write.
