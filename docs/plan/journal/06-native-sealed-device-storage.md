<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-06).
Title: Native: seal the localStorage entries that hold note content, titles and searches
Labels: agent-ready, security
A gap none of the earlier documents listed (00-overview.md, gaps 4 and 5).
-->
## Context
Epic #555. The native apps encrypt the local database. Some note-derived data is deliberately **not** in the database but in `localStorage`, because it must be written synchronously or read before the database is open:

| Key | Holds | Written by |
|---|---|---|
| `journal-unsaved-edits:<docId>` | **Note content**: a base64 Yjs update, saved when the page is hidden or unloaded so an edit survives a killed page | `src/lib/yjs/unsavedEdits.ts` |
| `journal-open-tabs` | Open tabs with their **note titles** | `src/hooks/useTabManager.ts` |
| `journal-recent-notes` | Recent notes with **titles** | `src/lib/recentItems.ts` |
| `journal-recent-searches` | The user's **search queries** | `src/lib/recentItems.ts` |
| `journal-session-state` | Last note and folder ids | `src/hooks/useSessionPersistence.ts` |

In a native app with an encrypted database these would stay readable in the webview's profile folder. They cannot move into the database: `unsavedEdits.ts` exists precisely because a database write is asynchronous and may not finish before the page dies.

So they stay in `localStorage`, **sealed**: encrypted with a key from the OS keychain (`loadStorageKey()` from #<J-04>). Reads and writes must remain synchronous, and WebCrypto is asynchronous only, so this uses a small audited synchronous cipher.

The web app is unchanged: no sealing, no new code in its bundle beyond the branch that skips it.

## Change
1. **Dependency:** `@noble/ciphers` (audited, no dependencies). Use `xchacha20poly1305`: its 24-byte random nonce needs no counter and no budget. Import it only from the module below, loaded by dynamic import in `initNative()` (`src/lib/native/init.ts`), so it is not in the web bundle's initial chunks. Add only its lockfile entries.
2. **`src/lib/native/sealedStorage.ts`:**
   - `initSealedStorage(key: Uint8Array)`: keeps the key in module memory.
   - `seal(name: string, value: string): string` → `"sealed:v1:" + base64(nonce24 ‖ ciphertext)`, with the storage key **name as associated data**, so a sealed value cannot be moved to another key.
   - `unseal(name: string, stored: string): string | null`: returns `null` for a value that does not authenticate (and removes nothing; the caller treats it as absent).
   - `isSealed(stored)`.
3. **`src/lib/storage.ts`:** add `SEALED_KEYS` (`TABS_STORAGE_KEY`, `SESSION_STORAGE_KEY`, `RECENT_NOTES_KEY`, `RECENT_SEARCHES_KEY`) and `SEALED_PREFIXES` (`journal-unsaved-edits:`). `readString`, `writeString`, `readJson`, `writeJson` seal and unseal for those names **when sealing is active** (native and a key is loaded). When sealing is active and a stored value for such a name is **not** sealed (an older build), return it once and rewrite it sealed. When sealing is not active on native (the key could not be loaded), reads of those names return `null` and writes are dropped: never write them in plain text on native. On the web nothing changes.
   Export `readSealed(name)` / `writeSealed(name, value)` for other secrets that belong in `localStorage` (bring-your-own API keys, #1034).
4. **Direct `localStorage` users:** move every read and write of the names above onto `storage.ts` (`grep -R "localStorage" src` lists the files; `useAuth.ts` only removes them, which may stay). `unsavedEdits.ts` already uses `readString`/`writeString`; its key enumeration (`unsavedEditDocIds`) keeps working because names stay in clear (a document id is not sensitive).
5. **Boot:** `initNative()` loads the storage key (`loadStorageKey()`), imports the cipher module and calls `initSealedStorage` **before** React renders, because `useTabManager` and `useSessionPersistence` read during their first render.
6. **Sign-out** (`useAuth.ts` `logout`): unchanged removal of the keys. #<J-10> deletes the storage key itself.
7. **Guard test for new keys:** `src/__tests__/storageKeysClassified.test.ts` reads `src/lib/storage.ts` and fails when an exported `*_KEY` constant is in neither `SEALED_KEYS`/`SEALED_PREFIXES` nor an explicit `PLAIN_KEYS` list with a one-line reason each. A new key must be classified by whoever adds it.

## Verification
- `src/__tests__/sealedStorage.test.ts`: round trip; a value sealed for one name does not unseal under another; a flipped bit gives `null`; two seals of the same value differ; the output never contains the plaintext (a marker string) in UTF-8 or base64.
- `src/__tests__/storage.test.ts` (extend): with sealing active, `writeJson(TABS_STORAGE_KEY, …)` stores a `sealed:v1:` value and `readJson` returns the object; an old plain value is returned and rewritten sealed; with sealing inactive on native, sealed names read `null` and writes store nothing; a non-sensitive key (theme) is stored in clear; on the web everything is stored as today.
- `src/__tests__/pglite_provider_unload.test.ts` (extend): the unsaved-edit copy written on page hide is sealed on native and is restored on the next load.
- The guard test of step 7 passes and fails when a dummy key is added (show the failing run in the PR, then remove the dummy).
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time. The main web chunk does not contain `xchacha20` (say how it was checked).
- Manual in a native debug build, recorded in the PR: type a marker word in a note, open two tabs, search for a marker query, hide the window; in devtools every value of the keys above starts with `sealed:v1:` and no `localStorage` value contains either marker.

## STOP and comment on the issue if
- A sensitive value is read from `localStorage` before `initNative()` can run (a script in `index.html`, the service worker).
- Sealing on page hide is too slow for a large unsaved edit (more than 20 ms for 1 MB on a phone-class device; measure in Node as a proxy and say so).
- You would rather add no dependency: the alternative is to keep these values in Rust (a sealed file behind commands). Describe it and wait; do not hand-write a cipher.

## Metadata
Depends on: #<J-04>
Size: M
Area: native, security, storage
Model: opus
Effort: high
