# pglite-cipher

SQLCipher-style encryption at rest for [PGlite](https://pglite.dev) (Postgres compiled to WASM).

**Status:** design. There is no code yet. The repo is private until there's a first release.

## What it is
- **A PGlite filesystem that encrypts below Postgres.** The database stays in MEMFS while it runs. Changed 8 KB blocks are tracked, encrypted with AES-256-GCM, and written in one atomic batch per sync. Each record is bound to its file and position.
- **Postgres is untouched.** Every file under PGDATA is encrypted, including catalogs, WAL, `pg_control` and the SLRUs. File names and sizes are hidden.
- **Two-tier keys.** The caller supplies a key-encryption key (for example a random key from the OS keychain). The package wraps its own data key, so changing the key is instant.
- **Pluggable storage.** IndexedDB first; a native (Tauri/Rust) backend is under evaluation.

Built first for [Journal](https://github.com/2002Bishwajeet/journal)'s native apps, where it's used as a git submodule, and meant to be usable by any PGlite app.

## Docs
- `docs/research/2026-11-10-spec-v1.md`: SQLCipher's design adapted to PGlite (v1)
- `docs/research/2026-11-10-review-fable-5.2.md`: independent review ("sound with fixes")
- `docs/research/2026-11-10-prior-art.md`: prior art (pglite-encrypted-fs, SQLCipher 5, Evolu, sqlite3mc, Signal, Element, …)
- `docs/plan/`: agent-ready issue plans (coming)

## Licence
To be decided before going public. MIT is the intent.
