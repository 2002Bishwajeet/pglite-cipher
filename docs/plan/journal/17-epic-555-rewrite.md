<!--
FILING: REWRITES 2002Bishwajeet/journal#555 (replace its whole body; keep the number). Not an agent issue: it is the epic.
New title: Epic: native apps are secure at rest (database, credentials, caches, sign-in residue)
After filing: make every Journal issue of this plan a sub-issue of #555, and update M4 in #306 to list them. Edit #554's banner from "parked" to "dropped (2026-11-10)" and close it as not planned.
-->
Make the native apps (Tauri: macOS, Windows, Linux, iOS, Android) keep nothing readable on the device that comes from the user's notes, people or sign-in. This is a paid-native selling point (#306, M4). The PWA stays a strong experience and gets no encryption (owner decisions 2026-11-10; browser encryption #554 is dropped).

The first version of this epic covered the database only. The database is one of several places: the Homebase token sat next to it in `localStorage`, the owner console's session stayed in the webview after sign-in, unsaved edits and note titles were in `localStorage`, people data in a second IndexedDB database, images in the service worker's cache. The full list and what is done about each: `vendor/pglite-cipher/docs/plan/00-overview.md` section 4 (private repository; summary below).

## What is protected, honestly
- **Protected:** a copy or backup of the app's files, a powered-off device, another account on the machine. On macOS also other apps (signed builds).
- **Not protected:** software running under the user's account while Journal is open; on Windows and Linux, other programs of the same user can ask the system for Journal's key; exports, prints and the Markdown mirror (#1015); memory and swap.
- Customer wording and the words not to use: `docs/plan/01-sqlcipher-comparison.md` section 4 in the private repository.

## How it is built
- **Database:** `pglite-cipher`, a private repository (`2002Bishwajeet/pglite-cipher`), consumed as an **optional** submodule at `vendor/pglite-cipher`. SQLCipher's design adapted to PGlite: Postgres runs on an in-memory copy; changed 8 KB blocks are sealed with AES-256-GCM and written in one atomic batch per sync. The public repository and the PWA build work without the submodule (#553).
- **Keys and credentials:** the OS keychain, through Rust commands that check their caller.
- **Everything else:** moved into the encrypted database, sealed with a keychain key, or no longer written.

## Issues
Order matters; see each issue's `Depends on:` line. Cross-repository dependencies are written in the issues' Context.

**Foundation**
- [ ] #553 Consume pglite-cipher as an optional private submodule (build switch, native CI, harness worktrees)
- [ ] #<J-02> Benchmark-only Rust endpoints for the spike (gate G7)
- [ ] #<J-03> Persist the React Query cache in PGlite (ships for the PWA too)

**Secrets**
- [ ] #<J-04> Desktop: secrets in the OS keychain
- [ ] #<J-05> Move the Homebase auth token and shared secret to the keychain
- [ ] #<J-06> Seal the `localStorage` entries that hold note content, titles and searches
- [ ] #<J-15> Desktop: sign in through an ephemeral window; navigation guard; no window snapshots or crash dumps

**Database**
- [ ] #1017 Open the local database through pglite-cipher with the keychain key
- [ ] #<J-08> Move an existing plain database into the encrypted store (only if a plain native build ever ships)
- [ ] #<J-09> Remove every plain-text leftover; stop writing note-derived data outside the encrypted stores
- [ ] #<J-10> Recovery, "reset and sync again", crypto-erase on sign-out

**User-facing**
- [ ] #<J-11> Settings → Security
- [ ] #<J-12> Desktop app lock (Touch ID, Windows Hello)

**Mobile**
- [ ] #<J-13> iOS: Keychain, Face ID lock, app-switcher cover, sign-in residue, backups
- [ ] #<J-14> Android: Keystore, biometric lock, backup rules, `FLAG_SECURE`, sign-in residue

**Proof**
- [ ] #<J-16> At-rest scanner, an e2e that dumps every browser store, the real-device checklist

In `2002Bishwajeet/pglite-cipher` (private): scaffold; spike and benchmark page; **owner gate**; format v1 and crypto core; dirty-block tracker; storage backends; EncryptedFs; key change and rotation; plain-text import; benchmark, fuzz and CI gates.

## Gates
1. **Owner gate** (pglite-cipher): the owner runs the benchmark page in the real webviews (macOS, iPhone; Windows and Android if at hand), chooses where the store lives and the block size, and sets the open-time budget. No package code before it.
2. **Release rule:** no build is described as "encrypted at rest" until #<J-05>, #<J-06>, #<J-09>, #<J-15> and #<J-16> are closed for that platform. A build with only the database encrypted leaves the token beside it.
3. **Before any of this ships on desktop:** #1012 (the localhost port bind) is in, as before.

## Constraints on other issues
- #1014 (quick capture): the capture window loads the key like the main window; with the lock on, the hotkey unlocks first.
- #1015 (Markdown mirror): listed under "Stored unencrypted" in Settings; says so when turned on.
- #1016 (notifications): no title or text while the app lock is on.
- #1034 (bring-your-own API keys): stored with `writeSealed()`.
- #305 (signed builds): stable signing identity (keychain access); builds with `npm run build:native` and the deploy key; never the `encfs-bench` feature.

## Open owner decisions
`docs/plan/99-owner-questions.md` in the private repository. The first four block work: whether a native build without encryption ever ships; where the store lives; what "locked" means; the open-time budget.

## Metadata
Depends on: none
Area: db, native, security
