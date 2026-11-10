# Review of `553-sqlcipher-for-pglite.md`

Reviewer model: Fable 5.2 (`claude-fable-5-2`). Date: 2026-11-10. Read-only review; nothing was changed in the repo or on GitHub.

**Verdict: sound with fixes.** The architecture is right: encrypt below Postgres, MEMFS plus dirty-block tracking, AES-256-GCM with random nonces, one atomic IndexedDB transaction per sync. Three things must be settled before code is written (B1-B3), and the integrity claims are stronger than the format delivers (S1).

Evidence paths are relative to `/home/biswa/Github/journal/node_modules/@electric-sql/pglite/dist/` (0.5.10). `index.js` and `pglite.js` are minified to a few lines, so I cite the file and a search string.

## What I checked and found correct

| Spec claim | Result |
|---|---|
| `Filesystem` interface shape | Correct, `pglite-C1eAkqkG.d.ts:329-352` |
| `BaseFilesystem.read/write` are synchronous | Correct, `pglite-C1eAkqkG.d.ts:372-410` |
| IDBFS writes each changed file whole | Correct, `pglite.js` `loadLocalEntry` puts `contents: node.contents` |
| `relaxedDurability` does not await the flush | Correct, `index.js` `s(this,o_)?t():await t()`. The flush runs under a separate FS mutex, so queries do run during it |
| A snapshot taken between WASM calls is a crash-consistent image | Correct. `execProtocolRawSync` is synchronous, so any point between calls equals a `kill -9` with the OS page cache intact |
| SQLCipher constants | Correct in `sqlcipher.c` master: `FILE_HEADER_SZ` L93, `PBKDF2_ITER 256000` L111, `FAST_PBKDF2_ITER 2` L135, `HMAC_SALT_MASK 0x3a` L144, reserve setup L1218, `sqlcipher_page_hmac` L1708, `sqlcipher_page_cipher` L1749 |
| SQLCipher design page (CBC, per-page random IV, HMAC-SHA512, no rollback statement) | Correct, https://www.zetetic.net/sqlcipher/design/ |
| PG TDE wiki: XTS for data, CTR for WAL, no integrity | Correct, https://wiki.postgresql.org/wiki/Transparent_Data_Encryption |
| NIST SP 800-38D 2^32 cap for random 96-bit nonces | Correct (section 8.3). At 2^28 writes the collision probability is about 2^-41 |
| Rejecting deterministic nonces | Correct, for the three reasons given |
| Tauri `invoke` is unavailable in workers | Consistent with Tauri 2.9.2 `scripts/ipc-protocol.js`, which reads `window.__TAURI_INTERNALS__` |

The nonce budget holds. Each sync encrypts the dirty blocks plus one inode record per dirty file, so about 3 encryptions per commit. 100k a day is a fair upper estimate and reaches 2^28.4 in ten years. Count inode encryptions in the counter too, since they share the DEK.

## Blockers

### B1. The Homebase credentials stay in plaintext next to the encrypted database
- **Evidence:** `src/hooks/auth/useYouAuthAuthorization.ts:149-150` writes the shared secret (`APSS`, `src/lib/homebase/config.ts:113`) and the client auth token to `localStorage`. `src/App.tsx:51-66` persists the react-query cache to IndexedDB (`journal-query-cache`, 7 days). `src/sw.ts:160` caches proxied images.
- **Impact:** anyone who can read the profile directory, which is the attacker this feature targets, takes the token and shared secret and downloads every note from Homebase. The spec lists this under Q5 as a "documented follow-up". It is a bypass of the feature.
- **Fix:** this does not block building #553. It blocks shipping #1017 as "encryption at rest". Move the token and shared secret into the keychain (or encrypt them under the KEK) in the same release, and either encrypt or stop persisting the query cache.

