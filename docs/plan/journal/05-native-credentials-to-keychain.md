<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-05).
Title: Native: move the Homebase auth token and shared secret from localStorage to the OS keychain
Labels: agent-ready, security
Owner decision 3 (2026-11-10). Resolves review blocker B1. The epic's release rule: no build is called "encrypted at rest" without this.
-->
## Context
Epic #555. After sign-in the app stores two secrets in `localStorage`: the Homebase client auth token (key `BX0900`) and the shared secret (key `APSS`), written in `src/hooks/auth/useYouAuthAuthorization.ts:149-150` and read in `src/hooks/auth/useAuth.ts` (lines 23, 37, 41; removed at 113-114) and `src/lib/e2e/testHooks.ts:347-348`. With those two values anyone can download and decrypt every note from the user's Homebase. In a native app with an encrypted database they would sit in plain text in the webview's profile folder, next to the database they unlock: the encryption would be bypassed by reading one file (review finding B1).

In the native apps they move to the OS keychain (#<J-04>). The web app keeps `localStorage`: the landing page's head script and the edge routing depend on it, and a browser has no keychain.

The readers are synchronous (`useAuth` computes its first state from `hasSharedSecret()` during render), and the keychain is asynchronous. So the native app loads the credentials **once, before React renders**, and keeps them in memory.

## Change
1. **`src/lib/auth/credentialStore.ts`**, the only place that knows where credentials live:
   ```ts
   export function initCredentialStore(): Promise<void>;   // native: read the keychain into memory. web: nothing.
   export function getAuthToken(): string | null;
   export function getSharedSecret(): string | null;        // base64, as stored today
   export function hasCredentials(): boolean;
   export function setCredentials(c: { authToken: string; sharedSecret: string }): Promise<void>;
   export function clearCredentials(): Promise<void>;
   ```
   - Web (`!isNativeApp()`): reads and writes `localStorage` with the existing keys, exactly as today.
   - Native with a working keychain: memory, backed by `getCredentialsBlob` / `setCredentialsBlob` / `deleteCredentials` from `src/lib/native/nativeSecrets.ts`. The blob is UTF-8 JSON `{ v: 1, authToken, sharedSecret }`. `setCredentials` resolves only after the keychain write succeeded; on failure it throws and memory is not updated (a sign-in that cannot be stored must fail visibly, not silently last one session).
   - Native with `keychain: "unavailable"` (Linux without a Secret Service): falls back to `localStorage` and exposes `credentialProtection(): "keychain" | "plain"` for Settings (#<J-11>). No other fallback.
   - **Keychain present but unreadable at boot** (`Unavailable`): `initCredentialStore` rejects with `KeychainUnavailableError`. The boot shows "Journal can't reach your system keychain. Unlock it and try again." with Retry. It must **not** behave as signed out: `useAuth` would then run its logout path and wipe local data.
2. **Boot order** (`src/main.tsx`): in native, `await initCredentialStore()` (and the other pre-render native initialisation that later issues add; create one function `initNative()` in `src/lib/native/init.ts` for it) before `createRoot(...).render(...)`. The web path stays synchronous and unchanged.
3. **Replace every direct access** to the two keys with the store: `useAuth.ts` (`hasSharedSecret`, `getAppAuthToken`, `getSharedSecret`, and `logout`, which calls `clearCredentials()`), `useYouAuthAuthorization.ts` (`finalizeAuthorization` awaits `setCredentials`), `src/lib/e2e/testHooks.ts`. Then `grep -R "STORAGE_KEY_AUTH_TOKEN\|STORAGE_KEY_SHARED_SECRET" src` must show only `config.ts` and `credentialStore.ts`. Add an ESLint `no-restricted-syntax` or `no-restricted-properties` rule that forbids `localStorage.getItem/setItem/removeItem` with those two constants outside `credentialStore.ts`.
4. **One-time move (testers' builds):** in native with a working keychain, if `localStorage` holds both values and the keychain holds none, write them to the keychain, read them back, and only then remove them from `localStorage`. If the keychain already has credentials, just remove the `localStorage` copies.
5. **Other windows:** each window runs `initNative()` itself. After sign-in or sign-out in one window, tell the others through the existing `BroadcastChannel` pattern (`src/lib/broadcast/`) to reload their copy or reload the page.
6. **Never elsewhere:** the credentials must not enter the React Query cache, `app_state`, the diagnostics report or any log. Add a test for the diagnostics report (`src/lib/diagnostics/report.ts`) with a marker token.
7. `AGENTS.md`: the Homebase configuration and auth sections (where credentials live on each platform).

## Verification
- New `src/__tests__/credentialStore.test.ts`, with `nativeSecrets` mocked at the module boundary and a real `localStorage` stub:
  - web: behaves as today (reads and writes the two keys);
  - native: after `setCredentials`, `localStorage` has neither key and the mock keychain has the blob; `get*` are synchronous and correct after `initCredentialStore`;
  - native: a failing keychain write makes `setCredentials` throw and leaves `hasCredentials()` false;
  - native: `Unavailable` at init rejects with `KeychainUnavailableError` and does not report "signed out";
  - one-time move: moves, verifies, then removes; a failed keychain write leaves `localStorage` untouched;
  - keychain unavailable from the start: uses `localStorage` and reports `"plain"`.
- A `useAuth` test: with the keychain unreachable at boot, `logout` is not called and `clearAllLocalData` is not called.
- Existing auth tests and `~/.claude/bin/heavy npm run e2e -- e2e/routing` pass unchanged (the web path did not move).
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time.
- Manual in a native debug build, recorded in the PR: sign in; in devtools `localStorage.getItem('APSS')` and `'BX0900'` are `null`; restart, still signed in; the OS keychain tool shows `credentials-v1`; sign out, the item is gone.

## STOP and comment on the issue if
- Some code path needs the token before `initNative()` can finish (for example the service worker, or a script in `index.html`). Name it.
- `@homebase-id/js-lib` itself reads `APSS` or `BX0900` from `localStorage` (search its `dist`). Report the call sites; do not patch the library here.
- Awaiting the keychain before render delays the first paint of the native app by more than 100 ms (boot marks). Report the number.

## Metadata
Depends on: #<J-04>
Size: M
Area: auth, native, security
Model: opus
Effort: high
