// No byte in a store is recognisable: no fixed bit, no label, no path, one length per kind.
import { describe, expect, it } from 'vitest';
import { ascii, type Bytes } from '../../src/format/bytes.ts';
import { BLOCK_SIZES, encodeRoot, encodeTable, type RootBody, type TableEntry } from '../../src/format/codec.ts';
import { createHeader, HEADER_LENGTH } from '../../src/format/keys.ts';
import { computeManifest, computeTableDigest } from '../../src/format/manifest.ts';
import { newBlockId, SEALED_OVERHEAD, sealBlock, sealRoot, sealTable, tagOf } from '../../src/format/records.ts';
import { packEntries, type StoredFile } from '../../src/format/table.ts';
import { contextFor, newKek, newStore, random } from './helpers.ts';

const countBits = (counts: Int32Array, bytes: Uint8Array) => {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    const at = i * 8;
    for (let k = 0; k < 8; k++) counts[at + k] = (counts[at + k] ?? 0) + ((b >> k) & 1);
  }
};

/** Bit positions whose count of set bits falls outside [843, 1157] of 2,000. */
const outliers = (counts: Int32Array) => [...counts.entries()].filter(([, n]) => n < 843 || n > 1157);

const indexOf = (haystack: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

const someRoot = (tableIds: Bytes[]): RootBody => ({
  gen: 1,
  encryptions: 0,
  state: 'ready',
  origin: 'app',
  fileCount: 0,
  dataBlocks: 0,
  tableDigest: new Uint8Array(32),
  manifest: new Uint8Array(32),
  tableIds,
});

describe('no recognisable bytes', () => {
  it('has no fixed bit in 2,000 headers and 2,000 roots, table blocks and data blocks of identical plaintext', async () => {
    const N = 2000;
    const blockSize = 8192;
    const kek = await newKek();
    const { dek, meta } = await createHeader(kek, { blockSize, keyId: 1 });
    const fileId = random(16);
    const blockId = random(16);
    const rootBody = encodeRoot(someRoot([blockId]), blockSize);
    const entries: TableEntry[] = [
      { kind: 'file', fileId, type: 'file', mode: 0o100600, size: 100, path: 'base/1/1259', target: '' },
      { kind: 'run', fileId, first: 0, ids: [random(16)] },
    ];
    const tableBody = encodeTable(entries, blockSize);
    const blockBody = new Uint8Array(blockSize).fill(0x41);

    const length = (SEALED_OVERHEAD + blockSize) * 8;
    const headers = new Int32Array(HEADER_LENGTH * 8);
    const roots = new Int32Array(length);
    const tables = new Int32Array(length);
    const blocks = new Int32Array(length);
    for (let i = 0; i < N; i++) {
      const { header } = await createHeader(kek, { blockSize, keyId: 1 });
      countBits(headers, header);
      // A session's records share its salt (rule 4): a fresh session for each one.
      countBits(roots, await sealRoot(contextFor(dek, meta), rootBody));
      countBits(tables, await sealTable(contextFor(dek, meta), blockId, tableBody));
      countBits(blocks, await sealBlock(contextFor(dek, meta), fileId, 0, blockBody));
    }
    expect(outliers(headers)).toEqual([]);
    expect(outliers(roots)).toEqual([]);
    expect(outliers(tables)).toEqual([]);
    expect(outliers(blocks)).toEqual([]);
  }, 300_000);

  it('holds no label, cipher name, application name or path in any stored value of a small store', async () => {
    const blockSize = 8192;
    const { header, ctx } = await newStore(blockSize);
    const paths = ['global/pg_control', 'base/16384/2619', 'journal/notes-pglite', 'pg_wal/000000010000000000000001'];
    const files: StoredFile[] = paths.map((path, i) => ({
      fileId: random(16),
      path,
      type: 'file',
      mode: 0o100600,
      size: 1000 + i,
      target: '',
      ids: [newBlockId()],
    }));
    files.push({ fileId: random(16), path: 'pg_wal/summaries', type: 'directory', mode: 0o40700, size: 0, target: '', ids: [] });
    files.push({ fileId: random(16), path: 'pg_tblspc/link', type: 'symlink', mode: 0o120777, size: 0, target: 'base/pglite-cipher', ids: [] });
    const stored: Bytes[] = [header, header];
    const blockTags: { fileId: Bytes; blockTags: Bytes }[] = [];
    for (const f of files) {
      if (f.type !== 'file') continue;
      const sealed = await sealBlock(ctx, f.fileId, 0, ascii(`${f.path} pglite cipher journal`.padEnd(f.size, '.')));
      stored.push(sealed);
      blockTags.push({ fileId: f.fileId, blockTags: tagOf(sealed) });
    }
    const tableIds: Bytes[] = [];
    const tableTags: Bytes[] = [];
    for (const group of packEntries(files, blockSize)) {
      const id = newBlockId();
      const sealed = await sealTable(ctx, id, encodeTable(group, blockSize));
      tableIds.push(id);
      tableTags.push(tagOf(sealed));
      stored.push(sealed);
    }
    const root: RootBody = {
      ...someRoot(tableIds),
      origin: 'https://journal.example/pglite-cipher',
      fileCount: files.length,
      dataBlocks: paths.length,
      tableDigest: await computeTableDigest(tableTags),
      manifest: await computeManifest(blockTags),
    };
    stored.push(await sealRoot(ctx, encodeRoot(root, blockSize)));

    const needles = ['pglite', 'cipher', 'PGLCIPHR', 'AES-256-GCM', 'HKDF-SHA256', 'journal', ...paths, 'base/pglite-cipher'];
    const found = stored.flatMap((value, i) =>
      needles.filter((n) => indexOf(value, ascii(n)) >= 0).map((n) => `${n} in value ${String(i)}`),
    );
    expect(found).toEqual([]);
  });

  it('writes 168-byte headers and one sealed length per store, at every block size', async () => {
    for (const blockSize of BLOCK_SIZES) {
      const { header, ctx } = await newStore(blockSize);
      expect(header.length).toBe(HEADER_LENGTH);
      const id = newBlockId();
      const lengths = new Set(
        [
          await sealRoot(ctx, new Uint8Array(0)),
          await sealRoot(ctx, encodeRoot(someRoot([id]), blockSize)),
          await sealTable(ctx, id, new Uint8Array(3)),
          await sealTable(ctx, id, encodeTable([], blockSize)),
          await sealBlock(ctx, random(16), 0, new Uint8Array(1)),
          await sealBlock(ctx, random(16), 5, random(blockSize)),
        ].map((v) => v.length),
      );
      expect([...lengths]).toEqual([SEALED_OVERHEAD + blockSize]);
    }
  });
});