### B2. Open and migration have no state machine, and three paths lose data
- **Header missing is treated as an empty store.** PGlite runs initdb whenever `PG_VERSION` is absent after `initialSyncFs` (`index.js`, "pglite: no db in filesystem, running initdb"). If `initialSyncFs` returns normally on a store with blocks but no header, the next sync overwrites the user's data. `pglite-worker.ts:34-35` already documents this hazard for the plain FS.
- **Both stores exist after a crash.** If the app dies after switching to the encrypted store but before deleting the old one, the spec does not say which is authoritative. Re-migrating from the stale plaintext copy silently drops every write since.
- **Raw IDBFS copy while the plaintext engine is live.** Under `relaxedDurability` MEMFS is ahead of IndexedDB, and the IDBFS image can be torn (see S4). Copying raw records then captures an old or inconsistent image.
- **Fix:**
  1. "Empty" means zero records in the store. Anything else without a valid header throws, and `syncToFs` stays disabled until a load succeeds.
  2. Migrate inside the new FS: with the plaintext engine closed after a final awaited flush, `initialSyncFs` populates MEMFS from the old IDBFS records and marks everything dirty.
  3. Write the encrypted store with the header last. The header carries `migratedFrom` and is the commit marker. On boot, a valid header wins; no header means discard the partial store and redo.
  4. Verify by re-reading and decrypting the store and comparing a SHA-256 per file against MEMFS. This is stronger and cheaper than row counts, and needs no second engine in RAM.
  5. Delete the plaintext database only after step 4.

### B3. Dirty tracking is specified for `write` only, and a missed block bricks the database
The load rule "a missing block below `size` throws `CorruptDatabaseError`" turns any tracking gap into a permanent failure.
- **`stream_ops.allocate` does not exist in this build.** MEMFS file stream ops are `llseek, read, write, mmap, msync` (`index.js`, `stream:{llseek:MEMFS.stream_ops.llseek,...}`). `posix_fallocate` goes to `FS.ftruncate` (`pglite.js`, `newSize>oldSize){FS.ftruncate(fd,newSize)}`), so file growth arrives as `node_ops.setattr` with a size and no write.
- **Writes past EOF leave a zero hole.** MEMFS `write` calls `expandFileStorage(node, position+length)`. Marking only `floor(pos/8192)…` misses the blocks between the old size and `pos`. Postgres does this (hash index bucket allocation writes only the last block).
- **`msync` bypasses a wrapped `write`.** It calls `MEMFS.stream_ops.write` directly (`pglite.js`, `msync(stream,buffer,offset,length,mmapFlags){MEMFS.stream_ops.write`). The spec lists `msync`, so keep it as its own hook.
- **Truncate then re-extend between two syncs** leaves stale ciphertext blocks unless tracked.
- **Fix:** track per inode a `persistedBlocks` count and a `minSizeSinceSync` low-water mark. On any size change mark every block from `min(oldSize, newSize)` to the new end. At snapshot, write blocks from the low-water mark up and range-delete `[currentBlocks, persistedBlocks)`. Add a property test: random write, truncate, fallocate, rename and unlink sequences, then reopen and compare every file byte for byte.

## Should-fix

### S1. Integrity is per record, so the "detected" list is overstated
- **Whole-file deletion is not detected.** Nothing authenticates the set of inodes. Deleting the newest WAL segment's inode and blocks makes Postgres stop recovery earlier, which silently drops recent commits.
- **Inode replay is not detected.** An old inode for the same `fileId` (older size or path) passes.
- **The inode AAD is not implementable as written.** It binds `gen`, but `gen` increments every sync and only dirty inodes are rewritten. Either every inode is rewritten on every sync (about 1,000 records) or the inode's own `gen` is stored in plaintext beside it and binds nothing.
- **Fix, pick one:**
  - Correct the claim: "detects modification and relocation of individual records; does not detect deletion of whole files or replay of any record".
  - Or add a set MAC: keep in the header an XOR of `HMAC(macKey, type ‖ fileId ‖ idx ‖ tag)` over all live records, updated per sync in O(dirty) and checked at load, which already reads everything. That detects any splice, deletion or per-record replay inside one store. Whole-store rollback stays undetected. Drop `gen` from the inode AAD either way.

