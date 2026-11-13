# SQLCipher and the planned encrypted PGlite filesystem, compared

Date: 2026-11-10. **[unverified]** marks what I did not check against a source. "Ours" is format v1 as specified in `05-format-v1-crypto-core.md` (PC-05) with the open and sync behaviour of `08-encryptedfs-open-sync.md` (PC-08). `PC-nn` are plan files in this folder, `J-nn` in `journal/`.

Sources for SQLCipher:
- Design: https://www.zetetic.net/sqlcipher/design/
- API and PRAGMAs: https://www.zetetic.net/sqlcipher/sqlcipher-api/
- Performance guidance: https://www.zetetic.net/sqlcipher/performance/
- `src/sqlcipher.c` constants and functions, as verified line by line in `docs/research/2026-11-10-review-fable-5.2.md`.
- SQLCipher 5.0.0-beta.1 and other prior art: `docs/research/2026-11-10-prior-art.md` (its author read `src/sqlcipher.c` at the tag; I did not re-read it).

Unless a row says "v5", "SQLCipher" means the stable version 4.

## 1. The structural difference

| | SQLCipher | Ours |
|---|---|---|
| Where the cipher sits | Inside SQLite's pager. Each page is decrypted when it is read from disk and encrypted when it is written | Under Postgres, in the PGlite filesystem. Postgres works on a plaintext copy of the whole data directory in memory (MEMFS) |
| When decryption happens | **Lazily, one page at a time**, as queries touch pages | **All at once, at open.** Every block of every file is read and decrypted before Postgres starts |
| When encryption happens | At every page write | At each sync (PGlite's durability point): only the blocks that changed since the last sync |
| What the store looks like | One file. A random 16-byte salt, then encrypted pages | One IndexedDB database. Two copies of a 168-byte opaque header, then equal-size encrypted blocks under random ids. The Postgres files, their names and sizes, and which block belongs to which file are in an encrypted file table that is itself some of those blocks |
| Plaintext in memory | The page cache | The whole database |
| Cost while querying | Per page read: one HMAC check and one AES-CBC decrypt | None |

This is not a choice we made for encryption. PGlite on IndexedDB already loads the whole data directory into memory at open and has no lazy path (`IdbFs` is Emscripten IDBFS, a MEMFS plus a reconciler). The lazy alternative (option A in the spec) needs synchronous storage and synchronous crypto, which the target webviews do not offer reliably. So against **today's Journal**, encryption adds cost at open and removes cost at sync. Against **SQLCipher**, we lose on open time and memory and win on query-time overhead.

## 2. Feature and security parity

Verdict column: **parity**, **stronger**, **weaker**, or **n/a**. Every "weaker" says whether an issue closes it or it is accepted.

| Property | SQLCipher | Ours | Verdict |
|---|---|---|---|
| Cipher and mode | v4 (stable): AES-256-CBC with HMAC-SHA512. v5.0.0-beta.1: AES-256-GCM | AES-256-GCM (WebCrypto) | **Parity.** We match where SQLCipher itself is going |
| Unit | One SQLite page, 4096 bytes by default in v4, 8192 in v5 beta | One block of a Postgres file, 8192 bytes by default; 32 or 64 KB if the spike says so. Recorded in the encrypted header | **Parity** |
| What is covered | Main file, rollback journal, WAL, statement journal. "Other transient files are not encrypted", so apps must keep temp storage in memory | Every file under PGDATA: heap, indexes, WAL, `pg_control`, `pg_xact`, catalogs, temp files, plus the number of files, their names, sizes and modes | **Stronger.** Nothing in the data directory is outside the cipher |
| IV / nonce | v4: a fresh random 16-byte IV per page write. **v5.0.0-beta.1** (2026-10-22): AES-256-GCM, a random 12-byte IV **and a one-time subkey per page write**, derived from 12 random bytes (SP 800-108 KDF over AES-CMAC, "modeled after XAES-256-GCM"), because plain random 96-bit IVs are only safe for 2^32 encryptions per key | A fresh random 96-bit nonce per record write, under a **subkey derived once per session** (HKDF-SHA256 of the data key with a random 16-byte salt stored in each record), at most 2^24 encryptions per subkey | **Parity with v5, by a cheaper route.** A subkey per record would cost four WebCrypto calls per block. Per session costs one, and still keeps every key about 2^8 below the NIST limit with no lifetime cap. The earlier plan (one key, a write counter, forced rotation at 2^30) is dropped. Cost: 16 more bytes per record, one `deriveKey` per distinct salt at open (spike item) |
| Integrity primitive | HMAC-SHA512 per page, 64 bytes, checked before decrypt | GCM tag per record, 16 bytes, checked by the decrypt | **Parity.** HMAC-SHA512 has a larger margin; a 128-bit tag is ample at these volumes |
| What the MAC binds | Ciphertext, IV, page number | Ciphertext, nonce, and as AAD: record type, a random per-store id, the key id, the file id, the block index. The random id a block is stored under is only its address; the authenticated file table says which file and index belong there | **Stronger.** A block cannot move to another position, another file or another store |
| Swapped units | Detected (page number in the HMAC) | Detected (AAD) | **Parity** |
| Modified unit | Detected | Detected | **Parity** |
| Truncation | Not detected by the cipher. SQLite's own page count (inside encrypted page 1) usually notices **[inferred]** | Detected: the file table holds each file's true size and the id of every block, and two digests cover every record | **Stronger** |
| Replay of an older version of one unit | **Not detected** (no version in the HMAC) | **Detected** inside one store: two digests in the encrypted root cover the current tag of every file-table block and every data block | **Stronger** |
| Deletion of a whole file | n/a (one file) | **Detected**: the file's blocks are listed in the file table and their records are gone. An attacker cannot even aim at a file, since nothing shows which records are its blocks. Without the check, losing the newest WAL segment would silently drop recent commits (review S1) | **Parity** for the user: both designs lose nothing silently |
| Rollback of the whole store to an older copy | Not detected | Not detected | **Parity, accepted.** A counter outside the store (in the keychain) would catch it, but relaxed durability can lose the last sync after a crash, and that would look like an attack |
| Header and salt | 16-byte random salt in the first 16 bytes; the rest of page 1 is encrypted; the file is indistinguishable from random | A 168-byte header, stored twice, in which only random nonces and salts are readable: the wrapped data key, and an AEAD envelope that holds version, cipher, block size, store id and key id. No magic, no version and no name in clear, in the header or anywhere else; the IndexedDB database has a neutral name chosen by the app and one object store called `kv`. A reader learns the version by opening the envelope, so an old app says "written by a newer version" and not "wrong key" | **Parity.** No byte and no name says that the store is a pglite-cipher or Journal store. What stays visible: that an IndexedDB database exists in the app's own profile folder, and its shape (two short values, the rest of one length), as a SQLCipher file is a high-entropy file of whole pages in the app's folder. On robustness it remains **stronger**: two header copies replaced together, and a changed or downgraded version or cipher fails authentication |
| Plaintext header option | `cipher_plaintext_header_size` (for iOS shared containers) | Not needed: no other process reads the store | **n/a** |
| Key derivation | PBKDF2-HMAC-SHA512, 256,000 iterations, for passphrases | None. The key is 32 random bytes | **n/a** in the shipped apps: there is no passphrase. **Weaker** if a passphrase is ever wanted (Linux without a keyring, owner question 5); the plan puts that KDF (Argon2id) in Rust, never in the package |
| Raw key | `x'…'` hex key skips the KDF | The only mode | **Parity** |
| Key hierarchy | One key (the MAC key is derived from it) | Two tiers: the keychain key (KEK) wraps a random data key (DEK) | **Stronger**: see rekey |
| Key storage | The application's job | The application's job: OS keychain (J-04, J-13, J-14) | **Parity.** The strength is the keychain's, and it varies by platform (`00-overview.md` 2.2) |
| Wrong key | Page 1's HMAC fails; the error is "file is not a database", the same as corruption | The DEK unwrap fails with `WrongKeyError`; corruption is `CorruptStoreError`; nothing is loaded in either case. With an opaque header a failed unwrap alone cannot say which it is; the two copies do: identical copies that both fail are a wrong key, copies that differ are damage. The one case left as SQLCipher has it: both copies overwritten with the same bytes reads as a wrong key | **Stronger**: the app can tell "key lost" from "data damaged" and offer the right recovery |
| Rekey | `PRAGMA rekey`: every page re-encrypted in one transaction. Cost grows with the database | `changeKey`: re-wrap the DEK, one small write, instant. `rotateDataKey`: re-encrypt everything into a fresh store, resumable | **Stronger**, with one caveat: after an instant `changeKey`, someone who kept the old header **and** the old KEK can still read. Only `rotateDataKey` fixes that. Settings exposes them as one action, "Use a new key" (J-11) |
| Integrity check command | `PRAGMA cipher_integrity_check` | `verify()`, and **every open is a full check**, because every record is decrypted | **Stronger** |
| Metadata leakage | File size (to the page). One file, so no names or counts. Two copies show which pages changed | The total number of blocks (the size of the store to the block; file-table blocks and data blocks are counted together and cannot be told apart) and write timing: two copies show which records changed, and one copy shows which records were last written in the same session, because a session's records share a 16-byte salt. Hidden: the number of files, every file's size, name and mode, and which block belongs to which file | **Parity.** Exactly three things remain visible: the total block count, write timing, and the existence of an IndexedDB database. The one difference inside "write timing" is the session salt, which SQLCipher 5 avoids by drawing subkey context per page write; closing it would cost one key derivation per record |
| Memory: key material | Its allocations are `mlock`ed when possible and wiped on free | Keys are non-extractable `CryptoKey`s held by the webview's crypto layer. JavaScript cannot lock or reliably wipe memory. The raw KEK crosses the page's heap once (zeroed after import); DEK bytes exist briefly at create and rotate. Rust uses `zeroize` | **Weaker, accepted**, reduced by PC-05, J-04 and J-07 |
| Memory: data | The page cache (a few MB by default) | The whole database | **Weaker, accepted** (it is the same without encryption). The app lock (J-12) ends the worker, which frees it |
| `cipher_memory_security` | Optional full sanitisation, off by default "due to performance impact" | No equivalent | **Weaker, accepted** |
| FIPS / compliance builds | Enterprise packages with a FIPS-validated provider (`cipher_fips_status`) | None. WebCrypto calls the platform's crypto library, but our composition is not validated | **Weaker, accepted.** Never claim FIPS |
| Cipher agility, versioning | `cipher_compatibility`, per-database page size, KDF and HMAC settings that must be repeated at every open | One suite in v1. Version, cipher and block size are in the encrypted, authenticated header; an unknown value refuses to open with its own error | **Parity.** Fewer knobs, and none that the caller must remember |
| Migration tooling | `sqlcipher_export()` both ways, `cipher_migrate` between versions | Plaintext → encrypted import with per-file verification (PC-10). Encrypted → plaintext is `dumpTar` / `pg_dump` | **Parity** once PC-10 is in |
| Durability | SQLite journaling with `fsync` | One IndexedDB transaction per sync; relaxed durability by default, strict on hide, close, migration and rotation | **Weaker, accepted, and not caused by encryption**: Journal runs relaxed today. Crash **consistency** is the same: a sync is all or nothing |
| Random access to a big database | Yes | No: all of it is loaded | **Weaker, accepted** (PGlite on IndexedDB has the same limit unencrypted) |
| Maturity | In production since 2008, in very wide use, public source, long public review | New code in a private repository. No external review | **Weaker.** Reduced, not closed: only standard primitives through WebCrypto, a written format (`FORMAT.md`), test vectors, property and fuzz tests, crash injection, three browser engines, a frozen reference store (PC-05–PC-11). An external review is owner question 11. Never say "audited" before one exists |

Count: stronger in 8 rows, weaker in 7 (1 reduced, 6 accepted), parity or n/a in the rest. Nothing about what the stored bytes reveal is weaker any more: the two rows that were ("Header and salt", "Metadata leakage") are at parity since the header became opaque and the store a packed block space. The seven that remain fall in three groups: JavaScript cannot manage memory the way C can (key material, no memory sanitisation); PGlite keeps the whole database in memory and persists it through IndexedDB (data in memory, no random access, relaxed durability); the code is new (maturity, no FIPS build).

## 3. Performance

### 3.1 SQLCipher's published numbers

- Zetetic: "It's not unusual to see as little as 5-15% overhead for SQLCipher encryption." (performance page). This is the vendor's figure for well-tuned applications. I found no independent, controlled benchmark that confirms the range; community posts report anything from near zero to 2× on single operations (for example a DELETE without an index going from 0.458 s to 1.094 s in one mailing-list post whose test script was later found mislabelled, so treat it as an anecdote: https://groups.google.com/g/sqlcipher/c/cTkqu4al_iE).
- Open is the expensive step with a passphrase: 256,000 PBKDF2-HMAC-SHA512 iterations per connection. Zetetic's first guideline is "Do NOT repeatedly open and close connections." With a raw key the KDF is skipped and open costs one page.
- Larger pages can help: "5-30%" in some of Zetetic's tests (API page, `cipher_page_size`).
- Full memory sanitisation is off by default "due to performance impact".

- Other measured points from prior art (`docs/research/2026-11-10-prior-art.md`): Turso reports 6 % read and 14 % write overhead for native page encryption with AEGIS-256. Evolu, which runs a SQLCipher-format codec inside WASM (no AES instructions there), measures 40–70 µs to decrypt an 8 KiB page and about +2.5 ms per small commit. The Node-only pglite-encrypted-fs, which encrypts synchronously on every write, reports +93 % on bulk inserts and +138 % on reopen. None of these is our design; they bound what the alternatives cost.

### 3.2 Our expected costs

**Measured on this machine (not a webview):** Node 24 WebCrypto (OpenSSL), ROG G14, AES-256-GCM with 24 bytes of AAD, a fresh random nonce per call, 64 calls in flight. Script: `gcmbench.mjs` in this folder; the spike reruns it in each browser and webview.

| Data | Unit | Calls | Encrypt | Decrypt | Per call |
|---|---|---|---|---|---|
| 10 MB | 8 KB | 1,280 | 34 ms | 28 ms | 22–27 µs |
| 100 MB | 8 KB | 12,800 | 250 ms | 258 ms | 20 µs |
| 100 MB | 8 KB, one call at a time | 12,800 | 653 ms | 823 ms | 51–64 µs |
| 100 MB | 32 KB | 3,200 | 123 ms | 159 ms | 39–50 µs |
| 100 MB | 64 KB | 1,600 | 88 ms | 110 ms | 55–69 µs |

Reading: at 8 KB the per-call overhead dominates, not AES. Throughput is 390 MB/s at 8 KB and 900–1,100 MB/s at 64 KB. Calls must run in batches, not one `await` at a time (3× slower).

**Webviews: [unverified].** I have no trustworthy published per-call WebCrypto numbers for WKWebView, WebView2 or WebKitGTK. Expect the same shape with a larger per-call cost. The estimates below assume 2–5× the Node per-call cost and are there to size the gates, not to be quoted.

| Cost | Today (plain `idb://`) | Ours, estimate | Why |
|---|---|---|---|
| **Open, 10 MB** | Read about 1,000 file records | +0.05–0.3 s | 1,280 decrypts, more and smaller records to read, and a few file-table blocks first |
| **Open, 100 MB** | Read the same bytes as whole files | **+0.5–4 s** at 8 KB; about a third of that at 64 KB | 12,800 decrypts and 12,800 IndexedDB values instead of about 1,000. **This is where we are slower, both than today and than SQLCipher with a raw key (which opens in milliseconds at any size)** |
| **Open: the file-table indirection** | – | Small beside the rows above **[unverified]**: about 40 more blocks to fetch and decrypt at 100 MB and 8 KB (16 bytes of block id per block is 0.2 % of the data, plus roughly 100 bytes per file), one map lookup per block, and blocks that arrive in the order of their random ids instead of file by file | Gate G9. The blocks are still read in key order, which is the cheap order for IndexedDB; only the copy into memory is scattered |
| **Per commit, small edit** | Every changed file is rewritten whole. A dirty WAL page rewrites its 16 MB segment (`pglite-worker.ts:54-56`) | 2–5 data blocks and 1 root block. When a file is created, grows, shrinks, is renamed or removed, 1–2 file-table blocks more. Tens of KB at 8 KB blocks and under 1 ms of crypto | **Expected to be much faster than today**, by the ratio of bytes written (hundreds of times fewer). The 2× gate from #553 should pass with a wide margin; the gate that matters is open time. A block is rewritten under the id it already has, so a commit that only changes contents writes no file-table block |
| **New WAL segment** | 16 MB written once | 2,048 block records at 8 KB (256 at 64 KB) and about 5 file-table blocks for their ids, in one sync: about 40–250 ms of crypto plus the IndexedDB write. A recycled segment (a rename) writes file-table blocks only | An occasional spike; measured as gate G4 |
| **Query time** | – | **0 %** | Postgres reads plaintext memory. SQLCipher pays its 5–15 % here |
| **RAM, steady** | 1× the database | 1× + 0.2 % (the tag table) + the block-id map: 16 bytes of id per block (0.2 % at 8 KB) plus the map's own overhead **[unverified]** | G3 measures it |
| **RAM, peak at open** | 1× + the largest file | 1× + two read batches (the next is read while one decrypts: about 64 MB at 64 KB blocks and batches of 512; owner decision on #10). A naive `getAll` would be 2× | Review S5; PC-08 mandates batches |
| **RAM, first population and rotation** | – | 1× + one batch, written in several transactions with the header last. A single transaction would be about 3× | Issues 08, 09 |
| **App-lock unlock** | – | Equals open time, if locking closes the database (owner question 3) | |

A fresh PGlite data directory is tens of MB before any note exists (catalogs plus one 16 MB WAL segment) **[unverified exact size; the spike records it]**, so every user pays roughly the "10–50 MB" row at each launch.

### 3.3 What the spike must measure, and the gates

These gates are in the spike (PC-03) and become CI gates in PC-11 and checklist items in J-16. "Slowest target" is an iPhone in WKWebView unless the owner names another (owner question 4).

| Gate | Measure | Pass |
|---|---|---|
| G1 sync | p50 and p95 time of the sync after a one-row `UPDATE`, 100 MB database, against plain `idb://` in the same run | Encrypted p50 ≤ 2× plain (the #553 rule). Expected: well under 1× |
| G2 open | Time from `initialSyncFs` start to Postgres ready, 10 MB and 100 MB, against plain `idb://` | ≤ 2× plain **and** ≤ the absolute budget: 100 MB in 1.5 s on desktop, 3 s on the slowest target; 10 MB in 400 ms (recommended budgets, owner question 4) |
| G3 memory | Peak worker heap at open and during first population | Open ≤ database + 64 MB; population ≤ 1.5× database |
| G4 segment switch | Sync time when a new 16 MB WAL segment appears | ≤ 500 ms on desktop, ≤ 1 s on the slowest target |
| G5 unit size | G1, G2 and G4 at 8, 32 and 64 KB | Pick the smallest unit that passes G2. Record the choice in the header default |
| G6 support | AES-GCM, HKDF `deriveKey` to AES-GCM, `unwrapKey` into an HKDF key, IndexedDB `durability: "strict"` and `"relaxed"`, number and string keys in one object store (numbers first), key-range `getAll` over string keys, in WKWebView, WebView2, WebKitGTK, Android WebView | All present, or a named fallback |
| G8 subkeys | Number of distinct session salts in a store after a simulated year of use (365 sessions, each with edits and checkpoints), and the cost of one `deriveKey` | Their product ≤ 10 % of the G2 budget |
| G9 file table | The cost of the packed block space. At open: time from the first read to a complete file map (root, file-table blocks fetched, decrypted and assembled), 10 MB and 100 MB. Per sync: file-table blocks written, over the whole workload and in the G1 sync | Open part ≤ 5 % of the G2 budget. The G1 sync (a one-row update that grows no file) writes **no** file-table block. The rest is recorded |
| G7 Rust store throughput | 100 MB of 8 KB and 64 KB blocks written and read through Rust: page-relayed `invoke` with binary payloads (report whether Tauri used its `fetch` transport or fell back to `postMessage`), and a loopback endpoint with a per-launch secret called from the worker | Recorded, then used for owner question 2 at the gate: it prices both a Rust file backend for our ciphertext and a Rust-side SQLCipher store |

If G2 fails at every unit size on a target, that is a STOP: the options then are the Rust backend, lazy loading of cold files (a format change), or accepting a slower launch for large databases.

## 4. What to tell customers

Accurate, and safe to publish once J-16 is closed for the platform:

> Journal's desktop and mobile apps encrypt everything they store on your device: your notes, their history, search data, your contacts and circles, and your sign-in. They use AES-256, with a key that your operating system's secure key storage holds (Keychain on Apple devices, the Windows credential store, the Linux keyring, the Android Keystore). A copy of the app's files, or a backup of them, is unreadable without that key. You can add a lock that asks for Touch ID, Face ID, Windows Hello or your fingerprint before the app opens.
>
> What this does not do: it does not protect your notes from software that runs on your computer under your own account while Journal is open, and on Windows and Linux other programs you run can ask the system for Journal's key. It does not cover files you export or a notes folder you choose to mirror. Keep your device's own disk encryption and screen lock on; Journal's encryption works with them, not instead of them.

Do not say: "military grade", "audited", "FIPS", "zero knowledge" (that is Homebase's property, not this feature's), "the same as SQLCipher", or "protects against malware".

Fair comparison to SQLCipher, if asked: "The same idea, encryption underneath the database engine with a fresh random nonce and an integrity check on every block, adapted to Postgres. Like a SQLCipher file, the stored data shows how big it is and when it changes, and nothing about what is inside. It covers more of the database's files and detects more kinds of tampering. It is newer, keeps the open database in memory, and takes longer to open a large database."

## 5. Native PostgreSQL encryption, compared

Date: 2026-11-12. Sources: Percona pg_tde release notes 2.1.2 and 2.2.0 (https://docs.percona.com/pg-tde/), the pgconf.de 2026 talk "Status update on TDE in PG", the pg_vault_tde 1.7.1 announcement on postgresql.org. **[unverified]** marks vendor claims I did not test.

Community PostgreSQL has **no built-in transparent data encryption** (TDE). Patches have been discussed for years and none is in core. What exists:

| Option | What it is | Covers | Fits PGlite? |
|---|---|---|---|
| `pgcrypto` | SQL functions (`pgp_sym_encrypt`, `encrypt`, `digest`) | Only the values the application encrypts in queries. Catalogs, indexes, WAL and everything else stay plaintext | Runs, but it is not encryption at rest, and encrypted columns can't be indexed or searched |
| Percona `pg_tde` | Extension, open source, 1.0 GA, 2.2.0 on 2026-05-20 (AES-256) | Table data and WAL. Temp-file encryption is on its 2026 roadmap. No column-level encryption **[unverified]** | No. It needs Percona's patched server (hooks community Postgres lacks), and a key provider (file, Vault or KMIP). Caveats in its own notes: no `pg_upgrade`, possible corruption with `pg_rewind` |
| `pg_vault_tde` (Miriade) | Extension inside the public extension API, PostgreSQL 17 and 18 | Per its announcement, table data **[unverified]** | Not tried. It expects a Vault key server and a server build, not WASM |
| EDB, Fujitsu Enterprise Postgres | TDE in commercial builds | Cluster-wide **[unverified]** | No: proprietary server builds |
| Disk encryption (LUKS, BitLocker, FileVault) | Below the filesystem | Everything, while the machine is off | Not in a browser or webview. It is what the OS offers anyway, and it doesn't protect a running, unlocked machine |

Where ours differs from server TDE:

- **No Postgres patches.** The cipher sits under Postgres in the PGlite filesystem, so PGlite and Postgres upgrade independently of it, as long as the filesystem contract holds (the conformance suite pins it).
- **Wider coverage than pg_tde today:** catalogs, temp files, `pg_control`, `pg_xact`, and the file names, sizes and count are all inside the cipher.
- **Key handling:** the key comes from the OS keychain through the app (`00-overview.md` 2.2), not from a key server. That suits one-user apps on a device; server TDE suits many users and key rotation by operators.
- **Same threat model as server TDE:** both protect data at rest (a copied disk or store, a lost device) and neither protects against code running inside the process while the database is open.
- **Weaker in maturity.** pg_tde has a company, users and public review behind it. Ours has none of that yet (section 2, "Maturity").
