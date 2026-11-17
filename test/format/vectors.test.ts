/// <reference types="vite/client" />
// The committed vectors are the regression lock: every engine rebuilds them byte for byte.
import { describe, expect, it } from 'vitest';
import { decodeRoot, decodeTable } from '../../src/format/codec.ts';
import { importKek, openHeader } from '../../src/format/keys.ts';
import { computeManifest, computeTableDigest } from '../../src/format/manifest.ts';
import { openBlock, openRoot, openTable, tagOf } from '../../src/format/records.ts';
import { contextFor, fromHex, hex } from './helpers.ts';
import raw from './vectors.json?raw';
import { buildVectors, type Vectors } from './vectors.ts';

const vectors = JSON.parse(raw) as Vectors;

describe('known-answer vectors', () => {
  it('are rebuilt byte for byte from the fixed inputs', async () => {
    expect(await buildVectors()).toEqual(vectors);
  });

  it('open with the package: header, root, table block, data block, digests', async () => {
    const kek = await importKek(fromHex(vectors.kek));
    const header = fromHex(vectors.header);
    const { dek, meta, headerRepairNeeded } = await openHeader(kek, header, header.slice());
    expect(headerRepairNeeded).toBe(false);
    expect({ ...meta, storeId: hex(meta.storeId) }).toEqual({
      blockSize: vectors.blockSize,
      keyId: vectors.keyId,
      storeId: vectors.storeId,
    });
    const ctx = contextFor(dek, meta);

    const rootSealed = fromHex(vectors.root.sealed);
    const root = decodeRoot(await openRoot(ctx, rootSealed));
    // toEqual ignores undefined fields: the root body holds neither the stored bytes nor the nonce.
    expect({
      ...root,
      tableDigest: hex(root.tableDigest),
      manifest: hex(root.manifest),
      tableIds: root.tableIds.map(hex),
    }).toEqual({ ...vectors.root, sealed: undefined, nonce: undefined });

    const tableSealed = fromHex(vectors.table.sealed);
    const entries = decodeTable(await openTable(ctx, fromHex(vectors.table.blockId), tableSealed));
    expect(
      entries.map((e) =>
        e.kind === 'file' ? { ...e, fileId: hex(e.fileId) } : { ...e, fileId: hex(e.fileId), ids: e.ids.map(hex) },
      ),
    ).toEqual(vectors.table.entries);

    const blockSealed = fromHex(vectors.block.sealed);
    const data = await openBlock(
      ctx,
      fromHex(vectors.block.blockId),
      fromHex(vectors.block.fileId),
      vectors.block.index,
      blockSealed,
    );
    const expected = new Uint8Array(vectors.blockSize);
    expected.set(fromHex(vectors.block.data));
    expect(data).toEqual(expected);

    expect(hex(await computeTableDigest([tagOf(tableSealed)]))).toBe(vectors.root.tableDigest);
    expect(
      hex(await computeManifest([{ fileId: fromHex(vectors.block.fileId), blockTags: tagOf(blockSealed) }])),
    ).toBe(vectors.root.manifest);
  });
});
