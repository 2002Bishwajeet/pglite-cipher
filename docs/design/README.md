# Design

How pglite-cipher works, and why it is built this way. Read these pages in order the first time.
The code in `src/` is the final word; these pages cite the files they describe.

| Page | What it covers |
|---|---|
| [Architecture and data flow](architecture.md) | Where the cipher sits under PGlite, MEMFS while running, dirty-block tracking, open, sync as one atomic batch, close |
| [On-disk format v1](format.md) | The records, the sealed-record shape, AAD and what it binds, the file table, the digests, what stays hidden |
| [Keys](keys.md) | The caller's KEK, the wrapped data key, session subkeys, `changeKey`, `rotateDataKey`, `verify()` |
| [Storage backends](backends.md) | The `StorageBackend` interface, IndexedDB, the in-memory and fault-injecting backends, the conformance suite |
| [Crash safety and tamper detection](integrity.md) | Why a crash leaves a consistent store, how a failed commit is settled, what `CorruptStoreError` covers |
| [Threat model, summarised](threat-model.md) | What an attacker with the stored files learns and cannot do; the full text is `SECURITY.md` |
| [Performance and known limits](performance.md) | Where the time goes, the block size, the open-time cost on slow platforms |
| [Compared to other options](comparison.md) | Other encrypted databases for the browser: what each encrypts, where the key lives, how much plaintext is in memory |

Other documents in the repository:

- `FORMAT.md`: the byte-exact specification of format v1. [format.md](format.md) explains it; `FORMAT.md` defines it.
- `SECURITY.md`: the threat model, the primitives, and how to report a vulnerability.
- `README.md`: usage, open modes, errors and what an app should do about each.
- `bench/README.md`: the benchmark page and the performance gates.

## The design in one paragraph

PGlite keeps Postgres's data directory in memory (Emscripten MEMFS) while the database runs.
pglite-cipher is a PGlite filesystem that sits under Postgres. It loads the directory into memory
at open, records which blocks (64 KB by default) of which files change, and at each sync seals those blocks with
AES-256-GCM (WebCrypto) and writes them, with an encrypted file table and a new root, in one
atomic storage transaction. The store holds only two copies of a 168-byte opaque header, one root
and equal-size sealed blocks under random ids. Each block is bound to its file and position, and
two digests in the root cover every record, so a changed, moved, deleted, added or replayed record
fails the next open. Postgres itself is not modified.
