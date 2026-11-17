// verify(): checks a store record by record without Postgres (like `PRAGMA cipher_integrity_check`); names findings by
// slot or block id, never path, and never throws for a damaged record.
import type { BlockId, Slot, StorageBackend } from './backend/backend.ts';
import { concat, equalBytes, toHex, type Bytes } from './format/bytes.ts';
import { decodeRoot, decodeTable, type RootBody, type TableEntry } from './format/codec.ts';
import { CorruptStoreError } from './format/errors.ts';
import { openHeader, SubkeyCache } from './format/keys.ts';
import { computeManifest, computeTableDigest } from './format/manifest.ts';
import { openBlock, openRoot, openTable, tagOf, type RecordContext } from './format/records.ts';
import { assembleFiles, type FileTable } from './format/table.ts';
import { fromHex } from './fs/fileMap.ts';
import { PAGE, pool } from './fs/pool.ts';

export type VerifyReason =
  | 'header-copy'
  | 'root'
  | 'table-block'
  | 'table-digest'
  | 'data-block'
  | 'missing'
  | 'unlisted'
  | 'manifest';

export interface VerifyProblem {
  key: Slot | BlockId;
  reason: VerifyReason;
}

export interface VerifyResult {
  ok: boolean;
  /** Files in the file table; 0 when it does not verify (same for `dataBlocks`). */
  files: number;
  blocks: number;
  problems: VerifyProblem[];
}

export interface VerifyProgress {
  phase: 'table' | 'blocks';
  done: number;
  total: number;
}

export interface VerifyOptions {
  onProgress?: (progress: VerifyProgress) => void;
}

async function opens(open: () => Promise<void>): Promise<boolean> {
  try {
    await open();
    return true;
  } catch (error) {
    if (error instanceof CorruptStoreError) return false;
    throw error;
  }
}

/** Opens both header copies and the root with `kek`, then checks the table and every block. Throws only non-damage:
 * WrongKeyError, UnsupportedFormatError, a failing backend. */
export async function verifyStore(backend: StorageBackend, kek: CryptoKey, { onProgress }: VerifyOptions = {}): Promise<VerifyResult> {
  const [copy0, copy1, sealedRoot] = (await Promise.all([backend.get(0), backend.get(1), backend.get(2)])) as Array<Bytes | undefined>;
  const problems: VerifyProblem[] = [];
  const failed = (): VerifyResult => ({ ok: false, files: 0, blocks: 0, problems });
  let opened;
  try {
    opened = await openHeader(kek, copy0, copy1);
  } catch (error) {
    if (!(error instanceof CorruptStoreError)) throw error;
    problems.push({ key: 0, reason: 'header-copy' }, { key: 1, reason: 'header-copy' });
    return failed();
  }
  if (opened.headerRepairNeeded) problems.push({ key: opened.header === copy0 ? 1 : 0, reason: 'header-copy' });
  const ctx: RecordContext = { subkeys: new SubkeyCache(opened.dek), meta: opened.meta, encryptions: 0 };
  let root: RootBody | null = null;
  try {
    if (sealedRoot !== undefined) root = decodeRoot(await openRoot(ctx, sealedRoot));
  } catch (error) {
    if (!(error instanceof CorruptStoreError)) throw error;
  }
  if (root === null) {
    problems.push({ key: 2, reason: 'root' });
    return failed();
  }
  const slots = [copy0, copy1, sealedRoot].filter((v) => v !== undefined).length;
  const checked = await checkBlocks(backend, ctx, root, slots, onProgress);
  return { ...checked, ok: problems.length === 0 && checked.ok, problems: [...problems, ...checked.problems] };
}

