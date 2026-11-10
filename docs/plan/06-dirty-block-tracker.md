<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-06).
Title: Dirty-block tracker over MEMFS, with a model-based property test
Labels: agent-ready, security
Origin: 2002Bishwajeet/journal#553 ("write only the chunks that changed"). Resolves review finding B3 and the tracker parts of S7.
-->
## Context
The encrypted filesystem keeps Postgres' data directory in Emscripten's in-memory filesystem (MEMFS) and, at each sync, writes only the blocks that changed. This issue is the part that knows which blocks changed.

It is the most dangerous part of the package. The store is strict: at open, a block that should exist and does not is corruption. So one missed write is a database that will not open. The review of the first design (finding B3) found four ways the simple "mark blocks on `write`" approach loses data in this PGlite build:

- `posix_fallocate` arrives as a size change (`node_ops.setattr` with `size`) and no write. There is no `stream_ops.allocate` in this build.
- A write past the end of a file leaves a zero-filled hole between the old end and the write. Postgres does this.
- `msync` calls `MEMFS.stream_ops.write` directly, so a wrapper around `write` never sees it.
- A file truncated and extended again between two syncs keeps stale blocks in the store unless the low point is remembered.

The tracker works in files and block indexes, and stays that way. Format v1 (#<PC-05>) stores every block under a random id and keeps the files in an encrypted table, but turning `(fileId, index)` into a block id, and a delete range into a list of ids, is the job of the filesystem (#<PC-08>), which holds the file map. Nothing here knows a block id. "Inode" below means a node's metadata as the tracker reports it; in the store it becomes a file-table entry. The format stores no modification time, so the filesystem ignores an inode whose only change is its `mtime`; the tracker still reports it, and still uses `mtime` for its own safety net.

`spike/RESULTS.md` lists the operations Postgres really makes; read it first. The spike's `traceFs.ts` shows how to wrap the operations from a `preRun` hook.

## Change
New code in `src/tracker/`, tests in `test/tracker/`. No crypto and no IndexedDB here.

1. **`installTracker(FS, MEMFS, root: string): Tracker`**, called from a `preRun` hook. It wraps, for nodes under `root` (PGDATA) only:
   - `MEMFS.stream_ops.write`: after the original runs, mark blocks `floor(pos / B) … floor((pos + len - 1) / B)` dirty, **and** if `pos` was beyond the old size, every block from `floor(oldSize / B)`.
   - `MEMFS.stream_ops.msync`: its own wrapper, marking the range it writes back. Do not rely on the `write` wrapper.
   - `MEMFS.node_ops.setattr`: when `attr.size` is set and differs, mark every block from `floor(min(oldSize, newSize) / B)` to the new last block, and lower the node's `minSizeSinceSync`. Mode and timestamp changes mark the inode dirty.
   - `mknod` / `mkdir` / `symlink`: give the new node a random 16-byte `fileId`, mark its inode dirty.
   - `rename`: mark the moved node's inode dirty (the path is in the inode; **no block is rewritten**). If the rename replaces an existing node, that node becomes dead.
   - `unlink` / `rmdir`: the node becomes dead.
   - Any other `stream_ops` or `node_ops` key the spike found to change contents.
   `B` is the block size, passed in.
2. **Per live node the tracker keeps:** `fileId`, `persistedBlocks` (how many blocks the store holds for it after the last successful sync), `minSizeSinceSync`, a dirty-block set (a sorted range list or a bitmap, not a `Set` of numbers for a 1 GB file), `inodeDirty`, and a shadow of `(size, mtime)` as of the last snapshot.
3. **Dead nodes:** a node that was unlinked or replaced goes to a `deadFiles` list with its `fileId` and `persistedBlocks`, so the sync can remove its file-table entries and every one of its blocks. Writes to a dead node that Postgres still holds open are ignored. A node created and removed between two syncs produces nothing.
4. **`snapshot(): Snapshot`**, fully synchronous. Returns:
   - `blocks`: for each dirty block still inside the file, a **copy** of its bytes padded with zeros to `B` (copy, because the engine may write again while the sync is encrypting);
   - `inodes`: for each node with dirty blocks or a dirty inode, `{ fileId, path, type, mode, size, mtime, blocks, target }`;
   - `deleteRanges`: for each live node whose block count shrank below `persistedBlocks`, `[fileId, newBlocks, persistedBlocks)`; for each dead node, its `fileId` (in a `deadFiles` list) and `[fileId, 0, persistedBlocks)`. These are ranges of block **indexes**; the store has no ranges, and #<PC-08> turns them into block ids;
   then clears the dirty state. After a truncate-then-extend, every block from the low-water mark up is in `blocks`.
5. **`commit(snapshot)`** sets `persistedBlocks` and the shadows after the sync succeeded. **`requeue(snapshot)`** merges a failed snapshot back: block ranges become dirty again unless the node is now dead; delete ranges are kept; nodes that died meanwhile keep only their deletes (review S7).
6. **Safety net.** At the start of `snapshot()`, walk the nodes under `root` (about 1,000) and compare each one's `usedBytes` and `mtime` with the shadow. A node that differs and has no dirty block and no dirty inode is a tracking gap: mark the whole file dirty, increment `tracker.stats.trackingGaps`, and `console.warn` once per sync with the path's depth only (never the path or contents). The tests assert the counter stays 0; in production it turns a silent data loss into a slower sync.
7. **`loadState(files)`**: after the store has been read at open, set `persistedBlocks` and shadows for every node, with nothing dirty. **`markAllDirty()`**: for first population and import.

### Tests (`test/tracker/*.test.ts`)
Get a real Emscripten `FS`/`MEMFS` from a PGlite instance on `MemoryFS` (`pg.Module.FS`), in a scratch directory outside PGDATA, so the tests exercise the real MEMFS semantics and not a mock.

- **Model-based property test (fast-check, at least 2,000 runs of up to 60 operations):** operations are `create`, `write(fd, pos, len)` with positions before, at and past EOF and lengths that cross block boundaries, `truncate(len)` both ways, `fallocate`, `mmap + msync` if the spike saw `msync`, `rename` (including onto an existing file), `unlink` (including while a descriptor is open, followed by writes to it), `mkdir`, `rmdir`, `symlink`, and `sync`. A trivially correct **model store** (`Map<fileId, { inode, blocks: Map<index, bytes> }>`) applies each `snapshot()` (puts, then delete ranges). At every `sync` and at the end, reconstructing every file from the model store equals the MEMFS file byte for byte, the model holds no block at or beyond a file's block count, no record of a dead file remains, and `trackingGaps` is 0.
- **Failure property:** with a random subset of syncs "failing" (call `requeue` instead of `commit`), the same invariants hold after the next successful sync.
- **Named regressions**, one test each: hole write; fallocate growth with no write; truncate then re-extend between syncs; `msync` after `mmap`; rename over an existing file removes all of the old file's blocks; write to an unlinked-but-open file produces nothing; a 16 MB file renamed (WAL recycling) produces one inode and zero blocks; a file created and deleted between syncs produces nothing.
- **Safety net:** change a file by calling the *original* unwrapped `MEMFS.stream_ops.write` (kept aside by the test) → the next snapshot contains the whole file and `trackingGaps` is 1.
- **Real engine:** run the spike workload (`spike/workload.ts`) on a PGlite whose filesystem has the tracker installed and the model store attached; after every query batch, the model equals MEMFS; `trackingGaps` is 0.
- **Snapshot isolation:** mutate a file after `snapshot()` returned; the snapshot's bytes do not change.

## Verification
- `~/.claude/bin/heavy npx vitest run src/tracker` passes: the property tests, the failure property, every named regression, the safety net, the real-engine run.
- `~/.claude/bin/heavy npm run test:browser -- test/tracker` passes in Chromium, Firefox and WebKit (the property tests may run with a tenth of the Node budget there).
- `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0.
- The PR lists every MEMFS operation wrapped and, for each operation the spike traced, where it is handled.

## STOP and comment on the issue if
- The spike's trace lists a content-changing operation that this issue does not name and you cannot hook.
- The real-engine test ever reports `trackingGaps > 0`. Do not raise a threshold or skip the assertion: report the path class (WAL, relation, SLRU, other) and the operation.
- Tracking needs a change inside `node_modules/@electric-sql/pglite`.
- The property test finds a counterexample you cannot explain within the semantics above. Paste the shrunk sequence.

## Metadata
Depends on: #<PC-05>
Size: M
Area: db, security
Model: opus
Effort: xhigh
