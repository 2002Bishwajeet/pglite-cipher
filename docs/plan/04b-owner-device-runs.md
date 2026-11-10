<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-04b).
Title: Owner: confirm the spike numbers on real webviews (macOS, iPhone, Windows, Android)
Labels: security   (NOT agent-ready: the owner does this; nothing depends on it)
-->
## Context
#<PC-04> made a provisional decision (block size, Go) from the engines an agent can run on the Linux host. The numbers that matter in the product come from the real webviews: WKWebView on macOS and iOS, WebView2 on Windows, Android WebView. This issue records them. It blocks nothing, so the harness keeps going; if a device contradicts #<PC-04>, reopen the format issue (#<PC-05>) with the numbers.

## Change
Owner steps (about an hour, any time):

- [ ] Run the benchmark page inside the Tauri shell on **macOS** (commands in `bench/README.md`), at 10 MB and 100 MB. Paste the JSON here.
- [ ] Run it on the **oldest iPhone** you will support (name it). Paste the JSON.
- [ ] **Windows** and **Android** if a device is at hand; otherwise say so, and the Journal checklist (plan file `journal/16`) carries them.
- [ ] Compare against #<PC-04>'s gate table. If a gate fails on a device (G2 open time in particular), comment with the numbers and reopen #<PC-05>.

## Verification
- The JSON from at least macOS and one iPhone is on this issue.

## STOP and comment on the issue if
- (For an agent that lands here by mistake.) This issue is the owner's. Do not work on it, do not close it.

## Metadata
Depends on: none
Size: S
Area: spike, security
