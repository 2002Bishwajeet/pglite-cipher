# Owner answers (2026-11-10)

The owner said: "go with what Fable suggests". So every question below is answered with its recommendation:
1 = **A** (encryption in the first public native build; PC-10 and J-08 not filed) · 2 = **A** (IndexedDB, our format) · 3 = **A** (real lock) · 4 = the recommended budget (100 MB: 1.5 s desktop, 3 s slowest phone; the phone is named in PC-04b) · 5 = A · 6 = accept · 7 = app-level gate · 8 = allow both, never silently · 9 = accept · 10 = FLAG_SECURE only with the lock · 11 = external review before any public claim · 12 = J-15's window now · 13 = the placeholder from PC-02 until the owner names the holder · 14 = keep them public.
PC-04 applies the decision table provisionally to the engines an agent can measure; device runs are PC-04b and block nothing.

---

# Owner questions

Only decisions that are yours. Each has options and my recommendation. Decisions you already made on 2026-11-10 (native-only, SQLCipher's design adapted to PGlite, keys and credentials in the keychain, query cache in PGlite, wipe leftovers, quality over speed, private repository, optional submodule, premium stays private) are applied in the plan and not asked again.

Questions 1–4 block work. The rest can be answered when their issue comes up; each issue proceeds with the recommendation unless you say otherwise.

---

## 1. Does any native build without encryption reach users?  *(blocks PC-10 and J-08)*

No public native build exists today. If encryption is in the first one, no user ever has a plain-text native database, and two things disappear: the migration (the riskiest code in the plan for data loss, review B2) and the unanswerable part of "wipe every leftover" (deleted IndexedDB pages can survive on disk whatever we do).

| Option | Effect |
|---|---|
| **A. Encryption is in the first public native build (TestFlight and beta builds count as public).** | Close PC-10 (import) and J-08 (migration) as not planned. Testers with a plain database get J-10's "download again". The claim "the native app never wrote your notes unencrypted" becomes true |
| B. Desktop v1 ships first, encryption follows | Keep PC-10 and J-08. Settings must say "remnants may remain on disk" for those installs, permanently |

**Recommendation: A.** It is the only way decision 5 can be fully met. It moves M4 ahead of the public release in #306, not ahead of the work on M3.

## 2. Where does the encrypted store live?  *(decided at the gate PC-04, with gate G7's numbers; the review's S10)*

| Option | What it is | For | Against |
|---|---|---|---|
| **A. IndexedDB, our format** (the plan as written) | `pglite-cipher` encrypts in the worker with WebCrypto and writes records to IndexedDB | No native code in the data path; atomic transactions for free; one implementation on all five platforms; the package is the reusable asset; hardware AES through WebCrypto | A new format (ours to get right); the key passes through the webview; depends on each webview's IndexedDB durability |
| B. Rust file, our format | Same package and crypto; ciphertext records go to a Rust-managed file instead of IndexedDB | Real `fsync`; iOS file-protection classes and backup flags per file; not tied to the webview profile or the port | Blocks hop worker → page → Rust (or a loopback endpoint); atomic commits must be built in Rust; key still in the webview |
| C. SQLCipher in Rust as the block store | The dirty-block tracker stays in JS; blocks go to Rust in plain text and into a SQLCipher database keyed straight from the keychain. This is how Signal and Notesnook desktop are built | **No format of our own** (removes the "new, unaudited" row in `01`); **the key never enters the webview**; native crypto; `rekey` and integrity check exist | Plain blocks cross IPC or loopback on every sync and all of them at open; SQLCipher must cross-compile for iOS and Android; SQLCipher 5 (GCM) is beta, so it would be version 4 (CBC + HMAC) today; the pglite-cipher package shrinks to tracker + filesystem shell, with its crypto unused by Journal; an XSS in the app still reads everything through the database |

What changes with C: PC-05 shrinks to the manifest-free record layout (no crypto core), PC-07 becomes the Rust store issue below, PC-09 becomes a thin wrapper over `PRAGMA rekey` and `cipher_integrity_check`; PC-06, PC-08's open and sync state machine, PC-10 and every Journal issue stay.

**Recommendation: A, unless G7 shows that Rust is fast enough on every platform including the iPhone *and* you weigh "no cryptographic format of our own" above "a reusable package".** A is what your decision 2 describes, it has the fewest moving parts on mobile, and its real weakness (new code) is what PC-05–PC-11 spend their tests on. If the spike fails gate G2 or G6 on IndexedDB, choose B before C: it keeps everything built so far. I would choose C from the start only if you plan an external claim that needs a known format.

Issue stub if B or C is chosen (file in `2002Bishwajeet/journal`):

> **Native: Rust block store for the encrypted database.** Context: PC-04's comment says `Store: rust-file | rust-sqlcipher`. Change: `src-tauri/src/block_store.rs` implementing pglite-cipher's `StorageBackend` semantics (PC-07's conformance suite is the contract: `isEmpty`, `count`, `get` of the three slots, `getMany`, paged `readRange` over opaque block ids, all-or-nothing `commit` with `expectRoot` and deletes by id, `clear`) over (B) a file of equal-size slots with a slot index and a free-slot list of its own, plus a metadata log with a generation pointer, `fsync` and directory `fsync` (the index maps opaque ids to slots and reveals nothing more), or (C) `rusqlite` with `bundled-sqlcipher`, one table `record(key, body)` for the same slots and block ids, one SQLite transaction per commit, the key set with `PRAGMA key = "x'…'"` from the keychain inside Rust. Transport: the faster of G7's two paths; a loopback endpoint requires the per-launch secret. A TypeScript `RustBackend` in Journal that passes PC-07's conformance suite through the real IPC in a Tauri test build. Verification: the conformance suite, the crash matrix with the process killed (`kill -9`) at every commit, G1–G4 on the bench page. STOP: SQLCipher does not build for iOS or Android; throughput below G7's recorded numbers. Depends on: #101, #553. Size: L.

## 3. What does "locked" mean?  *(the spec's Q6; shapes J-12, J-13, J-14)*

| Option | Effect |
|---|---|
| **A. Real lock:** close the database, drop keys and credentials by reloading into a lock screen, Rust refuses secret commands | Nothing readable in the page's memory while locked. Unlock costs a full open (the budget of question 4). No sync or notifications with content while locked |
| B. Curtain: cover the window, keep everything open | Instant unlock. Database and keys stay in memory; a determined person at the keyboard (devtools in a debug build, a memory dump) is not stopped |

**Recommendation: A**, with auto-lock off by default and choices of 1, 5, 15, 60 minutes in the background. A paid "lock" that leaves the data open would be the kind of overclaim this plan is trying to remove.

## 4. Open-time budget, and which device is "slowest"?  *(sets gate G2; answered on PC-04)*

Every launch, and every unlock under 3A, decrypts the whole database. **Recommendation:** 100 MB in 1.5 s on desktop and 3 s on the slowest supported phone; 10 MB in 400 ms; slowest target = the oldest iPhone you will support (name it). If the spike cannot meet it at 8 KB blocks, take 32 or 64 KB before relaxing the budget.

## 5. Linux without a usable keyring (no Secret Service on the session bus)

| Option | Effect |
|---|---|
| **A. Run without encryption and say so** in Settings ("Not encrypted: this system has no keyring that Journal can use") | No data-loss path; honest; rare |
| B. Ask for a passphrase at every start (Argon2id in Rust) | Encrypted everywhere; a forgotten passphrase means "download again"; new UI, new recovery states |
| C. Refuse to start | Simple; hostile |

**Recommendation: A for v1**, B later if users ask. The app never falls back to a file or to the kernel keyutils store (keys vanish at reboot).

## 6. A restore from backup, or a new device, means "download your notes again"

Mobile keys are device-only by design; a desktop restore usually brings the keychain along. Unsynced changes in a restored store are unreadable. **Recommendation: accept**, with the wording in J-10. The alternative (keys that travel in backups) puts the key next to the data it protects.

## 7. macOS app lock: app-level gate, or bound by the OS?

An OS-enforced binding (the key is released by the Secure Enclave only after Touch ID) needs the data-protection keychain, which needs an application-identifier entitlement and a provisioning profile even for Developer ID builds **[unverified detail]**. **Recommendation:** ship the app-level gate (J-12) and say so in Settings; revisit when #305 settles signing. iOS and Android can bind in the OS from the start if you want it (it then also invalidates on new biometric enrolment, which costs a "download again" for some users): I recommend the gate there too, for the same behaviour on every platform.

## 8. Markdown mirror (#1015) together with encryption

The mirror writes every note as a plain `.md` file. **Recommendation:** allow both; never silently. Settings → Security lists the folder under "Stored unencrypted", and turning the mirror on says so once. Alternative: make them mutually exclusive (cleaner claim, removes a desktop selling point).

## 9. Images that notes load from the web, offline

Today the service worker keeps them on disk (keyed by URL). In native, J-09 stops that: they show only when online. **Recommendation: accept.** Alternative later: an image table inside the encrypted database.

## 10. Android screenshots

`FLAG_SECURE` hides the recents thumbnail and blocks screenshots. **Recommendation:** on only while the app lock is enabled; without the lock, a cover in recents and screenshots allowed. iOS gets the app-switcher cover always (no cost).

## 11. An outside review of the format before it is advertised

The format is small (one document, `FORMAT.md`, and about 300 lines of crypto core), built only from WebCrypto primitives, and private. **Recommendation:** before the first public claim, pay for a one- or two-day review of `FORMAT.md` and `src/format/` by someone who does this for a living, and say "independently reviewed" only after that. Until then use the customer text in `01` section 4 and never the word "audited".

## 12. Sign-in on desktop: ephemeral window, or the system browser?

J-15 opens the Homebase owner console in an in-app window that keeps nothing on disk. The user types the Homebase password at every sign-in to Journal, and a password manager or passkey may not work inside a webview. The standard for native apps (RFC 8252) is the system browser with a loopback redirect, which Journal's fixed port makes possible, at the cost of a `state` check and a hand-off page. **Recommendation:** ship J-15's window now (small, closes the gap); move to the system browser if J-15's manual check shows that password managers cannot fill the console.

## 13. Licence text and copyright holder for pglite-cipher

PC-02 writes a placeholder ("All rights reserved … MIT is the intent") and does not invent a legal name. With "premium stays private" the repository may never be public. **Needed from you:** the holder's name for the notice, and whether "MIT is the intent" should stay in the README.

## 14. How much of the Journal-side native code is "premium"?

The plan keeps only the filesystem private. The keychain commands, the lock, the sign-in window and the wiring are in the public Journal repository (`src-tauri/`, `src/lib/native/`), compiled out of the PWA. That fits "public code is the PWA and the rest of the open app" if the native shell counts as open; it does not if "native-only code lives in private repos" is meant strictly. **Recommendation:** keep them public: they hold no secret design, outside eyes on key handling help, and #306 says anyone may build the apps from source (without encryption, since the submodule is private). Say so if you want the lock or the keychain code moved into a private crate; J-04 and J-12 are then filed in a private repository with the same text.

---

## Decided in the plan, within your stated direction (object if you disagree)

| Topic | Decision | Why |
|---|---|---|
| Integrity level (review's question 2) | Per-record tags **plus a manifest digest** over the whole store | Detects deleted files and replayed records for one hash per sync; cheaper than the review's set MAC |
| Whole-store rollback (spec Q1) | Not detected | Matches SQLCipher; a counter outside the store would misfire under relaxed durability |
| Nonce budget | HKDF subkey per session, no forced rotation | SQLCipher 5's answer, at WebCrypto's cost |
| Two-tier keys (spec Q2) | Yes; `changeKey` instant, `rotateDataKey` full; Settings offers one action that does both | |
| Block size (spec Q3) | 8 KB unless the spike picks 32 or 64 | Decided by gate G5 |
| Leaks (spec Q4) | The total number of blocks, write timing, and that an IndexedDB database exists. Not the file count, the file sizes, or that it is a pglite-cipher store (your two changes of 2026-11-10: opaque header, packed block space) | Parity with SQLCipher on what the stored bytes show; `01` section 2 has the exact list, including the one difference (a session's records share a salt) |
| Durability (review's question 3) | Relaxed by default; strict on hide, close, import, rotation | Confirmed on PC-04's `Durability:` line |
| Credentials with encryption (review's question 4) | A release rule: no "encrypted at rest" without J-05, J-06, J-09, J-15, J-16 | Review B1 |
| Migration trigger | Automatic at first boot, never a setting; three failures then a button | "Secure, don't block" |
| Recovery warning | No count of unsynced changes | The count is inside the unreadable database |
| `identity` in `localStorage` | Left in clear | A domain name, not a secret |
| Package tests | Every behaviour test in Node and in Chromium, Firefox, WebKit | Webview crypto and IndexedDB differ |
