<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-04).
Title: Spike gate (provisional): apply the decision table to the measured engines, record the format parameters
Labels: agent-ready, security
Purpose: the owner chose (2026-11-10) to let the harness run unattended and to follow the planner's recommendations: store = IndexedDB with our format (question 2 A), encryption in the first native build (1 A), real lock (3 A), the recommended open budget (4). This issue applies the decision table to what an agent can measure (Node, Chromium, Firefox, WebKit) and records a PROVISIONAL decision. Device runs (macOS and iOS WKWebView, WebView2, Android WebView) move to PC-04b, which blocks nothing; if they later contradict this decision, the owner reopens the format issue.
-->
## Context
The spike (#<PC-03>) leaves a benchmark page and results for the browsers an agent can run. The numbers that decide the design come from the real webviews: WKWebView on macOS and iOS, WebView2 on Windows, Android WebView. Only the owner has those devices.

This is also where the review's S10 question is decided, before any package code: does the encrypted store live in the webview's IndexedDB with our format, or on the Rust side (`docs/plan/99-owner-questions.md`, question 2). Prior art points both ways: Signal and Notesnook desktop keep the store and the key out of the renderer; PowerSync and Notesnook web run an encrypted store over IndexedDB in a worker.

Nothing under `src/` is built until this issue is closed with the decisions below written in a comment. The later issues read that comment. The decision is **provisional**: it is made from the engines an agent can run, and confirmed on devices in #<PC-04b>.

## Change
No code. Read `spike/RESULTS.md` and `spike/results/*.json`: Node, Chromium, Firefox from #<PC-03>, and the device targets from #<PC-04c> (macOS WebKit and WKWebView, iPhone 15, iPad Air, Redmi; the iOS simulator counts for function only). Phone open time (G2) uses the iPhone if it was measured. Apply the table below to those engines, then post one comment on this issue with exactly these lines, and close it as completed:

```
Provisional: yes (measured: <targets>; owner-pending: <targets, or none> in #<PC-04b>)
Block size: 8192 | 32768 | 65536
Store: indexeddb
Open budget (100 MB): desktop 1500 ms, slowest target 3000 ms (owner question 4, recommended)
Durability: relaxed by default, strict on hide/close/migration/rotation: yes
Go: yes | no (reason)
Gate table: <G1–G9 per engine: value, target, pass>
```

The owner's answers already fixed the store (`indexeddb`) and the budget. Only the block size and Go come from the numbers.

How to choose:

| Result | Decision |
|---|---|
| G1–G6, G8 and G9 pass at 8 KB on every device run | `8192`, and `indexeddb` unless question 2 is answered otherwise |
| Only G9 fails (the file table costs too much at open, or ordinary syncs keep rewriting it) | `Go: no` for the packed layout as specified. The spike's STOP comment names the files; the format issue (#<PC-05>) is revised before any code |
| G2 (open) fails at 8 KB but passes at 32 or 64 KB | The smallest size that passes |
| G2 fails at every size on a device, or G6 shows missing support, and G7 is within budget | `rust-file` or `rust-sqlcipher`. Then #<PC-07> still builds the interface, the in-memory backend and the conformance suite; the Rust store is a new Journal issue from the stub in `99-owner-questions.md`; with `rust-sqlcipher`, #<PC-05> and #<PC-09> shrink to what the stub says |
| G2 fails everywhere, G7 too | `Go: no`. The design needs lazy loading of cold files; back to design |
| The trace found an operation that cannot be hooked | `Go: no`, until the spike's STOP comment is resolved |


## Verification
- The comment exists on this issue with every line above, and its gate table matches `spike/RESULTS.md`.
- `Go: yes`, and the issue is closed as completed.

## STOP and comment on the issue if
- Any row of the table gives `Go: no`, or a store other than `indexeddb`: post the comment with `Go: no` and the reason, do NOT close the issue, and return stopped. Every later issue waits for the owner.
- `spike/RESULTS.md` is missing, or doesn't have numbers for at least Node and Chromium.

## Metadata
Depends on: #<PC-03>, #<PC-04c>
Size: S
Area: spike, security
Model: sonnet
Effort: high
