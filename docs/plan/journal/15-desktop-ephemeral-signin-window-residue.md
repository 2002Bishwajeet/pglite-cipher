<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-15).
Title: Desktop: sign in through an ephemeral window, keep the main window on the app's origin, no window snapshots or crash dumps
Labels: agent-ready, security
A gap none of the earlier documents listed (docs/plan/00-overview.md, gaps 3, 19, 20). Release blocker for "encrypted at rest" on desktop.
-->
## Context
Epic #555. To sign in, the app sends its window to the user's Homebase owner console: `src/pages/Landing.tsx:59` sets `window.location.href` to `https://<identity>/api/owner/v1/youauth/authorize?…` (built in `src/hooks/auth/useYouAuthAuthorization.ts:100`). The user types their Homebase password there, approves the app, and the console redirects back to `http://localhost:47821/auth/finalize`. `src/hooks/auth/useMissingPermissions.ts` sends the window to `https://<identity>/owner/appupdate?…` the same way when the app needs more permissions.

In a browser that is normal. In the native shell it means the owner console ran **inside Journal's own webview profile** and left there:

- the owner session cookie. odin-core sets it with `Expires = now + 6 months` (`Odin.Hosting/Authentication/YouAuth/AuthenticationCookieUtil.cs`, used by `OwnerAuthenticationController`);
- the owner console's shared secret, in that origin's `localStorage` (odin-js `packages/apps/owner-app/src/hooks/auth/useAuth.ts`, `OWNER_SHARED_SECRET`).

Together they are owner-level access to the user's whole Homebase identity, far more than Journal's own token, sitting unencrypted in the profile folder the rest of this epic works to clean. Moving Journal's token to the keychain (#<J-05>) does not touch them.

