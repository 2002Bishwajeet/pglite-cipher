<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-10).
Title: Native: recovery when the key or the store is gone, "reset and sync again", and crypto-erase on sign-out
Labels: agent-ready, security
Takes over from #1017 step 5. Resolves review S9 (the warning cannot count unsynced changes; backups) and the keychain lessons of prior art.
-->
## Context
Epic #555. With an encrypted database (#1017) the boot can end in states that did not exist before. `resolveDbMode` (`src/lib/db/dbMode.ts`) and the open errors name them; today they show a bare message. Each needs the right explanation and the right action, because the wrong action here is permanent:

| State | What happened | Can the data be read? |
|---|---|---|
| `keychain-unavailable` | The keychain is locked, the user dismissed a prompt, the Secret Service is not running | Yes, once the keychain answers. **Never reset here.** (Element shipped a bug where a transient keychain failure created a new key and destroyed sessions.) |
| `backend-changed` | Linux: the keyring provider changed (GNOME Keyring ↔ KWallet) | Yes, after switching back; or reset |
| `key-lost` | The keychain answers and has no key: restored from a backup to a new device, the keychain was reset, the item was deleted | **No.** The store is unreadable for ever |
| `store-missing` | The key exists but the system removed the webview's data (storage pressure, a cleaner tool) | Nothing left to read |
| `store-damaged` | The store fails its integrity check or is incomplete | No (or not safely) |
| `stale-writer` | Another window wrote a newer store | Yes, after a reload |
| `crypto-unsupported` | The webview's crypto failed the self-test | Not on this build |

Homebase holds every synced note, so "reset local data and sync again" always brings them back. What it cannot bring back are changes made on this device that had not synced. The first design wanted to warn "with the count of unsynced changes"; that count is inside the database that cannot be opened (review S9). The text therefore states the risk without a number.

On mobile, keys are bound to the device and are not in backups, so restoring a backup to a new phone always ends in `key-lost` (and signed out, because the credentials are in the keychain too). That is expected and should feel like a fresh sign-in, not like an error.

## Change
1. **Boot screens.** Extend `BootErrorScreen` (`src/components/layout/SplashScreen.tsx`) to render `DbBlockedError` reasons. Logic in a hook `src/hooks/useDbRecovery.ts`; the component only renders. Texts (final wording may be polished, meaning may not change):
   - `keychain-unavailable`: "Journal can't reach your system keychain. Unlock it, then try again." **Try again.** No reset button on this screen.
   - `backend-changed`: "Your system's password store changed (was <old>, now <new>). Journal's key is in the old one. Switch back and try again, or reset this device's copy." **Try again** · **Reset…**
   - `key-lost`: "The key for this device's copy of your notes is not available. This happens after restoring from a backup or resetting the system keychain. Journal will download your notes from your Homebase again. Changes made on this device that had not synced are lost." **Download again**
   - `store-missing`: "This device's copy of your notes was removed by the system. Journal will download them again." **Continue**
   - `store-damaged`: "This device's copy of your notes is damaged and can't be opened safely. Journal can download your notes from your Homebase again. Changes made on this device that had not synced will be lost." **Try again** · **Reset and download again**
   - `stale-writer`: "Journal is open in another window with newer data." **Reload**
   - `crypto-unsupported`: "This system's web engine can't run Journal's encryption. Update your system, or contact support." No action that touches data.
   Phone layouts use the sheet and motion rules of `AGENTS.md`; both themes.
2. **`resetLocalData()`** in `src/lib/db/resetLocalData.ts`, the only code path that deletes an encrypted store. Order: stop the database worker (terminate; do not try to flush) → delete both cipher slots (the IndexedDB databases `data.a` and `data.b`, from `ENCRYPTED_STORE_NAME` of #1017) → `forgetDatabaseKey()` → remove sealed device state (`journal-unsaved-edits:*`, tabs, recents, session) → reload. The next boot resolves to `encrypted/create`. Credentials are kept: the user stays signed in and the first sync pulls everything.
   - It refuses to run in state `keychain-unavailable` (throws), whatever the caller.
   - `Reset…` buttons open a confirmation (`ConfirmDialog`) repeating the "not synced changes are lost" sentence; `key-lost` and `store-missing` need no second confirmation (nothing can be saved by declining).
3. **Signed out and `key-lost` together** (a restored phone): the landing page shows as usual; after sign-in the boot meets the orphan store and resets it without a screen, then shows a toast "Downloading your notes again".
4. **Sign-out = crypto-erase** (native, encrypted): in `logout` (`src/hooks/auth/useAuth.ts`), after the remote logout: close the database, delete both slots, `eraseAllSecrets()` (database key, credentials, storage key, state file), clear sealed keys, then the existing redirect. Deleting the key makes any forensic remnant of the store unreadable, which `DELETE FROM` never did. Keep `clearAllLocalData()` for the web and for `plain` modes. The auto-logout on a revoked device takes the same path.
5. **Store-initialised bookkeeping.** `store-missing` relies on the Rust state file's `dbKeyCreated` (from #<J-04>): make sure `resetLocalData()` and sign-out clear it, and that `encrypted/create` sets it only after the first successful sync of the new store.
6. Diagnostics: each recovery outcome is one log event (reason and action, nothing else). The redacted report (`src/lib/diagnostics/report.ts`) includes `getDbProtection()` and the last recovery reason.
7. A `release-notes/` file for the user-visible recovery screens.

## Verification
- `src/__tests__/dbRecovery.test.ts`: for each state, the offered actions are exactly those above; `resetLocalData()` throws in `keychain-unavailable`; the reset order is as specified (spies), and a failure half-way (slot deleted, key not yet forgotten) recovers on the next boot to `key-lost` → reset → `create`, never to a state that opens someone else's data or loops.
- `src/__tests__/logoutCryptoErase.test.ts`: native encrypted sign-out deletes both slots and calls `eraseAllSecrets`; web sign-out is unchanged; the revoked-device auto-logout takes the same path.
- `e2e/native/recovery.spec.ts` (encryption mode; needs the submodule): (a) delete the fake keychain's key and reload → `key-lost` screen → Download again → the app boots with an empty database and the screenshot in both themes is attached; (b) corrupt one stored record → `store-damaged` → Reset → boots; (c) make the fake keychain unavailable → the screen has **no** reset action, and after making it available again Try again opens the original data intact.
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0 with and without the submodule; `~/.claude/bin/heavy npm run e2e -- e2e/boot` passes unchanged.
- Manual on the machine's OS, recorded in the PR: delete the `db-kek-v1` item with the OS keychain tool, start the app, go through "Download again", notes return after sync; lock the keychain (macOS: `security lock-keychain`), start the app, see the keychain screen, unlock, Try again, data intact.

## STOP and comment on the issue if
- Any path can reach `resetLocalData()` or create a new key while the keychain is merely unavailable.
- A reset can run while another window still has the database open and would write the old store back.
- Sign-out cannot close the database before deleting it on some platform (a blocked `deleteDatabase`). Report what holds it.

## Metadata
Depends on: #1017
Size: M
Area: native, db, security, ui
Model: opus
Effort: high