// Checks the table and blocks `root` describes: digests, each block against the table's file and index, and the record
// count. A table that does not verify stops the check: its blocks cannot be attributed.
export async function checkBlocks(
  backend: StorageBackend,
  ctx: RecordContext,
  root: RootBody,
  slots: number,
  onProgress?: (progress: VerifyProgress) => void,
): Promise<VerifyResult> {
  const problems: VerifyProblem[] = [];
  const { blockSize } = ctx.meta;

  const tableIds = root.tableIds.map(toHex);
  const tags: Bytes[] = [];
  const entries: TableEntry[] = [];
  for (let at = 0; at < tableIds.length; at += PAGE) {
    const ids = tableIds.slice(at, at + PAGE);
    const values = await backend.getMany(ids);
    const page = ids.map((id, i) => ({ id, sealed: values[i] as Bytes | undefined, entries: null as TableEntry[] | null }));
    await pool(page, async (b) => {
      const { sealed } = b;
      if (sealed === undefined) return;
      await opens(async () => {
        b.entries = decodeTable(await openTable(ctx, fromHex(b.id), sealed));
      });
    });
    for (const b of page) {
      if (b.sealed === undefined) problems.push({ key: b.id, reason: 'missing' });
      else if (b.entries === null) problems.push({ key: b.id, reason: 'table-block' });
      else {
        tags.push(tagOf(b.sealed).slice());
        entries.push(...b.entries);
      }
    }
    onProgress?.({ phase: 'table', done: at + ids.length, total: tableIds.length });
  }
  let table: FileTable | null = null;
  if (problems.length === 0) {
    if (!equalBytes(await computeTableDigest(tags), root.tableDigest)) problems.push({ key: 2, reason: 'table-digest' });
    else {
      try {
        table = assembleFiles(entries, root, blockSize);
      } catch (error) {
        if (!(error instanceof CorruptStoreError)) throw error;
        // Every block opened and the digest matches, yet the entries contradict each other or the root.
        problems.push({ key: 2, reason: 'table-block' });
      }
    }
  }
  if (table === null) return { ok: false, files: 0, blocks: 0, problems };
  const { files, blocks } = table;

  const tableSet = new Set(tableIds);
  const blockTags = new Map<string, Array<Bytes | undefined>>();
  for (const key of files.keys()) blockTags.set(key, []);
  const seen = new Set<string>();
  const total = tableIds.length + root.dataBlocks;
  let done = 0;
  let damaged = false;
  for (let after: string | null = null; ; ) {
    const page = await backend.readRange(after, PAGE);
    if (page.length === 0) break;
    const found = page.map(([id, sealed]) => ({ id, sealed: sealed as Bytes, problem: null as VerifyProblem | null }));
    await pool(found, async (b) => {
      if (tableSet.has(b.id)) return;
      const place = blocks.get(b.id);
      if (!place) {
        b.problem = { key: b.id, reason: 'unlisted' };
        return;
      }
      seen.add(b.id);
      const ok = await opens(async () => {
        await openBlock(ctx, fromHex(b.id), place.fileId, place.index, b.sealed);
      });
      if (ok) (blockTags.get(toHex(place.fileId)) as Array<Bytes | undefined>)[place.index] = tagOf(b.sealed).slice();
      else b.problem = { key: b.id, reason: 'data-block' };
    });
    for (const b of found) {
      if (b.problem === null) continue;
      problems.push(b.problem);
      if (b.problem.reason === 'data-block') damaged = true;
    }
    done += page.length;
    onProgress?.({ phase: 'blocks', done, total });
    after = (page[page.length - 1] as [string, Uint8Array])[0];
    if (page.length < PAGE) break;
  }
  for (const id of blocks.keys()) {
    if (seen.has(id)) continue;
    problems.push({ key: id, reason: 'missing' });
    damaged = true;
  }
  // A missing or damaged block already says what the manifest would.
  if (!damaged) {
    const regular = [...files.values()].filter((f) => f.type === 'file');
    const manifest = await computeManifest(
      regular.map((f) => ({ fileId: f.fileId, blockTags: concat((blockTags.get(toHex(f.fileId)) ?? []) as Bytes[]) })),
    );
    if (!equalBytes(manifest, root.manifest)) problems.push({ key: 2, reason: 'manifest' });
  }
  // Every record is a slot or a block that the pages showed: nothing the range missed.
  if ((await backend.count()) !== slots + done) problems.push({ key: 2, reason: 'unlisted' });
  return { ok: problems.length === 0, files: files.size, blocks: blocks.size, problems };
}