Fix on desktop: the owner console runs in a **separate, ephemeral window** whose storage is never written to disk, and the main window never leaves the app's origin. Tauri 2.12 has what this needs: `WebviewWindowBuilder::incognito(true)` (WKWebView non-persistent data store, WebView2 InPrivate, WebKitGTK ephemeral; not on Android), `on_navigation`, `on_new_window`. The key pair for the sign-in exchange stays in the main window's storage, so the main window finishes the sign-in. Mobile has one webview and removes the data afterwards instead (#<J-13>, #<J-14>).

Two smaller leftovers of the same kind are checked here: window snapshots that macOS can save for "reopen windows", and crash dumps WebView2 can write with process memory in them.

## Change
1. **Rust command `auth_open_owner_console(url: String)`** (`src-tauri/src/auth_window.rs`; in the app manifest and the main window's capability, with the caller check of `secrets.rs`):
   - Accept only `https:` URLs whose path starts with `/api/owner/v1/youauth/authorize` or `/owner/appupdate`. Anything else is an error.
   - Create a window labelled `signin` with `incognito(true)`, a visible title "Sign in to your Homebase" and the host name shown (the user must be able to see where they type their password; the default title bar with the page title is not enough: put the host in the window title).
   - `on_navigation`: allow `https:` navigations (the console may redirect across its own pages); when the target is `http://localhost:47821/auth/finalize…` (or the app's origin with the `returnUrl` path for the permission flow), **cancel it**, close the `signin` window, and navigate the **main** window to that exact URL. Any other `http:` target is cancelled.
   - The `signin` label appears in **no** capability file: that window has no IPC at all. Add a Rust test that parses `capabilities/*.json` and fails if `signin` (or `*`) is listed.
   - Closing the window by hand emits `journal://signin-cancelled`.
2. **Main-window navigation guard:** `on_navigation` on the main window allows only the app's origin (and the dev URL in debug builds). An `https:` target that is an owner-console URL of step 1 is redirected into the `signin` window; every other external target is cancelled and opened in the system browser. `on_new_window` (for `window.open`, used for link previews, share URLs and "open in owner console", `src/helpers/noteMenuItems.ts:89`): open in the system browser, never a new webview. Use the smallest means available (`tauri-plugin-opener`, or the `open` crate) and give it no scope beyond `http:`/`https:` URLs.
3. **Page:** one function `openOwnerConsole(url)` in `src/lib/native/ownerConsole.ts`: native desktop → `invoke('auth_open_owner_console')`; everything else (web, and mobile until its issues land) → `window.location.href = url` as today. Use it in `Landing.tsx` and `useMissingPermissions.ts`. Handle `journal://signin-cancelled` by returning the landing page to its idle state.
4. **Existing residue (testers' installs):** at start, delete cookies that do not belong to the app's origin through `WebviewWindow::cookies()` / `delete_cookie()`. Per-origin `localStorage` cannot be deleted through Tauri on desktop: note in `src-tauri/README.md` that a tester who signed in with an older build should remove the app's data folder once. No public build has shipped, so no user is affected.
5. **macOS window snapshots:** make the app not restorable (`NSQuitAlwaysKeepsWindows = false` in the app's defaults at start, and non-restorable windows if the windowing library exposes it). Verify on a Mac that `~/Library/Saved Application State/id.homebase.journal.savedState/` is absent or holds no window image after quit with a note open.
6. **WebView2 crash dumps:** find out whether the shell's WebView2 user data folder gets `Crashpad/reports` minidumps and what they contain. If dumps with process memory are written, turn local dumps off if WebView2 offers it (environment options or the documented browser flag) and record how; if it cannot be turned off, record that as a known limit in `src-tauri/README.md` and in the PR, for the owner.
7. `src-tauri/README.md`: "Sign-in window", "Navigation rules", and the two findings of steps 5 and 6. `AGENTS.md`: auth section.

## Verification
- `~/.claude/bin/heavy cargo test --manifest-path src-tauri/Cargo.toml` passes new tests of the pure parts: the URL allow-list (accepts the two paths on `https`, rejects `http`, other paths, `javascript:`, `file:`, and a host with credentials in it); the navigation decision function (finalize URL → hand to main; other `http` → cancel; `https` → allow) ; the capability-file test.
- `src/__tests__/ownerConsole.test.ts`: native desktop calls the command with the built URL; web and mobile assign `location.href`; cancellation resets the landing state.
- `~/.claude/bin/heavy npm run e2e -- e2e/routing` passes unchanged (the web sign-in path did not move).
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time; `~/.claude/bin/heavy cargo check --manifest-path src-tauri/Cargo.toml --features custom-protocol` is clean.
- Manual on the machine's OS with a real or Docker identity (`npm run e2e:live:docker` brings one up), recorded in the PR:
  1. Start from a clean profile. Sign in: the console opens in its own window with the host in the title; after approval that window closes and the main window is signed in.
  2. Quit. Search the profile folder (give its path) for the identity's host name in cookie stores and `localStorage`/`Local Storage` files: no owner cookie, no `OWNER_SHARED_SECRET`. (Journal's own data may name the identity; the check is for the console's cookie name and key name.)
  3. Sign out and in again: the console asks for the password again (nothing was remembered). This is intended; say so in the release note.
  4. Click an external link in a note and a link preview: the system browser opens; the main window does not navigate.
  5. Trigger the permission flow (revoke a drive permission in the console, restart): it opens in the `signin` window and returns.
  6. From the `signin` window's devtools (debug build): `window.__TAURI_INTERNALS__` is undefined or every `invoke` is rejected.
- A `release-notes/` file: "Changed: on desktop, you sign in to your Homebase in a separate window. Journal does not keep that sign-in."

## STOP and comment on the issue if
- `incognito(true)` still writes cookies or storage to disk on a platform (check the profile folder after step 2).
- The redirect to `http://localhost:47821/auth/finalize` cannot be intercepted before the ephemeral window loads it (then the finalize page would run in the wrong storage).
- The owner console needs something a non-persistent store lacks (for example it stores a key in IndexedDB that a second step reads after a full reload) and the sign-in fails.
- Password managers cannot fill the console in the ephemeral window on the test platform. Do not block on it; report it, because it feeds owner question 12 (system browser instead).

## Metadata
Depends on: #101
Size: M
Area: native, auth, security
Model: opus
Effort: high
