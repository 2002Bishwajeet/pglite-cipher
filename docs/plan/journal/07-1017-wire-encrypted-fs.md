<!--
FILING: REWRITES 2002Bishwajeet/journal#1017 (replace its whole body with this; keep the number).
New title: Native: open the local database through pglite-cipher with the keychain key
Labels: keep agent-ready, security. Add agent-ready back only when 2002Bishwajeet/pglite-cipher's EncryptedFs issue (plan file 08) is closed.
What moved out of the old #1017: keychain key → J-04; credentials → J-05; app lock → J-12 (desktop), J-13, J-14 (mobile); migration → J-08; recovery → J-10; Settings → J-11; "what stays unencrypted" → closed as gaps by J-03, J-05, J-06, J-09, J-15.
-->
## Context
Epic #555; Pro plan #306, milestone M4. The native apps encrypt the local database. The pieces exist: `pglite-cipher` (a private, optional submodule at `vendor/pglite-cipher`, wired in by #553) provides `EncryptedFs`, a PGlite filesystem that keeps Postgres in memory and writes AES-256-GCM-sealed blocks to IndexedDB in one transaction per sync; #<J-04> provides the key from the OS keychain as a non-extractable `CryptoKey`. This issue joins them in Journal's database worker and gives the boot a state machine, because "which database do I open" now has more than one answer and a wrong answer destroys data.

Cross-repository dependency (not expressible on the `Depends on:` line): `2002Bishwajeet/pglite-cipher` must have `EncryptedFs` merged (its plan file `08-encryptedfs-open-sync.md`). This issue bumps the submodule pin to a commit that has it.

How the database boots today (`src/lib/db/pglite.ts`, `src/lib/db/pglite-worker.ts`):
- The page creates a `Worker` and calls `PGliteWorker.create(worker, options)`. `options` is posted to the worker verbatim (structured clone), and the worker's `init(options)` picks fields explicitly: "a flag only reaches the engine if it is named here". A `CryptoKey` survives structured clone.
- The worker builds `TimedIdbFs` (plain IndexedDB, with boot marks and one-at-a-time flushes) on `idb://journal-db-pg18` with `relaxedDurability` on. A `journal-flush` message makes the worker call `openFs.syncToFs()` directly; the page sends it when the page is hidden.
- Any tab's worker can become the leader that owns the database, so **every window needs the key**.
- A failed boot is cached and shown by `BootErrorScreen`; only `retryDatabase()` tries again.

