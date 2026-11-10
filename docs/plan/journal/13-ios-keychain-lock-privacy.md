<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-13).
Title: iOS: Keychain secrets, Face ID lock, app-switcher cover, sign-in residue, backup behaviour
Labels: agent-ready, security, ios-check
-->
## Context
Epic #555; Pro plan #306 M5. The iOS app is the same Tauri shell on `http://localhost:47821` (#102). The desktop issues built the secret commands (#<J-04>), credentials in the keychain (#<J-05>), sealed storage (#<J-06>), the encrypted database (#1017), recovery (#<J-10>), Settings (#<J-11>) and the lock (#<J-12>). iOS needs its own bindings and has four things desktop does not:

1. **Keychain classes.** An item's accessibility class decides when it can be read and whether it goes into backups. The wrong class either breaks restores silently or puts the key into iCloud backups next to the data it protects.
2. **App-switcher snapshot.** When the app leaves the foreground, iOS saves a screenshot of it to disk for the app switcher. With a note open, that is the note's text in a plain image file.
3. **Sign-in residue.** Sign-in navigates the app's only webview to the user's Homebase owner console. That leaves the owner console's 6-month session cookie and its own shared secret (`localStorage` of the identity's origin) in the app's website data: owner-level access to the whole identity, unencrypted. Desktop solves this with an ephemeral sign-in window (#<J-15>); iOS has one webview, so the data is removed after sign-in instead.
4. **Backups.** The app container, with the encrypted store, is in device backups. The keys are not (by the choice below). A restore on a new device therefore lands in the `key-lost` path of #<J-10>, which must feel like signing in again.

iOS sandboxing already keeps other apps out. What encryption adds here: backups and device transfers hold only ciphertext, and so does a forensic image of the container.

## Change
1. **Keychain store for iOS** behind the `SecretStore` trait of `src-tauri/src/secrets.rs`: the `keyring` crate's Apple store if it lets the accessibility class be set, else `security-framework` directly. Every item: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, not synchronizable. Map `errSecItemNotFound` → `NotFound`, `errSecInteractionNotAllowed` (device locked) and the rest → `Unavailable`. Backend name in the state file: `ios-keychain`.
2. **Face ID / Touch ID lock:** an `Authenticator` implementation through `tauri-plugin-biometric` (official, iOS and Android). Add `NSFaceIDUsageDescription` ("Unlock Journal") to `src-tauri/Info.plist` (or `Info.ios.plist`; the Tauri CLI merges it, `gen/apple` is not committed). Passcode fallback allowed. The lock flow, Settings controls and semantics are those of #<J-12>; only the authenticator and the capability/permission entries are new. Auto-lock options on iOS: "Immediately", 1, 5, 15 minutes after leaving the app.
3. **App-switcher cover:** a small Swift piece in the iOS project sources that `tauri ios init` does not overwrite (a local Tauri plugin under `src-tauri/plugins/journal-privacy/` with an `ios/` Swift package is the supported way): on `UIApplication.willResignActiveNotification` add a full-window opaque view with the app icon; remove it on `didBecomeActiveNotification`. Always on: it has no cost to the user.
4. **Remove the identity's website data after sign-in:** a plugin command `clear_site_data(host)`, called by the page right after `finalizeAuthorization` succeeds (`src/hooks/auth/useYouAuthAuthorization.ts`) and again at each start for the signed-in identity: `WKWebsiteDataStore.default().fetchDataRecords(ofTypes: allWebsiteDataTypes())`, then `removeData` for the records whose `displayName` matches the identity's host or registrable domain, plus `HTTPCookieStorage`/`httpCookieStore` cookies for that host. It must never remove the app's own origin (`localhost`): assert on the host argument in Swift and in TypeScript.
5. **Backups:** no exclusion flag on the store (it is ciphertext, and excluding WebKit's folder is not reliable). Confirm with the manual check below that a restore on another device reaches `key-lost` → "Download again", and that a restore on the **same** device (keys still there) opens normally.
6. **Share Extension (#1018), if present:** it runs in another process and must not get the database key. State in the PR how it hands shared content to the app without it (it already queues to the app or to Homebase; confirm).
7. `src-tauri/README.md` iOS section: the keychain class and why, the cover, the site-data removal, how to test a backup restore.

## Verification
- `~/.claude/bin/heavy cargo test --manifest-path src-tauri/Cargo.toml` passes (the trait-level tests of #<J-04> and #<J-12> run against the mock; the iOS store compiles for `aarch64-apple-ios`: `cargo check --target aarch64-apple-ios --manifest-path src-tauri/Cargo.toml` on a Mac).
- `src/__tests__/clearSiteData.test.ts`: called after a successful finalize with the identity's host; never called with `localhost` or an empty host; a failure does not fail the sign-in but is logged.
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time.
- **On a real iPhone** (label `ios-check`; an agent without a device stops after the automated checks and lists these for the owner), recorded in the PR or by the owner on the issue:
  1. Sign in, create a note with a marker word, background the app: the app switcher shows the cover, not the note.
  2. Download the app container (Xcode → Devices → Download Container). `scripts/native/scan-at-rest.mjs` (from #<J-16>, if merged; else `grep -r`) finds the marker nowhere, finds neither credential, and finds no cookie or `localStorage` for the identity's host.
  3. Face ID lock: enable, leave and return → prompt; fail → stays locked; Lock now.
  4. Encrypted backup to a Mac, restore to the same phone: opens normally. Restore to another phone (or erase and restore): sign-in screen, then "Download again", notes return.
  5. Lock the phone with Journal in the foreground, unlock: the app continues; no keychain error screen.

## STOP and comment on the issue if
- The keychain class cannot be set to `WhenUnlockedThisDeviceOnly` with the available crates.
- A local Tauri plugin with Swift code cannot be kept outside the regenerated `gen/apple` tree.
- `WKWebsiteDataStore` leaves the identity's data behind after removal (check with the container scan). Then iOS needs `ASWebAuthenticationSession` with an ephemeral session: describe the change to the sign-in flow and wait.
- The cover is not in place when iOS takes the snapshot (the switcher still shows the note).

## Metadata
Depends on: #102, #<J-05>, #<J-12>
Size: M
Area: ios, native, security
Model: opus
Effort: high
