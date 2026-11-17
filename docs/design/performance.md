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
slowest phone (`README.md`, "Compared to SQLCipher"). Android Chrome misses the phone budget
(see [the known limit](#known-limit-slow-encrypted-open-on-android-chrome)).

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

## Known limit: slow encrypted open on Android Chrome

On Android Chrome, opening a large encrypted database is much slower than opening a plain one.
Opening a 100 MB database took **3.4 times** the plain open on a Redmi Note 5 Pro (8.6 s against
2.5 s) and **4.55 times** on a stock vivo V2250 (8.1 s against 1.8 s). On desktop the same open
takes 1.2 to 1.6 times plain in Chromium, about the same in Firefox, and less than plain in
WebKit. The Android open therefore misses the 3 s budget above. The encrypted open on Windows
WebView2 also measured slow.

The cause is the size of a stored record. A sealed 64 KB block is 65,580 bytes, which is over
Chromium's 64 KiB limit for keeping an IndexedDB value inline. Chromium stores each such record as
a blob and unwraps it on the calling thread, at about 1.1 ms per record. On the Redmi, reading the
records took 7.7 s of the 8.6 s open (`readMs`, median of five opens), and decryption took about
1.2 s.

What is and is not affected:

- Only the open is affected, and its time grows with the size of the database.
- Sync, writes and queries are not affected.
- Security is not affected: the records are the same, and they are sealed and checked in the same
  way.

A later release will change the store layout to fix this, with a migration for existing stores.
Until then, plan for a splash screen on Android: `onProgress` reports the `blocks` phase, and
`stats().lastOpen` shows where an open spent its time.

## Other limits

- **No random access.** The whole database is loaded at open, as with PGlite's `idb://`. Open time
  grows with the size of the data directory.
- **Memory.** The data directory is larger than the database: Postgres keeps WAL segments and
  caches. `README.md`, "Running on mobile", has Postgres settings that reduce it.
- **Format size limits** are in [format.md](format.md#limits).
- **Rotation** costs about one open plus one full write.
