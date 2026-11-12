# Spike benchmark page (issue #2): owner run sheet

Throwaway. The page builds a database with plain `idb://` and with the prototype filesystem
(`spike/protoFs.ts`) at 8, 32 and 64 KB blocks, and measures the gates of
`docs/plan/03-spike-prototype-benchmarks.md`. Nothing here ships.

## Build and serve

```sh
npm run bench:build   # writes bench/dist/ (static; base './')
npm run bench:serve   # http://127.0.0.1:47900, with COOP/COEP headers
```

Open the page, tick the parts, press **Run**, then **Copy results** (one JSON object; it is also
printed in the `<pre>`). Parts:

| Part | What | Time (desktop Chromium) |
| --- | --- | --- |
| gates, 10 MB | G1, G1b, G2, G3, G4, G9 at 10 MB | a few minutes |
| gates, 100 MB | the same at 100 MB | long; run it alone |
| extras | G6 support, G8 `deriveKey` (median of 1,000), AES-GCM 100 MB at 8/32/64 KB | under a minute |
| year | G8: 365 open/edit/checkpoint/close sessions on the prototype, live salts at the end | several minutes |
| G7 | Rust store throughput; only inside a Tauri shell built with `encfs-bench` | about a minute |

URL parameters run it without clicking: `?auto=1&parts=gates10,extras&runs=20` (and `&sessions=365`
for the year). The page sets `window.__benchResult` when it finishes; `node spike/run.mjs` uses that.

## Inside the Tauri shells (G7, WKWebView, WebView2, Android WebView, iOS)

You need a Journal checkout with `src-tauri` (branch `feat/97-tauri-shell`, or `main` once it has
landed) and the bench endpoints of 2002Bishwajeet/journal plan file `journal/02` (cargo feature
`encfs-bench`). The page must be the shell's frontend, so that it is served from the app's own
`http://localhost:47821`: a secure context on every platform, which a LAN dev URL on a phone is not.

1. In this repository: `npm ci && npm run bench:build`.
2. In the Journal checkout, desktop (macOS WKWebView, Windows WebView2, Linux WebKitGTK):

   ```sh
   npx tauri build --features encfs-bench --config '{"build":{"frontendDist":"<path to pglite-cipher>/bench/dist","beforeBuildCommand":""}}'
   ```

3. iOS and Android, the same configuration:

   ```sh
   npx tauri ios build --features encfs-bench --config '{"build":{"frontendDist":"<path to pglite-cipher>/bench/dist","beforeBuildCommand":""}}'
   npx tauri android build --features encfs-bench --config '{"build":{"frontendDist":"<path to pglite-cipher>/bench/dist","beforeBuildCommand":""}}'
   ```

4. Launch the app, tick every part (100 MB alone if the device is slow), **Run**, **Copy results**.
   Never ship a build with `encfs-bench`.

G7 assumes `bench_blob_get(index, len)` reads `len` bytes at offset `index * len`, and that
`bench_token()` returns the token for the `X-Journal-Bench` header. If the shell lacks the commands,
the G7 part reports `available: false` and the reason; that is itself a result (journal/02's STOP).
`ipc.oneMbPutGetMs` times a 1 MB put and get through the commands: Tauri's `fetch`-based IPC takes a
few milliseconds, the `postMessage` fallback an order of magnitude more (`ipcGuess` uses 50 ms).

## Where the results go

Paste each JSON object as a comment on issue #3 (the owner gate), one comment per device, with the
device name and OS version in the first line.
