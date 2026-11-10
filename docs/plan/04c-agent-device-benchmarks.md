<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-04c).
Title: Device benchmarks run by agents: macOS WebKit and WKWebView, iOS simulator, iPhone 15, iPad Air, Redmi
Labels: agent-ready, security
-->
## Context
The spike (#<PC-03>) measures Node, Chromium and Firefox on the Linux host. The numbers that decide the format come from the real engines the native apps use: WebKit and WKWebView on macOS and iOS, Chromium on Android. The owner's machines are reachable from the harness over the tailnet (owner, 2026-11-10: "yes for all"):

| Target | How to reach it |
|---|---|
| MacBook Pro (M1 Pro, macOS 27, Xcode 27.2) | `scripts/harness/remote.sh mac <cmd>` (syncs the worktree, installs per lockfile, runs under the Mac's heavy lock, copies `spike/results/` back) |
| iOS 27 simulator | on the Mac: `xcrun simctl` (boot a device, `simctl openurl booted <url>` opens Mobile Safari) |
| iPhone 15 and iPad Air 11-inch (M3), both paired with the Mac | `xcrun devicectl list devices` on the Mac shows them "available (paired)" |
| Redmi (Android) | `adb` on the G14 (`~/.local/bin/adb`), once the owner has paired it over Wireless debugging |

The gate (#<PC-04>) waits for this issue and uses its numbers.

## Change
1. **A results collector.** `spike/device/serve.mjs`: serves the bench page and accepts `POST /result` (the bench page's JSON plus a `target` name), saving it to `spike/results/<target>.json`. No dependencies beyond Node.
2. **Secure context everywhere.** WebCrypto's `subtle` exists only in secure contexts, so plain `http://<lan-ip>` won't work on a phone:
   - Mac and iOS simulator: `http://localhost:<port>` (localhost is a secure context; the simulator shares the Mac's network).
   - iPhone and iPad: HTTPS through `tailscale serve` on the Mac (`tailscale serve --bg <port>`; the URL is the Mac's `*.ts.net` name). Turn the serve off when done (`tailscale serve reset` only for that port: never touch other serves).
   - Redmi: `adb reverse tcp:<port> tcp:<port>` from the G14, with the collector running on the G14, then `http://localhost:<port>`.
3. **Targets**, each at 10 MB and 100 MB, three runs, recording the median:
   - `mac-webkit`: Playwright WebKit on macOS (`remote.sh mac`).
   - `mac-wkwebview`: a minimal WKWebView host that loads the page (`spike/device/wkhost.swift`, run with `swift` on the Mac, no Xcode project; it exits when the result is posted). This is the engine Tauri uses on macOS.
   - `ios-sim`: Mobile Safari in the booted iOS 27 simulator. Functional only: simulator speed is the Mac's CPU, not a phone's; mark its timings "not representative".
   - `iphone-15` and `ipad-air-m3`: Safari on the device, opened on the HTTPS URL. Try `xcrun devicectl device process launch --device <udid> com.apple.mobilesafari <url>` **[unverified]**; if launching Safari with a URL that way is impossible, try a minimal WKWebView app installed with `xcodebuild` and automatic signing (the owner's personal team is set up in Xcode). If neither works, record the target as `owner-pending` with the exact URL to open; that is not a STOP.
   - `redmi`: Chrome on the phone through `adb shell am start -a android.intent.action.VIEW -d <url>`. If `adb devices` shows no device, record `owner-pending` with the pairing steps (Settings → Developer options → Wireless debugging → Pair device with pairing code → `adb pair <ip>:<port>`, then `adb connect <ip>:<port>`).
4. **Results.** Add a "Devices" section to `spike/RESULTS.md`: one row per target with the engine version, G1–G9 values against their targets, pass/fail, and the targets left `owner-pending` with what the owner must do.

## Verification
- `node spike/device/serve.mjs --self-test` starts, accepts a posted sample and writes it (exit 0).
- `spike/results/mac-webkit.json` and `spike/results/mac-wkwebview.json` exist with 10 MB and 100 MB rows.
- `spike/RESULTS.md` has the Devices section with every target listed, measured or `owner-pending`.
- The Mac's `tailscale serve` status shows no serve left on the bench port.

## STOP and comment on the issue if
- The Mac is unreachable (`remote.sh mac true` exits 4) for the whole run.
- A device run shows a functional failure (WebCrypto or IndexedDB error, wrong output) rather than a slow number: that is a design issue for #<PC-04>, report it with the error.

## Metadata
Depends on: #<PC-03>
Size: M
Area: spike, bench, devices
Model: opus
Effort: high
