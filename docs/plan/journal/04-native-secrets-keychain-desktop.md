<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-04).
Title: Native (desktop): secrets in the OS keychain: database key, credentials, device-storage key
Labels: agent-ready, security
Takes over from #1017 step 1 and step 3. Resolves review finding S9 (key handling) and applies the keychain lessons of prior art (Element, Signal, Electron safeStorage).
-->
## Context
Epic #555. The native apps keep three secrets in the operating system's keychain: the key that encrypts the local database, the Homebase credentials (auth token and shared secret, today in `localStorage`), and a key that seals small device state in `localStorage`. This issue builds the Rust side for macOS, Windows and Linux, and the small TypeScript bridge. Later issues use it: #<J-05> (credentials), #<J-06> (sealed storage), #1017 (database). iOS and Android get their own (#<J-13>, #<J-14>).

What the keychain gives differs by platform, and the app must not promise more: macOS ties an item to the app's code signature; Windows Credential Manager and the Linux Secret Service let any program running as the same user read it. The Settings text (#<J-11>) states this.

Facts about the shell (`src-tauri/` after #101):
- The app is served from `http://localhost:47821`, which Tauri treats as a **remote** origin. Custom commands are rejected from a remote origin unless the app declares them in its ACL manifest and a capability with a matching `remote.urls` allows them (Tauri 2.12.5, `tauri/src/webview/mod.rs`, the "remote-origin guard" near line 2077). `capabilities/default.json` grants `core:default` to window `main` only.
- Tauri's IPC entry point and its per-launch invoke key are injected into the **main frame only** (`for_main_frame_only: true`, `tauri/src/manager/webview.rs:164`). Tauri's documentation still warns: "On Linux and Android, Tauri is unable to distinguish between requests from an embedded `<iframe>` and the window itself." Journal runs user- and agent-written HTML in sandboxed frames (live blocks), so the secret commands must be proven unreachable from them.

Lessons from apps that shipped this (`vendor/pglite-cipher/docs/research/2026-11-10-prior-art.md` if the submodule is present; the rules below are complete without it):
- **Element:** never create a new key while an existing one is present but cannot be read right now. "Overwriting it with a freshly-generated key would turn a transient keychain failure into permanent … loss."
- **Signal:** refuse a keychain backend that protects nothing, record which backend was used, and fail loudly if it changes instead of treating the device as new.

## Change
1. **Dependencies** (`src-tauri/Cargo.toml`): the `keyring` crate (pick the current major; enable only the native store per desktop OS: Apple keychain, Windows Credential Manager, and on Linux the **Secret Service** store only. Do **not** enable the Linux kernel `keyutils` store: its keys vanish at reboot, which would lose the database key; and no file-based or plaintext store), `zeroize`, `getrandom`.
2. **`src-tauri/src/secrets.rs`.** A trait `SecretStore { get, set, delete }` returning a typed error, with the keyring implementation and an in-memory one for tests. Service name `id.homebase.journal`; accounts `db-kek-v1`, `credentials-v1`, `storage-key-v1`. On Apple platforms items are not synchronizable (no iCloud Keychain).
   - **Error classes, never merged:** `NotFound` (the store answered: no such item), `Unavailable` (locked keychain, no Secret Service on the bus, the user denied a prompt, a timeout, any platform failure), `Corrupt` (an item of the wrong length).
   - Secret bytes live in `zeroize::Zeroizing<Vec<u8>>`. No type that holds a secret derives or implements `Debug`, `Display` or `Serialize`. Nothing in this module logs.
3. **State file** `security-state.json` in the app data directory (not in the webview profile; it holds no secret): `{ version: 1, backend: "apple-keychain" | "windows-credential-manager" | "secret-service:<collection or provider name>", dbKeyCreated: bool, createdAt }`, written atomically (temp file, fsync, rename).
4. **Commands** (each `#[tauri::command]`, declared in `build.rs` through `tauri_build::Attributes::new().app_manifest(AppManifest::new().commands(&[…]))`, allowed by a new `capabilities/secrets.json` with `windows: ["main"]`, `remote.urls: ["http://localhost:47821"]`):
   - `secrets_status()` → `{ keychain: "ok" | "unavailable", backend, backendChanged: bool, dbKey: "present" | "absent" | "unreadable", dbKeyEverCreated: bool, credentials: "present" | "absent" | "unreadable" }`.
   - `secrets_db_key(create: bool)` → raw 32 bytes (`tauri::ipc::Response`, never JSON). `create: true` generates and stores a key **only if** the item is `NotFound` **and** the state file does not say `dbKeyCreated`. `Unavailable` is returned as an error and never leads to creation. `NotFound` with `dbKeyCreated: true` is the error `KeyLost`. After creating, set `dbKeyCreated` and re-read the item to confirm it round-trips before returning it.
   - `secrets_storage_key()` → raw 32 bytes, created on first use under the same rules with its own flag.
   - `credentials_get()` → raw bytes (the stored blob) or `NotFound`; `credentials_set(request: tauri::ipc::Request)` (raw body, at most 2,048 bytes: Windows caps a credential blob at 2,560); `credentials_delete()`.
   - `secrets_forget_db_key()` (deletes the item and clears `dbKeyCreated`; used by reset and sign-out) and `secrets_erase_all()` (all three items and the state file).
5. **Caller check.** Every command takes the `tauri::Webview` and passes one function, `authorize(&webview) -> Result<(), Denied>`: the window label is in an allow-list (`["main"]` for now) and the webview's current URL has the origin `http://localhost:47821` (or the configured dev URL in debug builds). #<J-12> later adds the app-lock check to the same function. On denial return a fixed error with no detail.
6. **Backend change and weak backends (Linux).** At startup compare the backend the keyring crate reports with `backend` in the state file. If it differs and `dbKeyCreated` is true, `secrets_status().backendChanged` is true and `secrets_db_key` returns `BackendChanged` instead of `KeyLost`. If no Secret Service is on the session bus, `keychain` is `"unavailable"`: the app then runs without encryption and says so (#1017, #<J-11>); it never falls back to a file.
7. **TypeScript bridge** `src/lib/native/nativeSecrets.ts` (loaded only when `isNativeApp()`; `@tauri-apps/api/core` by dynamic import so the web bundle never contains it):
   - `secretsStatus()`;
   - `loadDatabaseKey({ create }): Promise<CryptoKey>`: invokes `secrets_db_key`, imports the bytes with `crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["wrapKey", "unwrapKey"])`, then overwrites the byte array with zeros before returning. Typed errors `KeyLostError`, `KeychainUnavailableError`, `BackendChangedError`;
   - `loadStorageKey(): Promise<Uint8Array>`; `getCredentialsBlob()`, `setCredentialsBlob(bytes)`, `deleteCredentials()`, `forgetDatabaseKey()`, `eraseAllSecrets()`.
8. `src-tauri/README.md`: a "Secrets" section: the three items, the state file, the error classes, the rule "Unavailable never creates", and how to inspect or delete the items with each OS's tool.

## Verification
- `~/.claude/bin/heavy cargo test --manifest-path src-tauri/Cargo.toml` passes new tests on the in-memory store and a store that can be switched to fail:
  - the database key is created once and is the same after a "restart" (a new instance over the same store and state file);
  - **`Unavailable` never creates:** with the store failing, `secrets_db_key(create: true)` errors, and after the store recovers the original key is returned unchanged;
  - `NotFound` with `dbKeyCreated` gives `KeyLost`, not a new key;
  - a changed backend name gives `backendChanged` and `BackendChanged`;
  - a 31-byte item is `Corrupt`;
  - `authorize` rejects another window label and another origin;
  - credentials round-trip; a 2,049-byte blob is rejected;
  - `format!("{:?}")` cannot be called on a secret type (a `compile_fail` doctest), and no test output contains the test key bytes.
- `~/.claude/bin/heavy cargo check --manifest-path src-tauri/Cargo.toml --features custom-protocol` is clean.
- `src/__tests__/nativeSecrets.test.ts` (the Tauri `invoke` mocked at the module boundary): the returned key is non-extractable with exactly `wrapKey`, `unwrapKey`; the byte array handed back by the mock is all zeros afterwards; each Rust error maps to its typed error; with `isNativeApp()` false nothing is imported.
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time. The web bundle does not contain `secrets_db_key` (`grep -R secrets_db_key dist` finds it only in a chunk loaded behind `isNativeApp()`; say which chunk).
- Manual on this machine's OS, recorded in the PR: run the app, call `secretsStatus()` and `loadDatabaseKey({ create: true })` from the devtools console of a debug build; see the item in the OS keychain tool; restart, same key. **From a live block** (an `html` block in a note) run `typeof window.__TAURI_INTERNALS__`, `window.ipc`, `window.webkit?.messageHandlers?.ipc`, `window.chrome?.webview` and try to post an invoke message: record what exists and that no secret command answers. Linux is the platform that matters most for this check.

## STOP and comment on the issue if
- A live block's frame can reach any IPC entry point that answers a secret command, on any platform. This blocks the whole epic on that platform; report exactly what was reachable.
- The `keyring` crate cannot tell "no such item" from "store unavailable" on a platform.
- The capability cannot be scoped to `http://localhost:47821` and window `main`.
- Returning raw bytes from a command is not possible from the remote origin (it falls back to JSON arrays). Report it; do not ship the key as a JSON number array without the owner's word.
- On Linux only a non-persistent or plaintext store is available on the test machine.

## Metadata
Depends on: #101
Size: M
Area: native, security
Model: opus
Effort: xhigh
