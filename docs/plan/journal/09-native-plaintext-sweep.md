<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-09).
Title: Native: remove every plain-text leftover and stop writing note-derived data outside the encrypted stores
Labels: agent-ready, security
Owner decision 5 (2026-11-10). Closes gaps 6, 7, 8, 13 and 14 of docs/plan/00-overview.md.
If J-08 (migration) is closed as not planned, remove it from the Depends line; this issue then also deletes a plain `/pglite/journal-db-pg18` it finds, after J-10's reset has been confirmed by the user.
-->
## Context
Epic #555. In the native apps the database is encrypted (#1017), credentials are in the keychain (#<J-05>), sensitive device state is sealed (#<J-06>) and the query cache lives inside the database (#<J-03>). What remains are **leftovers** from before those changes, and a few places that still write note-derived data in plain text:

| Where | What | Action in native |
|---|---|---|
| IndexedDB `/pglite/journal-db-pg18` | The old plain database, after a verified migration (#<J-08>) | Delete; retry at every boot until gone |
| IndexedDB `/pglite/journal-db`, `journal-db` | Legacy Postgres 17 data (never created by native builds) | Delete if present |
| IndexedDB `keyval-store` | The old React Query cache (`journal-query-cache`) | Delete the database after #<J-03>'s one-time move ran |
| `localStorage` `BX0900`, `APSS` | Credentials, after #<J-05> moved them | Remove if the keychain has them |
| Cache Storage `proxied-images` | Every external image a note shows, keyed by its URL (`src/sw.ts`, the `/proxy-image/` route) | Delete; do not write in native |
| Cache Storage `images` | Cross-origin images (`request.destination === 'image'`) | Delete; do not cache cross-origin images in native |
| Cache Storage `api-cache` | Same-origin `/api/` responses; the native origin has none | Delete |
| IndexedDB `workbox-expiration` | The URL list Workbox keeps for the `images` cache | Remove the entries of deleted caches |

Deleting is not secure erasure: IndexedDB engines and SSDs can keep old pages. The app does what it can (delete, and never write again) and Settings says so honestly (#<J-11>).

The service worker cannot see `window`, so it recognises the native app by its origin, which is fixed forever (`http://localhost:47821`, `src-tauri/src/lib.rs`).

## Change
1. **`src/lib/native/origin.ts`:** `export const NATIVE_ORIGIN = 'http://localhost:47821'` and `isNativeOrigin(origin: string)`, with no `window` or DOM import, usable from the service worker. A Rust unit test in `src-tauri` asserts `PORT` equals the port in this constant (read the TypeScript file as text).
2. **Service worker (`src/sw.ts`), native origin only:**
   - `/proxy-image/` route: skip the cache lookup and the `cache.put`; fetch with `{ cache: 'no-store', mode: 'cors', credentials: 'omit' }` so the webview's HTTP cache does not keep a copy either. Offline, the existing 503 placeholder is returned.
   - `images` route: for cross-origin requests, answer with `fetch(request, { cache: 'no-store' })` and no Cache Storage; same-origin images (app icons) keep the cache.
   - In `activate`, on the native origin, delete `proxied-images` and `api-cache`, and delete cross-origin entries from `images`.
   - The web behaviour is unchanged; keep one code path with a single `const native = isNativeOrigin(self.location.origin)`.
3. **`src/lib/native/plaintextSweep.ts`**, `sweepPlaintext(state): Promise<SweepReport>`, run once per boot in native after the database is open, off the boot path (failures are logged and retried next boot):
   - delete the IndexedDB databases of the table **only when their condition holds**: the plain database only when `getDbProtection() === "encrypted"`; `keyval-store` only when `query_cache` has been read once (the move ran);
   - remove `BX0900`/`APSS` from `localStorage` only when `credentialProtection() === "keychain"` and `hasCredentials()`;
   - delete the caches and prune `workbox-expiration`;
   - return what was removed and what could not be (blocked deletes), as counts and names of stores, never contents.
4. **Audit for unknown stores.** After the sweep, list `indexedDB.databases()`, `caches.keys()` and the `localStorage` key names, and compare with an allow-list in `src/lib/native/storeAllowList.ts` (each entry with a reason: the two cipher slots, `blob-storage` from js-lib's one-time key exchange, Workbox's own, `webllm*` model caches, the sealed and plain keys of `src/lib/storage.ts`). Anything else is logged as a diagnostics warning "unclassified local store: <name>" and shown in Settings → Security (#<J-11>). This is how a store added by a future feature gets noticed.
5. **Static guard test.** `src/__tests__/storesClassified.test.ts` scans `src/` for `indexedDB.open(`, `caches.open(`, `createStore(` and `new Dexie(`-style calls and string literals passed to them, and fails if a name is not in the allow-list. Whoever adds a store must classify it.
6. `AGENTS.md`: under the PWA/service-worker notes, what the native origin does not cache and why.

## Verification
- `src/__tests__/plaintextSweep.test.ts` (`fake-indexeddb`, a Cache Storage stub): each row is removed when its condition holds and **kept** when it does not (plain database while `getDbProtection()` is `"plain"`; credentials while the keychain is unavailable; `keyval-store` before the move); a blocked delete is reported and retried on the next call; the report contains no values.
- `src/__tests__/swNativeCaching.test.ts` (the route handlers extracted into testable functions): on the native origin a proxied image is fetched with `cache: 'no-store'` and nothing is put in Cache Storage; on a web origin behaviour is as before.
- The audit flags a dummy database name and stays silent on the allow-list; the static guard fails when a dummy `caches.open('x')` is added (show the failing run in the PR, then remove it).
- `e2e/native/plaintext-sweep.spec.ts` (encryption mode): seed the browser profile with a plain database, an old query cache, both credential keys and a `proxied-images` entry containing a marker; load the app; afterwards none of them exists and no IndexedDB, Cache Storage or `localStorage` value contains the marker. A note with a hot-linked image still shows the image online.
- `~/.claude/bin/heavy npm run e2e -- e2e/pwa` passes unchanged (the web's caching did not move).
- `~/.claude/bin/heavy cargo test --manifest-path src-tauri/Cargo.toml` passes the port-constant test.
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time; `~/.claude/bin/heavy node scripts/check-pwa-build-identical.mjs` exits 0 when the submodule is present.

## STOP and comment on the issue if
- A delete would remove the only copy of something: the plain database while the encrypted store is not confirmed open, or credentials the keychain does not hold.
- Images inside notes (Homebase payload images, not hot-linked ones) turn out to be served from one of the caches being disabled, so they would stop working offline. Report which hook and route.
- `fetch` with `cache: 'no-store'` is not honoured by a target webview's service worker.

## Metadata
Depends on: #1017, #<J-03>, #<J-05>, #<J-06>, #<J-08>
Size: M
Area: native, security, pwa
Model: opus
Effort: high
