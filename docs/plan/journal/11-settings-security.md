<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-11).
Title: Native: Settings → Security (what is protected, integrity check, new key)
Labels: agent-ready, security
Takes over from #1017 step 6 and step 7.
-->
## Context
Epic #555. The native apps encrypt what they store. This is a paid feature, so the app must say exactly what it does and does not protect, on this device, now. A vague "Encrypted ✓" would be wrong on a Linux machine without a keyring, on Windows against other programs, or while the Markdown mirror (#1015) writes every note to a folder in plain text.

State comes from earlier issues: `getDbProtection()` (#1017), `credentialProtection()` (#<J-05>), `secretsStatus()` (#<J-04>), the unclassified-store audit (#<J-09>), recovery reasons (#<J-10>). The encrypted filesystem offers `verify()`, `changeKey()` and `rotateDataKey()` (pglite-cipher plan file `09-key-change-rotate-verify.md`; cross-repository dependency: bump the submodule pin to a commit that has them).

Settings are a section registry (`src/components/settings/sections.ts`), one file per section, logic in hooks, rows built with `SettingsRow`, no framer-motion (`AGENTS.md` "Settings structure").

## Change
1. **Section** `security` ("Security", icon `ShieldCheck`), registered after "Data & storage", shown only when `isNativeApp()`. Add a `nativeOnly?: boolean` field to `SettingsSection` and filter in both `SettingsDialog.tsx` and `MobileSettings.tsx`. Component `src/components/settings/sections/SecuritySection.tsx`, hook `src/hooks/useSecuritySettings.ts`.
2. **Status block**, one line each, from live state:
   - Database: "Encrypted on this device" / "Not encrypted yet. Journal will try again at the next start." (+ **Try again** when the migration gave up, #<J-08>) / "Not encrypted: this system has no keyring that Journal can use." / "This build has no encryption."
   - Sign-in: "Stored in <Keychain | Windows Credential Manager | your system keyring>" / "Stored without protection (no system keyring)".
   - Key: where it is kept, in the platform's own words.
3. **"What this protects"** (a toggle block, text fixed per platform; the sentences below are the source; they go into `src/lib/native/protectionCopy.ts` so it is reviewable in one place):
   - all platforms: "A copy or backup of Journal's files can't be read without the key from your <store>." "It does not protect against software running under your account while Journal is open." "Exports and printed notes are not encrypted."
   - Windows and Linux add: "Other programs you run can ask your system for Journal's key."
   - Linux adds: "If your keyring has no password, the key is not protected."
   - macOS adds: "Only Journal can read its key without asking you."
4. **"Stored unencrypted"** list, shown only when non-empty: the Markdown mirror folder when #1015's setting is on (read its setting if it exists; skip silently if the feature is not built yet); any unclassified local store from #<J-09>'s audit, by name; "Remnants of data stored before encryption was turned on may remain on the disk until overwritten" when a migration or sweep ran on this install.
5. **Check integrity**: runs `verify()` in the worker with a progress bar; result "No problems found (<n> files, <m> blocks)" or "Problems found" with the count and a pointer to **Reset and download again** (#<J-10>). Never shows record contents.
6. **Use a new key**: explains in one sentence ("Makes a new key and re-encrypts this device's copy. Use it if you think someone copied your key."), then: Rust makes a new keychain key under a temporary account name → `changeKey(newKey)` → `rotateDataKey()` with a blocking progress dialog ("Keep Journal open") → on success the new key replaces the old keychain item and the old one is deleted; on failure the old item stays and the store is unchanged (the package guarantees a crash at any point leaves one valid store). Add the two small Rust commands this needs to `src-tauri/src/secrets.rs` (`secrets_db_key_stage_new`, `secrets_db_key_commit_new`), with the same `authorize` check and the rule that the old item is deleted only after the page confirms the new store is ready. Switch the worker to `IndexedDbBackend.pair(ENCRYPTED_STORE_NAME)` if #1017 used a single slot.
7. A slot for the app-lock controls, filled by #<J-12>.
8. `release-notes/` file; `AGENTS.md` settings section list.

## Verification
- `src/__tests__/useSecuritySettings.test.ts`: every combination of database state × credential state × platform produces the expected lines; the "Stored unencrypted" list appears only when it has entries; no line claims encryption in `plain` or `plain-unprotected`.
- `src/__tests__/protectionCopy.test.ts`: each platform's text contains its required caveat sentences, and none contains "military", "unbreakable", "audited", "FIPS" or "zero-knowledge".
- Rust tests for the staged key: staging does not touch the live item; commit replaces it; a crash between stage and commit leaves the old key working and the staged item is cleaned at next start; `authorize` applies.
- `src/__tests__/rotateKeyFlow.test.ts` (needs the submodule): success path; a failure in `rotateDataKey` leaves the old key and the data usable; killing the flow after `changeKey` but before commit recovers at next boot with exactly one key that opens the store.
- `e2e/native/settings-security.spec.ts` (encryption mode): the section exists, shows "Encrypted on this device", Check integrity reports no problems, Use a new key completes and the app still opens after a reload; screenshots in both themes, desktop and 390 px. On the web build the section does not exist (assert in an existing `e2e/settings` spec).
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0 with and without the submodule; `~/.claude/bin/heavy cargo test --manifest-path src-tauri/Cargo.toml` passes.

## STOP and comment on the issue if
- Any state would show a stronger claim than the per-platform sentences of step 3 support.
- The key replacement cannot be made crash-safe with the keychain's operations on some platform (no atomic replace): describe the window and what the user would see.
- Rotation blocks the UI thread, or needs the app to be closed.

## Metadata
Depends on: #<J-10>
Size: M
Area: settings, native, security, ui
Model: opus
Effort: high