PGlite 0.5.10 does not reliably sync when it should: `pg.syncToFs()` returns without syncing when a sync is already queued (electric-sql/pglite#1191), and `transaction()` can commit without a following sync (#1065, fix still an open PR). `EncryptedFs` keeps dirty state until a sync really commits it and offers `hasDirty()`; the host has to call it.

Encryption is for native builds only (`VITE_NATIVE_ENCRYPTION=1`, see #553). The PWA never contains this code path.

## Change
1. **Pin and build.** Bump `vendor/pglite-cipher` to the commit named in the closing comment of pglite-cipher's EncryptedFs issue. Extend `src/lib/db/cipher/index.ts` and `unavailable.ts` (from #553) with the names used here. Set `beforeBuildCommand` in `src-tauri/tauri.conf.json` to `npm run build:native`.
2. **Decide the mode** in a pure function, `src/lib/db/dbMode.ts`, unit-tested as a table:
   ```ts
   type DbMode =
     | { kind: "plain" }                                   // web; or native without the cipher build
     | { kind: "plain-unprotected"; reason: "no-keychain" }  // native, no usable keychain
     | { kind: "encrypted"; open: "open" | "create" }
     | { kind: "needs-migration" }                         // native, plain database exists, no encrypted store (#<J-08>)
     | { kind: "blocked"; reason: "key-lost" | "keychain-unavailable" | "backend-changed" | "store-missing" };
   resolveDbMode(input: { native: boolean; cipherEnabled: boolean; secrets: SecretsStatus | null; encryptedStore: "none" | "present"; plainStore: "none" | "present" }): DbMode
   ```
   | Keychain | Encrypted store | Plain store | Key | Mode |
   |---|---|---|---|---|
   | ok | present | any | present | `encrypted/open` (a leftover plain store never wins; #<J-09> deletes it) |
   | ok | present | any | absent, `dbKeyEverCreated` or not | `blocked/key-lost` |
   | ok | present | any | unreadable | `blocked/keychain-unavailable` |
   | ok | none | present | any | `needs-migration`; until #<J-08> lands this opens `plain` and Settings says "not encrypted yet" |
   | ok | none | none | absent, never created | `encrypted/create` |
   | ok | none | none | present or ever created | `blocked/store-missing` (the system removed the data; #<J-10> explains and recreates) |
   | backend changed | any | any | – | `blocked/backend-changed` |
   | unavailable | none | any | – | `plain-unprotected` |
   | unavailable | present | any | – | `blocked/keychain-unavailable` |
   "Encrypted store present" = an IndexedDB database named `data.a` or `data.b` exists (use `indexedDB.databases()`, with the open-and-check fallback `pglite-migrate.ts` already has for engines that lack it; never create a database while checking). The name is `ENCRYPTED_STORE_NAME = "data"`, one constant in `src/lib/db/pglite.ts`, and it is neutral on purpose: the package adds nothing to the name it is given, and nothing in the database (its name, its one object store `kv`, its keys, its values) says that it is Journal's or that it is encrypted. Do not rename it to something descriptive. A random name would hide no more: the database sits in the app's own profile folder, and the boot has to find it before any key or setting can be read.
3. **Page side** (`src/lib/db/pglite.ts`): in native with `cipherEnabled`, before creating the worker: `secretsStatus()`, probe the stores, `resolveDbMode`. For `encrypted`, `loadDatabaseKey({ create: open === "create" })` and pass `encryption: { key, store: ENCRYPTED_STORE_NAME, mode: open }` in the worker options. `blocked` modes reject `getDatabase()` with a typed `DbBlockedError(reason)` that `BootErrorScreen` shows (texts and actions come with #<J-10>; here a plain message and Retry). Skip the legacy Postgres 17 migration entirely in native: those engines never ran there. The web path is byte-for-byte the old behaviour.
4. **Worker side** (`src/lib/db/pglite-worker.ts`): when `options.encryption` is set, dynamically import `@/lib/db/cipher` and build `new EncryptedFs({ backend: IndexedDbBackend.pair(store) (or `new IndexedDbBackend(store + ".a")` if the pinned commit has no `pair` yet), key, mode, onProgress, onFatal })` instead of `TimedIdbFs`. Keep the three boot marks (`db-idb-read`, `db-idb-loaded`, `db-open`) and add `db-decrypt` progress from `onProgress` so the splash moves during a long open. `relaxedDurability` stays as today.
   - `journal-flush` calls `fs.syncToFs(false)` (strict) for the encrypted filesystem.
   - **Idle flush:** every second, if `fs.hasDirty()` and no sync ran in the last second, call `fs.syncToFs()`. This is what makes a committed `transaction()` reach disk without waiting for the next query (#1065) and does not depend on `pg.syncToFs()` (#1191).
   - `onFatal(StaleWriterError)`: post `{ type: "journal-db-fatal", reason: "stale-writer" }`; the page shows "Journal is open in another window with newer data. Reload." and stops writing.
   - Never log the options object (it holds the key).
5. **Typed open errors:** map the package's `WrongKeyError` → `blocked/key-lost`, `CorruptStoreError` and `IncompleteStoreError` → `DbBlockedError("store-damaged")`, `CryptoSelfTestError` → `DbBlockedError("crypto-unsupported")`. None of them may fall through to a path that creates a database.
6. **Protection state for the UI:** `getDbProtection(): "encrypted" | "plain" | "plain-unprotected" | "blocked"` from `src/lib/db/index.ts`, set once per boot. #<J-11> shows it.
7. **Sign-out and `clearAllLocalData()`** keep working on the encrypted database (they are SQL). The faster crypto-erase comes with #<J-10>.
8. **e2e encryption mode.** So that browsers can test the encrypted path without a Tauri shell: in `MODE === 'e2e'` builds made with `VITE_NATIVE_ENCRYPTION=1` only, `?e2eNative=1` installs a fake native bridge (`src/lib/e2e/fakeNative.ts`: `isNativeApp()` true, `nativeSecrets` backed by an in-page map seeded from a fixed test key). It is never in a production bundle (same rule as `src/lib/e2e/testHooks.ts`). Specs that use it live under `e2e/native/` and are excluded from the public `hermetic` project. Add a job to `.github/workflows/native-encryption.yml` that builds the e2e bundle with the flag and runs `npx playwright test e2e/native`; add the script `e2e:native` for it.
9. `AGENTS.md`: the "Local DB" row, the PGlite section (data location per platform, the mode table, the idle flush), the project structure.
10. A `release-notes/` file: "New: the desktop app encrypts the notes it stores on your computer." (Simplified Technical English; the claim is completed by the other issues of the epic, so word it for what this PR does.)

## Verification
- `src/__tests__/dbMode.test.ts`: every row of the table, plus `native: false` and `cipherEnabled: false` → `plain`. No input leads to `encrypted/create` when a key was ever created or an encrypted store exists.
- `src/__tests__/pgliteWorkerInit.test.ts` (extend; needs the submodule, so behind `cipherAvailable`): with `encryption` in the options the worker builds `EncryptedFs`; without it, `TimedIdbFs`; the key is not in any `postMessage` the worker sends back.
- `src/__tests__/pgliteEncryptedBoot.test.ts` (behind `cipherAvailable`; real PGlite, `fake-indexeddb`): create, write a note through `createNote`, close, reopen: the note is there; a wrong key rejects with `DbBlockedError("key-lost")` and the store's records are byte-identical afterwards; a store with its root record (key `2`) removed rejects with `store-damaged` and **no** new database appears; the database names are exactly `data.a` and `data.b`, and no name, key or value in them contains `journal`, `pglite` or `cipher`; a transaction followed by nothing else is on disk after 2 s (idle flush); two flush requests in a row both resolve after the data is on disk.
- New `e2e/native/encrypted-boot.spec.ts` (encryption mode of step 8): create a note with a marker string, wait for save, reload: the note is there; dump every IndexedDB database (keys and values): no value contains the marker in UTF-8 or UTF-16; the boot marks include `db-decrypt`.
- With the submodule **absent**: `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0 (the cipher tests report skipped), and `~/.claude/bin/heavy npm run e2e` passes unchanged.
- With the submodule present: `~/.claude/bin/heavy npm run build:native` exits 0; `~/.claude/bin/heavy node scripts/check-pwa-build-identical.mjs` exits 0; the cipher tests pass and `~/.claude/bin/heavy npm run e2e:native` passes.
- `~/.claude/bin/heavy cargo check --manifest-path src-tauri/Cargo.toml --features custom-protocol` is clean.
- In the PR: boot marks of the e2e build, plain against encrypted, for a database with 500 notes (open time and first-note-list time), next to the budget from pglite-cipher's owner gate.
- Manual on macOS or the machine's OS, recorded in the PR: fresh install → sign in → create a note → quit → reopen: the note is there, Settings/devtools show `getDbProtection() === "encrypted"`, and the profile folder's IndexedDB files do not contain the marker (`grep -r` on the folder; give the path).

## STOP and comment on the issue if
- The submodule is not available on this machine, or its pinned commit has no `EncryptedFs`.
- Any path in the mode table could run PGlite's initdb while an encrypted store exists.
- The `CryptoKey` does not reach the worker intact in a target webview (structured clone of a non-extractable key). Report the webview.
- The encrypted open of a 500-note database is more than 2× the plain open in the e2e build. Report the marks; do not change the gate.
- The PWA build changes (the identical-build check fails).

## Metadata
Depends on: #553, #<J-04>
Size: L
Area: native, db, security
Model: opus
Effort: xhigh
