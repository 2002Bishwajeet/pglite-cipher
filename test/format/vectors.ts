// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Known-answer vectors from fixed inputs; vectors.json is the committed output and regression lock. Never regenerate it to pass a test.
// Written once: node -e "import('./test/format/vectors.ts').then(async (m) => console.log(JSON.stringify(await m.buildVectors(), null, 2)))" > test/format/vectors.json
import { setRandomSource } from '../../src/testing.ts';
import { toHex, type Bytes } from '../../src/format/bytes.ts';
import { encodeRoot, encodeTable, type RootBody, type TableEntry } from '../../src/format/codec.ts';
import { createHeader, importKek, SubkeyCache } from '../../src/format/keys.ts';
import { computeManifest, computeTableDigest } from '../../src/format/manifest.ts';
import { sealBlock, sealRoot, sealTable, tagOf } from '../../src/format/records.ts';

const run = (n: number, start: number): Bytes => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const fill = (n: number, byte: number): Bytes => new Uint8Array(n).fill(byte);

export const INPUTS = {
  kek: run(32, 0x10),
  dek: run(32, 0x40),
  storeId: run(16, 0x80),
  wrapNonce: run(12, 0x90),
  metaSalt: run(16, 0xa0),
  metaNonce: run(12, 0xb0),
  sessionSalt: run(16, 0xc0),
  tableNonce: run(12, 0xd0),
  blockNonce: run(12, 0xdc),
  rootNonce: run(12, 0xe8),
  fileId: fill(16, 0x11),
  dirId: fill(16, 0x22),
  dataBlockId: fill(16, 0x33),
  tableBlockId: fill(16, 0x44),
  data: Uint8Array.from({ length: 5000 }, (_, i) => (i * 7 + 3) & 0xff),
  blockSize: 8192,
  keyId: 7,
} as const;

export const buildVectors = async () => {
  const v = INPUTS;
  // Draw order: createHeader (storeId, DEK, wrapNonce, metaSalt, metaNonce), session salt at first seal, one nonce per seal.
  const queue = [v.storeId, v.dek, v.wrapNonce, v.metaSalt, v.metaNonce, v.sessionSalt, v.tableNonce, v.blockNonce, v.rootNonce];
  setRandomSource((n) => {
    const next = queue.shift();
    if (next?.length !== n) throw new Error('the code drew randomness in an unexpected order');
    return next.slice();
  });
  try {
    const kek = await importKek(v.kek.slice());
    const { dek, meta, header } = await createHeader(kek, { blockSize: v.blockSize, keyId: v.keyId });
    const ctx = { subkeys: new SubkeyCache(dek), meta, encryptions: 0 };
    const entries: TableEntry[] = [
      { kind: 'file', fileId: v.fileId, type: 'file', mode: 0o100600, size: v.data.length, path: 'base/1/1259', target: '' },
      { kind: 'file', fileId: v.dirId, type: 'directory', mode: 0o40700, size: 0, path: 'base/1', target: '' },
      { kind: 'run', fileId: v.fileId, first: 0, ids: [v.dataBlockId] },
    ];
    const table = await sealTable(ctx, v.tableBlockId, encodeTable(entries, v.blockSize));
    const block = await sealBlock(ctx, v.fileId, 0, v.data);
    const root: RootBody = {
      gen: 1,
      encryptions: 3,
      state: 'ready',
      origin: 'vectors',
      fileCount: 2,
      dataBlocks: 1,
      tableDigest: await computeTableDigest([tagOf(table)]),
      manifest: await computeManifest([{ fileId: v.fileId, blockTags: tagOf(block) }]),
      tableIds: [v.tableBlockId],
    };
    const rootSealed = await sealRoot(ctx, encodeRoot(root, v.blockSize));
    if (queue.length > 0) throw new Error('the code drew less randomness than expected');
    return {
      kek: toHex(v.kek),
      dek: toHex(v.dek),
      blockSize: v.blockSize,
      keyId: v.keyId,
      storeId: toHex(v.storeId),
      wrapNonce: toHex(v.wrapNonce),
      metaSalt: toHex(v.metaSalt),
      metaNonce: toHex(v.metaNonce),
      sessionSalt: toHex(v.sessionSalt),
      header: toHex(header),
      table: {
        blockId: toHex(v.tableBlockId),
        nonce: toHex(v.tableNonce),
        entries: entries.map((e) =>
          e.kind === 'file'
            ? { ...e, fileId: toHex(e.fileId) }
            : { ...e, fileId: toHex(e.fileId), ids: e.ids.map((id) => toHex(id)) },
        ),
        sealed: toHex(table),
      },
      block: {
        blockId: toHex(v.dataBlockId),
        fileId: toHex(v.fileId),
        index: 0,
        nonce: toHex(v.blockNonce),
        data: toHex(v.data),
        sealed: toHex(block),
      },
      root: {
        nonce: toHex(v.rootNonce),
        gen: root.gen,
        encryptions: root.encryptions,
        state: root.state,
        origin: root.origin,
        fileCount: root.fileCount,
        dataBlocks: root.dataBlocks,
        tableDigest: toHex(root.tableDigest),
        manifest: toHex(root.manifest),
        tableIds: root.tableIds.map((id) => toHex(id)),
        sealed: toHex(rootSealed),
      },
    };
  } finally {
    setRandomSource(null);
  }
};

export type Vectors = Awaited<ReturnType<typeof buildVectors>>;