### S2. The header is unauthenticated and a single point of failure
- **Evidence:** `v`, `cipher`, `block`, `kdf` and `gen` are plaintext and bound to nothing. One damaged record loses the DEK.
- **Fix:** split it. A static part (`magic, v, cipher, block, kdf, wrappedDEK`) with the static fields as AAD of the DEK wrap, stored twice. A mutable part (`gen`, write counter, set MAC) encrypted under the DEK. `keyCheck` is then redundant, since a wrong KEK already fails the unwrap tag.

### S3. Short final blocks leak exact file sizes
- **Evidence:** section 4 says small files get "one short final block" and also that sizes are hidden "to the byte". Ciphertext length is plaintext length plus 28.
- **Fix:** pad every block to the unit size. The true size is already in the inode.

### S4. Claims that are wrong or imprecise
- **"This build also wraps MEMFS `stream_ops.write/close` … to call `queuePersist`."** Inactive in PGlite. The wrappers install only under `mount.opts.autoPersist` (`index.js`, `_?.opts?.autoPersist`), and `IdbFs` mounts with `{}` (`index.js`, `r.FS.mount(a,{},…)`). It is still a good template for the wrap.
- **"This is the race today's IDBFS ignores."** True but narrower. The puts happen in one synchronous loop (`pglite.js`, `IDBFS.loadLocalEntry(path,(err,entry)=>`), so the written files are one cut. The tear is between `getLocalSet` and `reconcile`, across the async `getRemoteSet`: a file changed in that window but absent from the change list is skipped. Change detection also compares millisecond mtimes for equality.
- **"Postgres's aligned writes never need a read-modify-write" as the reason for 8 KB.** That applies to option A. Under option B the plaintext is in MEMFS and any unit works.
- **"The same code serves the browser later (#554)."** #554 is parked, so this no longer weighs for IndexedDB.
- **`durability: "strict"` in WebKit.** Landed in Safari Technology Preview 130 (https://nolanlawson.com/2021/08/22/speeding-up-indexeddb-reads-and-writes/). I could not confirm the stable version. Chrome defaults to relaxed from 121 (https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/).
- **SQLCipher line drift:** `sqlite3_rekey_v2` is at L3839 (spec ~L3880) and the `cipher_integrity_check` pragma at L3442 (spec ~L2085). The design page does not mention the page number in the HMAC; the source does.

### S5. Open time and peak RAM are not gated
- **Record count:** a 100 MB database is 12,800 records and 12,800 WebCrypto calls at open, against about 1,000 `get`s today. Per-call overhead dominates at 8 KB. I did not measure it.
- **RAM:** `getAll` of the store holds ciphertext and plaintext together, about 2x the database. The first sync, migration and `rotateDataKey` in one transaction hold plaintext snapshot, ciphertext and structured clones, about 3x. That matters on iOS.
- **Fix:**
  - Add an open-time gate to the spike, measured in WKWebView, beside the 2x sync gate.
  - Read with key-range batches, and preallocate each file from its inode size.
  - Benchmark 32 and 64 KB units. They cut records and nonces 4-8x, and a 64 KB tail write is still tiny beside today's 16 MB.
  - Write first-population and rotation into a fresh database in several transactions, header last, then swap.

### S6. `gen` should fence stale writers
- **Risk:** a resumed old leader can write its dirty blocks over a newer store. The plain FS has the same hazard.
- **Fix:** read the header inside the same `readwrite` transaction and abort unless its `gen` equals the one this instance last loaded or wrote.

### S7. Failure and metadata paths are under-specified
- **Requeue:** "merge the snapshot's ids back" must also requeue deletes and skip inodes unlinked meanwhile.
- **Range delete:** unlink and rename-over-existing must delete every block of the dead `fileId`. The backend needs `deleteRange`, which `getAll / putBatch / deleteBatch` lacks.
- **Unlinked-but-open nodes:** Postgres writes to them. Ignore those writes.
- **Transaction lifetime:** state that no `await` on crypto happens inside the IndexedDB transaction, or it auto-commits half-filled.

### S8. `durability: "strict"` on every sync fights `relaxedDurability`
- **Reason:** atomicity does not depend on the durability hint. Strict adds an fsync per commit, the cost the app already chose to avoid (`pglite-worker.ts:54-60`).
- **Fix:** default to relaxed, and use strict for the flush on hide, close and migration.

### S9. Key handling gaps (mostly #1017)
- **The raw key crosses the page's JS heap.** "Non-extractable" then protects little. `tauri.conf.json` on `feat/97-tauri-shell` has `csp: null` and the capability is granted to the whole `http://localhost:47821` origin, so any script injection in the app can call the key command. Return raw bytes (not JSON), import with `wrapKey`/`unwrapKey` usages only, zero the buffer, and set a CSP.
- **The passphrase KDF belongs in Rust** (Argon2id), handing over a raw KEK. The package then supports `kdf: "raw"` only.
- **Recovery cannot count unsynced changes.** #1017 step 5 warns "with the count of unsynced changes", but that count is inside the database the lost key can no longer open. Keep the count outside, or word the warning without it.
- **Backups:** a device-only keychain item plus a backed-up webview profile restores to an undecryptable store. Choose the keychain accessibility class deliberately.

### S10. A Rust-side store was dismissed too quickly
- **Idea:** the feature is native-only now, so Rust can own storage. JS keeps the dirty-block tracking and sends blocks to a Rust store, for example SQLCipher itself as a `(file_id, idx, data)` table.
- **Gains:** the key never enters the webview (removing S9's main risk and #1017's STOP condition), real fsync, atomic transactions, rekey and a proven format with no custom cryptography.
- **Costs:** an IPC hop per sync (worker to page to Rust, or a custom URI scheme that workers can `fetch`, which I did not verify), binary IPC throughput, and no reusable IndexedDB package, which #553 asks for.
- **Fix:** put this in front of the owner as a decision now, not as phase 3. A one-day spike on IPC throughput would settle it.

## Nits
- Generate the DEK as 32 random bytes, import it non-extractable, encrypt the bytes under the KEK and zero them. That avoids an extractable `CryptoKey`.
- The write counter should count attempted encryptions, not committed ones.
- Cybertec's cipher mode stays unverified; it does not affect the design.
- Keychain rollback counters conflict with relaxed durability (a lost last transaction looks like tampering). Say so under Q1 as the reason for "no".
- Tests to add: rename over an existing file, unlinked-but-open writes, sparse write, fallocate growth, stale-leader fencing, header copy fallback.

## The six owner questions
- **Q1 (threat model):** right question, but it needs a per-platform table of what this adds over OS disk encryption. macOS keychain ACLs stop other apps; Windows Credential Manager and Linux Secret Service do not stop same-user processes. This is a paid feature, so the claim must be exact.
- **Q2 (two tiers):** fine. Recommend yes; the DEK also gives rotation at the nonce cap.
- **Q3 (8 KB):** fine, but widen it to "benchmark 8, 32 and 64 KB on sync and open time".
- **Q4 (leaks):** fine once S3 is fixed.
- **Q5 (leftovers):** wrongly framed. The auth token and shared secret are a blocker (B1), not a follow-up.
- **Q6 (app lock):** right question.

**Missing questions the owner must decide:**
1. IndexedDB package or Rust-side store (S10)?
2. Integrity level: per-record only, or the set MAC (S1)?
3. Durability: relaxed by default with strict on hide and close (S8)?
4. Does #1017 ship only together with the credential move (B1)?
5. Keychain accessibility and backup behaviour: is "restore from backup means reset and resync" acceptable?
6. An open-time budget for a 100 MB database on the slowest target.
