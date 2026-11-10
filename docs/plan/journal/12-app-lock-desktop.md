<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-12).
Title: Desktop: app lock with Touch ID / Windows Hello, lock now, auto-lock
Labels: agent-ready, security
Takes over from #1017 step 2. Applies owner question 3 (what "locked" means) with the recommended answer; if the owner answered differently, follow the answer.
-->
## Context
Epic #555. Encryption at rest protects a copy of the files. It does nothing against someone who sits down at the unlocked computer and opens Journal. The app lock covers that case: off by default; when on, Journal asks for Touch ID (macOS) or Windows Hello before it opens, and locks again on request or after a time in the background. Linux has no common biometric API; the lock is not offered there.

**What "locked" means** (owner question 3 of the plan kept in the private repository `2002Bishwajeet/pglite-cipher`, `docs/plan/99-owner-questions.md`; this is its recommended answer): a real lock, not a curtain. Locking closes the database worker (the decrypted database leaves memory), drops the key and the credentials from the page by reloading it into a lock screen, and makes Rust refuse every secret command until the user authenticates again. The price is that unlocking takes as long as a normal start. A lock that only covers the window would leave the whole database readable in memory and the keychain commands callable.

**How strong it is, honestly:** on macOS and Windows this is an app-level gate: Rust asks the OS to verify the user and then releases the key. It stops a person at the keyboard. It does not stop a program running as the user, which can ask the keychain itself. An OS-enforced binding (a keychain item that the Secure Enclave releases only after biometry) needs the data-protection keychain and entitlements that depend on how the app is signed and distributed (owner question 7 of the same plan); it is out of scope here. Settings says which kind this is.

All secret commands already pass `authorize(&webview)` in `src-tauri/src/secrets.rs` (#<J-04>). The lock is one more condition there.

## Change
1. **Rust `src-tauri/src/lock.rs`:**
   - State: `enabled`, `auto_lock_minutes: Option<u32>` (stored in the keychain as a fourth item `lock-settings-v1`, so that editing a file cannot switch the lock off), and in memory `unlocked_until_locked: bool` (false at every start when enabled).
   - `trait Authenticator { fn available(&self) -> bool; fn authenticate(&self, reason: &str) -> Result<(), AuthError>; }` with: macOS: `LAContext.evaluatePolicy(.deviceOwnerAuthentication)` (Touch ID with the account password as fallback) through an Objective-C binding crate (`objc2-local-authentication` or the smallest equivalent); Windows: `UserConsentVerifier::RequestVerificationAsync` through the `windows` crate; Linux: `available() == false`; a mock for tests.
   - `authorize()` gains: if the lock is enabled and the session is not unlocked → `Denied::Locked`.
   - Commands (same capability and caller check as the other secret commands): `lock_status()` → `{ available, enabled, locked, autoLockMinutes }`; `lock_unlock()` (runs the authenticator, sets unlocked); `lock_now()`; `lock_configure({ enabled, autoLockMinutes })`. **Turning the lock off, or changing the timer, requires a successful `authenticate` in the same call.** Turning it on requires one too (proves it works before the user depends on it).
   - Auto-lock: when the main window loses focus or is hidden, start a timer; when it fires, emit `journal://lock` and set locked. Also lock on system sleep where the windowing library reports it (if it does not, say so in the PR; do not add a platform hack).
2. **Page:**
   - `src/lib/native/appLock.ts`: `lockNow()`: ask the worker for a final strict flush, close the database, call `lock_now`, then `location.replace('/locked')` (a **full reload**, so keys, credentials and decrypted caches leave the JS heap). Listen for `journal://lock` and do the same. Tell other windows through the existing broadcast channel.
   - `initNative()` (`src/lib/native/init.ts`): first `lock_status()`. If locked, render only the lock screen: no credential load, no storage key, no database, no service-worker messages that carry note data.
   - `src/pages/LockedPage.tsx` (route `/locked`, outside `AuthGuard`): app icon, "Journal is locked", **Unlock** (calls `lock_unlock`, then reloads to the last route), and the OS prompt appears at once on load. Composes components only; logic in `src/hooks/useAppLock.ts`.
   - A **Lock now** item in the native menu and in Settings.
3. **Settings → Security** (#<J-11>'s slot): toggle "Lock Journal" with the platform's name for the method, "Lock after" (Off, 1, 5, 15, 60 minutes in the background), **Lock now**, and the honesty line: "The lock stops someone using your unlocked computer. It doesn't stop other programs running under your account."
4. **While locked:** no sync, no websocket, no notifications with content (constraint for #1016: generic text when the lock is on). The window title is "Journal", never a note title.
5. **Quick capture (#1014), if present:** the hotkey shows the unlock prompt first. If #1014 is not built yet, add the sentence to its issue instead (do not write to GitHub from this issue; put it in the PR description for the owner).
6. `release-notes/` file; `AGENTS.md`.

## Verification
- `~/.claude/bin/heavy cargo test --manifest-path src-tauri/Cargo.toml` passes with the mock authenticator: enabled + not unlocked → every secret command is `Locked`; `lock_unlock` success opens them, failure and cancel do not; `lock_now` closes them again; turning the lock off without a successful authentication is refused; the settings survive a restart; a fresh start with the lock on is locked; with no authenticator available `lock_configure({ enabled: true })` is refused.
- `src/__tests__/appLock.test.ts`: `lockNow()` flushes, closes the database, calls `lock_now`, then navigates, in that order; when locked at boot, `initCredentialStore`, `loadStorageKey` and `getDatabase` are **not** called; the lock event from Rust triggers the same path; a second window locks too.
- `e2e/native/app-lock.spec.ts` (encryption mode with the fake native bridge's lock): enable, Lock now → `/locked`, the page's JS has no credentials (`getAuthToken()` is null) and IndexedDB has no open connection; Unlock → back on the same note; screenshots in both themes.
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time; `~/.claude/bin/heavy cargo check --manifest-path src-tauri/Cargo.toml --features custom-protocol` is clean.
- Manual on macOS (Touch ID, and the password fallback on a Mac without it) and on Windows (Hello PIN or biometric) if available, recorded in the PR: enable; quit and start → prompt first, nothing of the app visible behind it; cancel → stays locked; Lock now; auto-lock after 1 minute in the background; turning the lock off asks again. Record the unlock time for a typical database next to the open budget.

## STOP and comment on the issue if
- Desktop biometrics need more than a small binding (a helper app, an entitlement, a provisioning profile). Report what, per platform; ship the platform that works and leave the other off.
- The page cannot be reloaded into the lock screen without the previous page's memory surviving (for example the webview restores it from a cache). Report the webview.
- Anything of the app's content is visible before the first successful unlock (a flash of the previous window contents, a restored window snapshot).

## Metadata
Depends on: #<J-11>
Size: M
Area: native, security, ui
Model: opus
Effort: high
