<!--
FILING: NEW issue in 2002Bishwajeet/journal (placeholder J-02).
Title: Native: benchmark-only Rust endpoints for the encryption spike (gate G7), behind a cargo feature
Labels: agent-ready, security
Cross-repository: serves the benchmark page of 2002Bishwajeet/pglite-cipher (plan file 03-spike-prototype-benchmarks.md). Neither waits for the other: the page skips its G7 rows when these endpoints are missing.
-->
## Context
Epic #555. Before the encrypted database is built, the owner decides where the encrypted store lives: in the webview's IndexedDB, or on the Rust side of the Tauri shell (a file of ciphertext, or a SQLCipher database, as Signal and Notesnook desktop do). The second is only possible if database blocks can cross from the database worker to Rust fast enough: about 100 MB at open, a few blocks at each sync. Nobody has measured that for this shell, which serves the app from `http://localhost:47821` (a remote origin for Tauri's IPC).

Two paths exist. Tauri's `invoke` is not available in Web Workers, so a command call hops worker → page → Rust. The shell's own loopback HTTP server can be called by `fetch` straight from the worker; `src-tauri/src/lib.rs` already says that any endpoint added there "must require a per-launch secret: every local process can reach this port".

This issue adds both paths **for measurement only**. They are compiled only with a cargo feature and must never be in a release build.

## Change
In `src-tauri/`, all behind `#[cfg(feature = "encfs-bench")]` (new feature in `Cargo.toml`, off by default, not implied by `custom-protocol`):

1. **Commands** `bench_blob_put(request: tauri::ipc::Request) -> Result<(), String>` and `bench_blob_get(index: u32, len: u32) -> tauri::ipc::Response`: raw bytes in and out (no JSON arrays). `put` appends the body to `bench.bin` under the app's data directory; `get` reads a slice. `bench_reset()` deletes the file. Register them in the app manifest and in a capability file `capabilities/encfs-bench.json` (remote URL `http://localhost:47821`, window `main`) that `build.rs` includes only with the feature.
2. **Loopback endpoint** in `serve()`: `PUT /__bench/blob` and `GET /__bench/blob?index=&len=`, accepted only with the header `X-Journal-Bench: <token>`, where the token is 32 random bytes (hex) made at launch and handed to the page by a command `bench_token()`. Wrong or missing token: `403`, nothing read or written. Same file as above.
3. A startup line on stderr when the feature is on: "encfs-bench endpoints are ENABLED: not a release build".
4. `src-tauri/README.md`: a "Benchmark build" section with the build command the pglite-cipher run sheet uses (`npx tauri build --features encfs-bench --config '{"build":{"frontendDist":"…/pglite-cipher/bench/dist","beforeBuildCommand":""}}'`) and the sentence "never ship a build with this feature".
5. A guard: the release workflow (when #305 adds one) must not enable the feature. Add a unit test that parses `Cargo.toml` and fails if `encfs-bench` appears in `default` or is implied by another feature.

## Verification
- `~/.claude/bin/heavy cargo test --manifest-path src-tauri/Cargo.toml --features encfs-bench` passes new tests: put then get returns the same bytes for 8 KB and 64 KB blocks; the HTTP endpoint rejects a missing and a wrong token with 403 and accepts the right one; `bench_reset` removes the file. Tests use a temporary directory and a random free port, never 47821.
- `~/.claude/bin/heavy cargo check --manifest-path src-tauri/Cargo.toml --features custom-protocol` is clean, and the built binary without the feature contains neither the string `__bench` nor `bench_blob` (check with `strings` on a debug build and paste the command and its empty output).
- `~/.claude/bin/heavy cargo test --manifest-path src-tauri/Cargo.toml` (no feature) passes, including the `Cargo.toml` guard test.
- `~/.claude/bin/heavy npm run build` exits 0.

## STOP and comment on the issue if
- Raw-byte command arguments (`tauri::ipc::Request` with a raw body) do not work from the `http://localhost:47821` origin in Tauri 2.12. Report what the page receives; that itself is a G7 result.
- The capability for the bench commands cannot be made conditional on the feature.

## Metadata
Depends on: #101
Size: S
Area: native, security
Model: opus
Effort: medium
