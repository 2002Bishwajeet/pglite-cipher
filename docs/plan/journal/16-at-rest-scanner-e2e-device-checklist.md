<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-16).
Title: Prove it: at-rest scanner, an e2e that dumps every browser store, and the real-device checklist
Labels: agent-ready, security
The last issue of the epic. "Encrypted at rest" is announced for a platform only after its checklist run is recorded here.
-->
## Context
Epic #555. Every other issue of the epic closes one place where the native app kept note-derived data or secrets in plain text. This issue is the proof that none is left, and the guard that keeps it so:

1. **A scanner** that searches a folder (an app profile, a backup, a phone's app container) for known marker strings and secrets, in the encodings storage engines use.
2. **An end-to-end spec** that uses the app like a person does and then dumps every store a web page can see, on every pull request to the native workflow, so that a feature that adds a new plain-text store fails CI.
3. **A device checklist** the owner runs once per platform before the claim is made, with the exact commands and expected results.

The scanner needs markers that compression cannot hide: LevelDB (Chromium, WebView2, Android) compresses blocks with Snappy and V8 serialises strings as Latin-1 or UTF-16. Random markers of 24 letters and digits are incompressible, so they appear verbatim in one of a few encodings if they are on disk at all.

## Change
1. **`scripts/native/scan-at-rest.mjs`** (Node, no dependencies):
   `node scripts/native/scan-at-rest.mjs <dir> [--marker <text>]… [--markers-file <path>] [--secrets-stdin]`
   - Walks `<dir>` (follows no symlinks), reads every file in overlapping chunks, and searches for each marker as: UTF-8, UTF-16LE, UTF-16BE, base64 of UTF-8 at the three byte alignments, and lowercase hex.
   - `--secrets-stdin` reads one secret per line from stdin (for the auth token and shared secret, so they never appear in a shell history or process list) and treats them like markers but prints only `secret #n`, never the value.
   - Output: one line per hit (relative path, offset, encoding, marker name), a summary, exit code 1 on any hit, 0 on none, 2 on usage or read errors. Unreadable files are listed and make the exit code 2: a file the scanner could not read is not a pass.
   - `--self-test`: writes a temporary folder with each marker in each encoding, inside a file with random padding, and checks that all are found and that a control marker is not.
2. **`e2e/native/at-rest.spec.ts`** (encryption mode from #1017; runs in `.github/workflows/native-encryption.yml`). With random markers generated per run: create a note with a body marker and a title marker; add a hot-linked external image whose URL contains a marker (served by the test's own route); search for a query marker; open two tabs; seed a contact whose name is a marker through the provider stub the e2e build already uses for people data; hide the page (to trigger the unsaved-edit copy); reload. Then dump, from the page: every IndexedDB database (all object stores, keys and values, binary included), all of `localStorage` and `sessionStorage`, every Cache Storage entry (URL and body), and `document.cookie`. Assert no marker and neither fake credential appears in any of them in the scanner's encodings (import the scanner's matching function; one implementation). Assert the expected stores **do** exist and are non-empty (the cipher slot, sealed keys), so an empty dump cannot pass.
   Negative control in the same spec: run the same steps in plain web mode and assert the dump **does** contain the body marker (proves the dump and the matcher see what they should).
3. **`src-tauri/SECURITY-CHECKLIST.md`**: one section per platform (macOS, Windows, Linux, iOS, Android), each with:
   - the profile and cache folders to scan (macOS: `~/Library/WebKit/id.homebase.journal`, `~/Library/Caches/id.homebase.journal`, `~/Library/HTTPStorages/id.homebase.journal`, `~/Library/Application Support/id.homebase.journal`, `~/Library/Saved Application State/id.homebase.journal.savedState`; Windows: `%LOCALAPPDATA%\id.homebase.journal` including `EBWebView`; Linux: `~/.local/share/id.homebase.journal`, `~/.cache/id.homebase.journal`; iOS: the downloaded app container; Android: `run-as` tar of the app's data). **Verify each path on a real install and correct the list**; these are from documentation, not from this app.
   - the script: sign in; create a note with the markers; add a contact-bearing action (open the share dialog so circles and contacts load); search; hot-link an image; hide and quit; how to read the token and shared secret from the OS keychain tool **into the scanner's stdin** (macOS `security find-generic-password -s id.homebase.journal -a credentials-v1 -w | …`; equivalents for the others); run the scanner; expected: exit 0.
   - the checks that are not a scan: the keychain item exists and is not readable from a second user account; app lock (prompt first, nothing visible behind it, auto-lock); sign-in leaves no owner cookie; a backup of the profile restored on another machine or user account ends in "Download again", not in data; delete the keychain item → "Download again"; lock the keychain → no reset offered; the HTTP disk cache folder contains no marker (this is the check for gap 12 of the overview); crash dumps folder empty or without markers; on Windows and Linux, a note in the result that other programs of the same user can read the key (expected, documented).
   - the benchmark page run for that platform (pglite-cipher `bench/README.md`) and where to paste its JSON.
   - a results table to copy into this issue: platform, OS version, app version, date, scanner exit code, each check pass/fail, notes.
4. **Follow-ups from the scan:** any hit becomes a new issue named after the store it was found in; this issue stays open for that platform until the hit is fixed and the run repeated. If the HTTP cache holds a marker, the follow-up is "clear the webview's disk cache through the platform API at start" (macOS/iOS `WKWebsiteDataStore.removeData(ofTypes: [diskCache])`, WebView2 `ClearBrowsingDataAsync`, WebKitGTK `webkit_website_data_manager_clear`, Android `WebView.clearCache(true)`).
5. Link the checklist from `AGENTS.md` (testing section) and from the epic.

## Verification
- `node scripts/native/scan-at-rest.mjs --self-test` exits 0.
- `src/__tests__/scanAtRest.test.ts`: finds a marker in each encoding at a chunk boundary; `--secrets-stdin` output never contains the secret; an unreadable file gives exit code 2; a clean folder gives 0.
- `e2e/native/at-rest.spec.ts` passes in the native workflow, including the negative control. Run it 5 times locally and state that it passed 5 of 5.
- `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint`, `~/.claude/bin/heavy npm run test` exit 0, one at a time, with and without the submodule.
- On this machine's OS, run the checklist section for it with a debug or release build and paste the results table in the PR, with the corrected folder list.
- The checklist exists for all five platforms. The owner runs the other four; this issue is closed when the table has a passing row for every platform that is about to ship.

## STOP and comment on the issue if
- The e2e dump finds a marker. Do not adjust the spec: name the store, find the writer, and open (or point to) the issue that owns it.
- The scanner finds a marker in this machine's real profile folder. Same rule; include the path and encoding.
- A store exists that the page cannot dump and the scanner cannot read (for example a locked database file while the app runs). Say which and how the checklist handles it (scan after quit).

## Metadata
Depends on: #<J-09>, #<J-10>, #<J-15>
Size: M
Area: native, security, e2e
Model: opus
Effort: high
