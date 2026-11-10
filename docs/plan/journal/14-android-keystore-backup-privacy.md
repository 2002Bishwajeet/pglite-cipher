<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-14).
Title: Android: Keystore secrets, biometric lock, backup rules, FLAG_SECURE, sign-in residue
Labels: agent-ready, security
-->
## Context
Epic #555; Pro plan #306 M6. The Android app is the Tauri shell on `http://localhost:47821` (#1020; `src-tauri/gen/android` is committed). It reuses everything the desktop issues built (#<J-04>, #<J-05>, #<J-06>, #1017, #<J-10>, #<J-11>, #<J-12>) and needs its own bindings plus four Android-specific fixes:

1. **Auto Backup is on.** `src-tauri/gen/android/app/src/main/AndroidManifest.xml` does not set `android:allowBackup`, and the default is `true`: Android uploads the app's data, including the webview's storage, to the user's Google Drive, and copies it in device-to-device transfers. The keys cannot follow (Keystore keys never leave the device), so a restore would deliver an unreadable store, and before this epic it would have delivered the plain database and the credentials.
2. **Recents screenshot.** Android stores a screenshot of the app for the recents screen.
3. **Sign-in residue**, as on iOS: the single webview visits the Homebase owner console and keeps its 6-month cookie and its `localStorage`.
4. **Keystore.** Secrets must be wrapped by a hardware-backed key.

Android's sandbox already keeps other apps out. Encryption adds: nothing readable in backups and transfers, and nothing readable in a forensic or rooted copy of the app's data without the device's Keystore.

## Change
1. **Secret store for Android** behind the `SecretStore` trait: the `keyring` crate's Android-native store if it is backed by the Android Keystore and persistent; else a small Kotlin class in the app (`gen/android/app/src/main/java/id/homebase/journal/`) called through JNI or a local Tauri plugin: an AES-256-GCM key in `AndroidKeyStore` (`setUnlockedDeviceRequired(true)` where the API level allows, StrongBox when available with fallback to TEE) that wraps each secret; the wrapped blobs in `noBackupFilesDir`. Error mapping: no blob → `NotFound`; `KeyPermanentlyInvalidatedException`, `UserNotAuthenticatedException`, Keystore errors → `Unavailable` (never `NotFound`: a Keystore hiccup must not create a new database key). Backend name `android-keystore`.
2. **Biometric lock:** `Authenticator` through `tauri-plugin-biometric` (BiometricPrompt, device credential fallback allowed). Flow and Settings as #<J-12>.
3. **Backups off, explicitly.** In the manifest: `android:allowBackup="false"`, and `android:dataExtractionRules="@xml/data_extraction_rules"` with a file that excludes every domain for both `<cloud-backup>` and `<device-transfer>` (Android 12+ ignores `allowBackup` for device-to-device transfers). The security state file and wrapped blobs live in `noBackupFilesDir` regardless. A new phone therefore starts clean: sign in, sync.
4. **`FLAG_SECURE`** on the activity window **while the app lock is enabled** (owner question 10 of the plan in `2002Bishwajeet/pglite-cipher`, `docs/plan/99-owner-questions.md`; recommended answer): a plugin/JNI call from `lock_configure` and at start. It hides the recents thumbnail and blocks screenshots, so it is not forced on users who did not turn the lock on. Without the lock: when the app goes to the background (`onPause`), show an opaque cover view over the webview and remove it in `onResume`, so the recents thumbnail shows the cover.
5. **Remove the identity's website data after sign-in:** command `clear_site_data(host)`: `CookieManager` (remove cookies for `https://<host>`; `flush()`), `WebStorage.getInstance().deleteOrigin("https://<host>")`. Called as on iOS (after finalize and at each start). Never for `localhost`.
6. **`file_paths.xml`** grants `external-path` and `cache-path` to the FileProvider (template default). Narrow it to what the app really shares (exports), so no future code can hand out a path into the webview's data by accident.
7. `src-tauri/README.md` Android section: the backup rules and why a new phone starts empty, the Keystore wrapping, `FLAG_SECURE` behaviour.

## Verification
- `~/.claude/bin/heavy cargo test --manifest-path src-tauri/Cargo.toml` passes; `cargo check --target aarch64-linux-android --manifest-path src-tauri/Cargo.toml` is clean where the NDK is installed (say if it is not).
- A manifest test (`src/__tests__/androidManifest.test.ts`, reading the XML as text): `allowBackup="false"`, `dataExtractionRules` present, the rules file excludes all domains for both sections.
- `src/__tests__/clearSiteData.test.ts` covers Android's call path as for iOS.
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time.
- **On a real Android device** (an agent without one stops after the automated checks and lists these for the owner), recorded in the PR or on the issue:
  1. Debuggable build: sign in, create a note with a marker word. `adb shell run-as id.homebase.journal tar -c . > data.tar`, unpack, run `scripts/native/scan-at-rest.mjs` (from #<J-16>, else `grep -r`): no marker, no credential, no identity cookie or `localStorage`.
  2. `adb shell bmgr backupnow id.homebase.journal` reports that backup is not allowed.
  3. Lock off: recents shows the cover. Lock on: recents shows a blank card and a screenshot is refused.
  4. Biometric lock: enable, leave and return → prompt; cancel → stays locked.
  5. Add a new fingerprint in system settings (which invalidates some Keystore keys): the app shows the keychain screen or keeps working; it does **not** silently start with an empty database.

## STOP and comment on the issue if
- No maintained crate or plugin reaches the Android Keystore and the Kotlin bridge is more than about 150 lines.
- `setUnlockedDeviceRequired` or StrongBox makes the key unusable on the test device in normal use (report the device and API level; fall back to TEE without the flag and say so).
- Enrolling a new biometric invalidates the wrapping key. Then the key must be created without `setInvalidatedByBiometricEnrollment`; confirm the fix on the device.
- `WebStorage.deleteOrigin` leaves the owner console's data in the scan.

## Metadata
Depends on: #1020, #<J-05>, #<J-12>
Size: M
Area: android, native, security
Model: opus
Effort: high
