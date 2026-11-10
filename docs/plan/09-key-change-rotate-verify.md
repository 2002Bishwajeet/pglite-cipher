<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-09).
Title: changeKey, crash-safe rotateDataKey, and verify()
Labels: agent-ready, security
Origin: 2002Bishwajeet/journal#553 ("`changeKey` re-encrypts, and the old key no longer opens the database"). Resolves the rekey parts of review S5 and the spec's Q2. Follows the opaque header and the packed block space of format v1 (plan file 05).
-->
## Context
`EncryptedFs` (#<PC-08>) opens and syncs an encrypted PGlite data directory. Its keys have two tiers (format v1, `FORMAT.md`): the caller's key (KEK, for example from the OS keychain) wraps a random data key (DEK) stored in the header.

SQLCipher has one operation, `PRAGMA rekey`, which re-encrypts every page in one transaction. Two tiers give two operations with different costs and different guarantees, and the difference must be clear in the API and the README:

- **`changeKey`**: wrap the same DEK under a new KEK. One small write, instant. Afterwards the old KEK does not open the store. But someone who copied the old header **and** has the old KEK can still unwrap the DEK and read any later copy of the store.
- **`rotateDataKey`**: new DEK, every record re-encrypted. Slow (about one open plus one full write). This is the one that defeats a copied header. It keeps the current KEK, so after a suspected exposure the caller does both: `changeKey`, then `rotateDataKey`.

There is no rotation forced by a nonce budget: session subkeys (#<PC-05>, as SQLCipher 5 does per page write) keep every AES-GCM key far below the NIST SP 800-38D limit for the life of the DEK. Rotation is for one reason only: the old key or an old header may have been exposed.

## Change
In `src/`, tests in `test/keys/`:

1. **`fs.changeKey(newKek)`**: only on an open, idle filesystem (wait for a running sync, and settle an unsettled one, #<PC-08>). `rewrapHeader` (#<PC-05>) makes a new 168-byte header: the same DEK wrapped under the new key, and the same meta sealed again, because the meta is bound to the bytes of its wrap. Then one strict commit that puts it in both header slots, guarded by `expectRoot`. **Both copies change in one transaction, so there is never one copy for the old key and one for the new.** The root and the blocks are not touched: `keyId` identifies the DEK, and the DEK did not change. If the commit rejects, read slot 0 to learn which header the store holds, as #<PC-08> does for the root.
2. **`fs.rotateDataKey({ backendFactory, onProgress })`**: re-encrypt into a **fresh** store, then swap (review S5: not one giant transaction, and never in place).
   1. Flush: a strict `syncToFs(false)` to the old store, then hold back further syncs. Queries keep running against MEMFS; the tracker keeps collecting what they dirty.
   2. Mark the old store: commit its root with `state: "rotating"` and `origin: <new store name>` (the name is inside the encrypted root; nothing readable links the two stores).
   3. Create the new store in the empty slot of a pair (or through `backendFactory()` for a single backend): new `storeId`, new DEK with `keyId + 1`, wrapped under the same KEK, and **a new file map with a fresh random id for every block**: no id of the old store is carried over, so the two stores cannot be matched block for block. Write both header copies first, then every data block read from **MEMFS** (not by decrypting the old store), in commits of at most 512 records. No root yet, so the store reads as incomplete. This copy is *fuzzy*: queries may change blocks while it runs.
   4. Catch up: `snap = tracker.snapshot()` (synchronous; it holds every block, inode and delete since step 1). Apply `snap` to the new store through the new file map: changed blocks are put again under their new ids, new indexes get ids, cut indexes and dead files have their ids deleted. The data blocks of the new store now equal MEMFS at the instant of the snapshot, exactly: every block is either unchanged since step 1 or rewritten from the snapshot. This is why the fuzzy copy is safe. **Then write the file table, once**, packed densely from the map as of the snapshot (`packEntries`). Until now no table block existed, so none had to be rewritten during the catch-up.
   5. Read the new store back and check it against the in-memory file map and tag table (the `verify()` of step 3 below, without a root): the table blocks by `getMany`, then every block in pages; every listed id is there with the expected tag, and `count()` is `2 + table blocks + data blocks`, so there is no record nobody owns.
   6. Commit the new store's root with `state: "ready"`, both digests, the list of table block ids and `expectRoot: null`, strict. **This commit is the switch.** `encryptions` starts at the number made so far under the new DEK.
   7. Point the filesystem at the new backend, DEK, file map and tag table; `tracker.commit(snap)`; release syncs.
   8. Delete the old store (`clear()`, and for IndexedDB delete the database).
   - **Failure before step 6:** `tracker.requeue(snap)`, delete the new store, set the old store back to `"ready"`, release syncs, rethrow. Nothing is lost: MEMFS is intact and the old store is valid.
   - **Resume after a crash:** `initialSyncFs` meeting `state: "rotating"` (from #<PC-08>'s table) follows `origin`. If the new store has a root with `state: "ready"` and it verifies, use it and delete the old store. Otherwise delete the new store, set the old store back to `"ready"` and open it.
   - **Durability note for the README:** writes made while a rotation runs become durable when it completes. A crash during rotation returns to the state of step 1.
   - Peak memory: the database plus one batch plus the catch-up snapshot plus a second file map.
   - A rotation also leaves the file table densely packed, which #<PC-08> otherwise does only when the table falls under half full.
   - **Two slots, so the next launch finds the right store with no outside state.** Add `IndexedDbBackend.pair(name)`, returning the two databases `<name>.a` and `<name>.b` (the caller's name and one letter, nothing else; #<PC-07> explains why the package adds no name of its own), and let `EncryptedFs` take `backend: [a, b]`. At open: an empty slot is ignored; one non-empty slot is the store; two non-empty slots are a rotation in progress and the resume rule above decides. Rotation writes into the empty slot, so `backendFactory` is not needed with a pair. A single backend, as in #<PC-08>, keeps working.
3. **`fs.verify({ onProgress })`** and a standalone **`verifyStore(backend, kek)`**: open both header copies and the root; fetch the table blocks the root lists, open each and compare `tableDigest`; assemble the file map; read every block in pages and open each with the file and index the map gives for its id (GCM check); recompute the manifest and compare it with the root's; compare `count()` with what the root and the map account for. Returns `{ ok, files, blocks, problems: Array<{ key, reason }> }`, where `key` is a slot number or a block id and `reason` one of a fixed list (`header-copy`, `root`, `table-block`, `table-digest`, `data-block`, `missing`, `unlisted`, `manifest`); never a path. It never throws for a damaged record. If the file table itself does not verify, the data blocks cannot be attributed, and `verify` says so instead of guessing. This is the equivalent of SQLCipher's `PRAGMA cipher_integrity_check`; it runs without Postgres.
4. **README:** a "Keys" section with the two operations, the caveat for `changeKey` in one plain sentence, why no rotation is ever forced (session subkeys), and when to rotate (suspected exposure of the key or of an old copy of the header).

### Tests
- `changeKey`: the new key opens, the old gives `WrongKeyError`, data intact; a crash before the commit (`FaultyBackend` mode a) leaves the old key working; a commit that applied but reported failure (mode b) leaves the new key working and the instance usable after reopen.
- `changeKey` documented limit: a copy of the old header records plus the old KEK still opens a later copy of the store (a test named so it reads as documentation).
- `rotateDataKey`: data intact after rotation and reopen; `keyId` increased; `encryptions` restarted at about the record count; no record of the new store decrypts under the old DEK; **no block id of the old store exists in the new one**; the new store's table uses exactly the number of blocks `packEntries` gives; the old database is gone.
- **Rotation crash matrix (`FaultyBackend` on both stores):** kill at every commit of steps 2, 3, 4, 6 and 8, then reopen. Every case opens to a consistent database: the state of step 1 when the kill is before step 6's commit, the state of the catch-up snapshot (including rows written during the rotation) when it is after. No orphan database remains after the reopen completes.
- **Fuzzy copy is repaired:** a test that updates rows between every batch of step 3; after rotation and reopen, every table equals the live instance's.
- Writes during rotation: queries run while step 3 is in flight; after the switch and one more sync, a reopen has all of them.
- `verify`: clean store → `ok`; each tamper case from #<PC-08> → the damaged key and a reason in `problems`, no exception; no `problems` entry and no progress event contains a path.
- `changeKey` replaces both copies or neither: at every `FaultyBackend` outcome, slots 0 and 1 are byte-identical; the old header's meta beside the new header's wrap does not open (the splice test of #<PC-05>, on a real store).
- Memory: rotation never holds more than one batch of ciphertext.

## Verification
- `~/.claude/bin/heavy npm test` passes, including the rotation crash matrix for every commit index.
- `~/.claude/bin/heavy npm run test:browser -- test/keys` passes in Chromium, Firefox and WebKit (the crash matrix may sample every tenth commit there).
- `~/.claude/bin/heavy npm run build` and `~/.claude/bin/heavy npm run lint` exit 0.
- The README "Keys" section exists and states the `changeKey` caveat.

## STOP and comment on the issue if
- A crash point in the rotation matrix leaves two stores that both claim to be current, or none.
- The fuzzy-copy test fails: a block changed during step 3 is not in the catch-up snapshot. That is a tracker gap; report it on #<PC-06> and stop.
- You are about to add rotation "in place" or in one transaction to make a test simpler.

## Metadata
Depends on: #<PC-08>
Size: M
Area: db, security
Model: opus
Effort: xhigh
Review: fable
