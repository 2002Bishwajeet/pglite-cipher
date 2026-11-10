<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-04).
Title: Owner gate: approve the spike numbers, choose where the store lives, fix the format parameters
Labels: security   (NOT agent-ready: the owner closes this by hand)
Purpose: the harness treats an issue as done when it is closed. The spike's PR closes PC-03 as soon as it merges, before anyone has run the benchmark on a Mac or a phone. This issue is the real gate: every later issue here depends on it.
-->
## Context
The spike (#<PC-03>) leaves a benchmark page and results for the browsers an agent can run. The numbers that decide the design come from the real webviews: WKWebView on macOS and iOS, WebView2 on Windows, Android WebView. Only the owner has those devices.

This is also where the review's S10 question is decided, before any package code: does the encrypted store live in the webview's IndexedDB with our format, or on the Rust side (`docs/plan/99-owner-questions.md`, question 2). Prior art points both ways: Signal and Notesnook desktop keep the store and the key out of the renderer; PowerSync and Notesnook web run an encrypted store over IndexedDB in a worker.

Nothing under `src/` is built until this issue is closed with the decisions below written in a comment. The later issues read that comment.

## Change
Owner steps (about an hour):

- [ ] Run the benchmark page inside the Tauri shell on **macOS** (commands in `bench/README.md`), at 10 MB and 100 MB. Paste the JSON here.
- [ ] Run it on an **iPhone** (the slowest target unless you name another). Paste the JSON.
- [ ] Run it on **Windows** and **Android** if a device is at hand. If not, say so; the Journal checklist issue (plan file `journal/16`) then carries those runs.
- [ ] Read `spike/RESULTS.md`: the filesystem-operation answers (does `msync` occur, unaligned writes, holes, truncates, WAL recycling) and the upstream sync answers.

Then write one comment with these five lines, and close the issue:

```
Block size: 8192 | 32768 | 65536
Store: indexeddb (our format, WebCrypto) | rust-file (our format, ciphertext in a Rust-managed file) | rust-sqlcipher (blocks in a SQLCipher database in Rust)
Open budget (100 MB): desktop <n> ms, slowest target <n> ms
Durability: relaxed by default, strict on hide/close/migration/rotation  (yes | change to …)
Go: yes | no (reason)
```

How to choose:

| Result | Decision |
|---|---|
| G1–G6 and G8 pass at 8 KB on every device run | `8192`, and `indexeddb` unless question 2 is answered otherwise |
| G2 (open) fails at 8 KB but passes at 32 or 64 KB | The smallest size that passes |
| G2 fails at every size on a device, or G6 shows missing support, and G7 is within budget | `rust-file` or `rust-sqlcipher`. Then #<PC-07> still builds the interface, the in-memory backend and the conformance suite; the Rust store is a new Journal issue from the stub in `99-owner-questions.md`; with `rust-sqlcipher`, #<PC-05> and #<PC-09> shrink to what the stub says |
| G2 fails everywhere, G7 too | `Go: no`. The design needs lazy loading of cold files; back to design |
| The trace found an operation that cannot be hooked | `Go: no`, until the spike's STOP comment is resolved |

## Verification
- A comment with the five lines exists and `Go: yes`.
- The JSON from at least macOS and one iPhone is on the issue.

## STOP and comment on the issue if
- (For an agent that lands here by mistake.) This issue is the owner's. Do not work on it, do not close it.

## Metadata
Depends on: #<PC-03>
Size: S
Area: spike, security
