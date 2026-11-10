<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-08).
Title: Native: move an existing plain local database into the encrypted store (verified, crash-safe)
Labels: agent-ready, security
Takes over from #1017 step 4. Resolves the app half of review finding B2.
CONDITIONAL: needed only if a native build without encryption ever reaches users (owner question 1 in docs/plan/99-owner-questions.md). If the owner answers "encryption is in the first public native build", close this and pglite-cipher's import issue (plan file 10) as not planned; J-10's reset then handles testers' plain databases.
-->
## Context
Epic #555. A native install that ran before encryption existed has a plain-text PGlite database in IndexedDB (`/pglite/journal-db-pg18`). #1017 opens the encrypted store for new installs and reports `needs-migration` for these. This issue moves the data across.

The rules come from a review of the first design, which found three ways to lose data (finding B2), and from Journal's own history (the PGlite 0.5 upgrade that bricked data directories, `AGENTS.md` "PGlite Version Migration"):

1. A half-written encrypted store must never be taken for a finished one.
2. If both stores exist after a crash, the **encrypted** one is the truth. Importing the stale plain one again would silently drop everything written since.
3. The plain database must be copied from a clean, flushed, closed state, not while an engine is writing it.
4. The plain database is deleted only after the encrypted copy has been verified **and** opened by Postgres.

The copying is done by `importPlainDataDir` in `pglite-cipher` (its plan file `10-plaintext-import.md`; cross-repository dependency, not on the `Depends on:` line): it streams the old IDBFS records into the new store, writes the commit marker last, verifies by reading everything back against per-file SHA-256, and never deletes the source. This issue is the orchestration around it.

The migration is automatic at the first boot of a build that can encrypt. It is not a setting: an unencrypted native database is not a state the user should have to notice and fix.

## Change
1. Bump `vendor/pglite-cipher` to a commit that has `importPlainDataDir` and `discardIncompleteStore`; extend `src/lib/db/cipher/` re-exports and the stub.
2. **`src/lib/db/encryptMigration.ts`**, `migrateToEncrypted(): Promise<"migrated" | "already" | "failed">`, called from `initDatabase()` in `src/lib/db/pglite.ts` when `resolveDbMode` returns `needs-migration`. Everything runs under the Web Lock `journal-db-encrypt` (other windows wait, then re-resolve the mode):
   1. **Clean source.** Start the plain engine as today but with `relaxedDurability: false` (as the legacy migration does), run `CHECKPOINT`, record `counts` (row counts of `document_updates`, `search_index`, `folders`, `sync_records`, `document_snapshots`, `pending_image_uploads`) and `digest` (`md5` over `id || length(update_blob)` of `document_updates` in id order), close the engine and await the close. The IDBFS image is now consistent and nothing is writing it.
   2. **Existing encrypted store?** If one exists and is complete, stop: return `"already"` (rule 2). If it is incomplete, `discardIncompleteStore`.
   3. **Key.** `loadDatabaseKey({ create: true })`.
   4. **Import** with `origin: "idbfs:/pglite/journal-db-pg18"`, reporting progress to the splash (a new boot phase text: "Securing your notes…").
   5. **Open and compare.** Open the encrypted store with the normal worker (`encrypted/open`), compute `counts` and `digest` again, compare. On any difference: close, clear the encrypted store, forget the key (`forgetDatabaseKey()`), return `"failed"`.
   6. **Commit.** Only now delete the plain database (`indexedDB.deleteDatabase('/pglite/journal-db-pg18')`). A delete blocked by another connection is not a failure: #<J-09>'s sweep retries it at every boot, and rule 2 keeps the leftover from ever being used.
3. **Failure never loses the plain database and never blocks the app.** On `"failed"`, or any exception before step 6, the app opens the plain database as before, `getDbProtection()` is `"plain"`, and a one-time toast plus a line in Settings → Security say "Journal couldn't turn on encryption on this device. Your notes are safe. It will try again at the next start." After 3 failed boots in a row (a counter in `localStorage`), stop retrying automatically and leave a "Try again" button in Settings (#<J-11>).
4. **Legacy Postgres 17 data** does not exist in native installs; if `/pglite/journal-db` is found, leave it for #<J-09> to delete and do not migrate it.
5. Diagnostics: one sync-log event per outcome with counts and durations only (no names, no content).
6. `AGENTS.md`: a "Encryption migration (native)" subsection next to "PGlite Version Migration".

## Verification
All migration tests need the submodule (`cipherAvailable`); real PGlite on `fake-indexeddb`.
- `src/__tests__/encryptMigration.test.ts`:
  - happy path: a plain database with notes, snapshots and a pending image becomes an encrypted one with equal `counts` and `digest`; the plain IndexedDB database is gone; a marker string from a note is in no stored value.
  - **Crash at every step boundary** (kill = drop all in-memory state and call `migrateToEncrypted()` again as a new boot would): after step 1; mid-import at the first, a middle and the last batch; after the import but before step 5; after step 5 but before the delete; with the delete blocked. In every case the final state is one usable database with all rows, and at no point is there a boot that would open an empty database.
  - **Encrypted wins:** with both a complete encrypted store and a plain database that has *different* rows, the result is the encrypted store's rows and the plain database is deleted, not imported.
  - **Compare catches damage:** corrupt one stored block after the import (through a backend wrapper) → `"failed"`, the plain database is intact and opens, the encrypted store and the key are gone.
  - **Never initdb over data:** in no test does a database with zero notes appear when the source had notes.
  - Three failed boots stop the automatic retry.
- `e2e/native/migration.spec.ts` (encryption mode from #1017): seed a plain database in the browser profile, load the app in native-encryption mode: the splash shows "Securing your notes…", the notes are there, IndexedDB has no `/pglite/journal-db-pg18` and no marker.
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0 with and without the submodule; `~/.claude/bin/heavy node scripts/check-pwa-build-identical.mjs` exits 0.

## STOP and comment on the issue if
- Owner question 1 was answered "no plain native build will ship". Then this issue should be closed, not built.
- A crash point leaves two stores where the code cannot tell which is newer.
- The plain engine cannot be closed cleanly before the import (a connection stays open and the IDBFS image keeps changing).
- Peak memory during migration exceeds twice the database size (measure with the 100 MB fixture from pglite-cipher's bench, in Chromium).

## Metadata
Depends on: #1017
Size: M
Area: native, db, security
Model: opus
Effort: xhigh
