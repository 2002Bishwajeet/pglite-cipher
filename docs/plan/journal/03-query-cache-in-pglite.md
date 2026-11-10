<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-03).
Title: Persist the React Query cache in PGlite (one row per query) instead of IndexedDB key-value
Labels: agent-ready, security
Owner decision 4 (2026-11-10). Public code: ships for the PWA too. No dependency: can start today.
Closes gap 6 of 00-overview.md together with J-09 (which removes the old database in native).
-->
## Context
Epic #555. The app persists its whole React Query cache to IndexedDB so that people data shows up offline: `src/App.tsx:51-66` uses `createAsyncStoragePersister` with `idb-keyval` under the key `journal-query-cache`, for 7 days, with no filter. That cache holds contacts, connections, circles and their members, the security context, link metadata, version-history lists and image query data, in plain text, in its own IndexedDB database (`keyval-store`), outside the local database.

The native apps will encrypt the local database (PGlite). The owner decided (2026-11-10) that the query cache is important enough to keep, and that it should live **inside PGlite**, so the database encryption covers it with no second mechanism. The same code ships in the web app.

Two facts shape the design:
- Today the persister writes the whole cache as one JSON string on every change (throttled to 1 s by default). In PGlite that would rewrite megabytes into the WAL each time. So: **one row per query**, and only changed queries are written.
- The app's queries wait for the cache restore (`src/App.tsx`: "Queries wait for this restore, so a stuck IndexedDB read here holds the splash (#806)"). The restore will now wait for the database to open. Local notes do not use React Query (they are PGlite live queries), so only server-state queries wait.

## Change
1. **Schema** (`src/lib/db/schema.ts`): add in `runMigrations()` and in `initializeSchema()`'s base DDL, and bump `SCHEMA_VERSION`:
   ```sql
   CREATE TABLE IF NOT EXISTS query_cache (
     query_hash TEXT PRIMARY KEY,
     query_key  JSONB NOT NULL,
     state      JSONB NOT NULL,
     updated_at BIGINT NOT NULL
   );
   ```
   One extra row with `query_hash = '__meta__'` holds `{ buster, timestamp }` in `state`.
2. **Queries** (`src/lib/db/queries/queryCache.ts`, exported from the `queries` index): `loadQueryCache()` (all rows), `upsertQueryCacheRows(rows)` and `deleteQueryCacheRows(hashes)` in one transaction, `clearQueryCache()`.
3. **Persister** (`src/lib/queryPersister.ts`): implement TanStack's `Persister` interface (`persistClient`, `restoreClient`, `removeClient`) so `PersistQueryClientProvider` in `src/App.tsx` is used unchanged.
   - `restoreClient`: `await getDatabase()`, read all rows, return `{ buster, timestamp, clientState: { queries, mutations: [] } }`. On any error return `undefined` (an empty cache) and `console.warn`; a cache must never block or fail the boot.
   - `persistClient(client)`: **throttled to one write per 10 s**, trailing, and flushed on `visibilitychange` → hidden. Keep a `Map<queryHash, dataUpdatedAt>` of what is stored; upsert only queries whose `state.dataUpdatedAt` changed, delete hashes that are gone. Do not write mutations.
   - `removeClient`: `clearQueryCache()`.
   - `dehydrateOptions.shouldDehydrateQuery`: only `status === 'success'`, and **not** the `verifyToken` query (a cached "token is valid" must never be restored) nor `image` / tiny-thumb queries whose data holds an object URL (`blob:` URLs are dead after a reload; check what `src/hooks/image/useImage.ts` and `useTinyThumb.ts` store and exclude exactly the ones that hold `blob:`).
4. **Wire it** in `src/App.tsx`: replace the `idb-keyval` persister with the new one; keep `maxAge` 7 days and the `markBoot("query-cache")` call. Do not import `@/lib/db` statically from `App.tsx` (it would pull PGlite into the main chunk): the persister imports it dynamically.
5. **One-time move, then delete the old copy.** On the first restore: if `query_cache` is empty and `idb-keyval`'s `get('journal-query-cache')` returns a value, parse it, write its queries as rows, then `del('journal-query-cache')`. On later boots only `del` if it still exists. Remove `idb-keyval` from `package.json` only if nothing else imports it after this (`grep -R "idb-keyval" src`); the one-time move needs it for now, so it probably stays. Note in the PR that a follow-up can drop it after two releases.
6. **Sign-out:** `clearAllLocalData()` in `src/lib/db/queries/syncRecords.ts` also deletes `query_cache`, and `logout` in `src/hooks/auth/useAuth.ts` calls `queryClient.clear()`. Today a signed-out browser keeps the previous user's contacts for 7 days; fix that here.
7. **Public share pages** never open the database (`isPublicSharePath`). There the persister's `restoreClient` returns `undefined` at once and `persistClient` does nothing.
8. Update `AGENTS.md`: the "Data pattern" and "Performance" lines that say the cache is persisted to IndexedDB, and the schema section (table count, the new table).
9. A `release-notes/` file is not needed (no visible change), unless sign-out behaviour counts: add one "Fixed" bullet for step 6.

## Verification
- New `src/__tests__/queryPersister.test.ts` (real PGlite through `src/__tests__/testDb.ts`):
  - a persisted client restores with the same query data, `buster` and `timestamp`;
  - a second `persistClient` with one changed query writes exactly one row (spy on the upsert) and deletes a removed query's row;
  - calls within the throttle window produce one write; the hidden-page flush writes at once;
  - `verifyToken` and `blob:` image queries are never written;
  - a restore when the database rejects returns `undefined` and does not throw;
  - the one-time move imports an old `idb-keyval` value and deletes it; a second boot does not import again;
  - `clearAllLocalData()` empties `query_cache`.
- A schema test: an existing database at the previous `SCHEMA_VERSION` gains the table (`src/__tests__/` has the pattern for schema revisions).
- `~/.claude/bin/heavy npm run e2e -- e2e/boot` passes unchanged (boot is not slower to first note list; the splash does not wait on the cache longer than on the database).
- New hermetic spec `e2e/boot/query-cache.spec.ts`: load the app with a seeded contact query, reload offline, the contact name renders; after sign-out and reload, IndexedDB has no `journal-query-cache` key and `query_cache` is empty.
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time.
- In the PR: the boot marks (`journal-boot:*`) before and after on the e2e build, showing `query-cache` now lands after `db-open` and by how much.

## STOP and comment on the issue if
- A screen that must render before the database is open depends on a restored query (the landing page, `/auth/finalize`, the boot error screen). List the query; do not add a second persister.
- Moving the restore after the database makes the first note list measurably slower (more than 100 ms in the boot marks). Report the marks.
- The per-query diff cannot be done with the stable `Persister` interface and needs `experimental_createQueryPersister`. Say why before using an experimental API.

## Metadata
Depends on: none
Size: M
Area: db, security, sync
Model: opus
Effort: high
