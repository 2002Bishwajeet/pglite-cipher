// No plaintext, path or key in a stored value or in an error message.
import { describe, expect, it } from 'vitest';
import { ascii, type Bytes } from '../../src/format/bytes.ts';
import { decodeRoot, decodeTable, encodeRoot, encodeTable, type FileEntry } from '../../src/format/codec.ts';
import { createHeader, importKek, openHeader, rewrapHeader } from '../../src/format/keys.ts';
import { newBlockId, openBlock, openRoot, openTable, sealBlock, sealRoot, sealTable } from '../../src/format/records.ts';
import { assembleFiles } from '../../src/format/table.ts';
import { contextFor, flipBit, hex, newKek, random } from './helpers.ts';

const PLAIN_MARKER = 'MARKER-PLAINTEXT-7f3a1c';
const PATH_MARKER = 'MARKER-PATH-9c1e5d';

const contains = (haystack: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

describe('no plaintext and no secrets', () => {
  it('in sealed values or in the errors of tampering', async () => {
    const rawKek = random(32);
    const kekHex = hex(rawKek);
    const kek = await importKek(rawKek.slice());
    const blockSize = 8192;
    const { dek, meta, header } = await createHeader(kek, { blockSize, keyId: 1 });
    const ctx = contextFor(dek, meta);
    const fileId = random(16);
    const blockId = newBlockId();
    const tableId = newBlockId();
    const file: FileEntry = { kind: 'file', fileId, type: 'file', mode: 0o100600, size: 100, path: PATH_MARKER, target: '' };
    const run = { kind: 'run' as const, fileId, first: 0, ids: [blockId] };

    const block = await sealBlock(ctx, fileId, 0, ascii(PLAIN_MARKER.repeat(4)));
    const table = await sealTable(ctx, tableId, encodeTable([file, run], blockSize));
    const rootBody = encodeRoot(
      {
        gen: 1,
        encryptions: 3,
        state: 'ready',
        origin: '',
        fileCount: 1,
        dataBlocks: 1,
        tableDigest: random(32),
        manifest: random(32),
        tableIds: [tableId],
      },
      blockSize,
    );
    const root = await sealRoot(ctx, rootBody);

    const markers = [PLAIN_MARKER, PATH_MARKER].map(ascii);
    for (const value of [header, block, table, root]) {
      for (const m of markers) expect(contains(value, m)).toBe(false);
    }

    const errors: unknown[] = [];
    const collect = async (p: Promise<unknown>) => {
      await p.then(
        () => {
          throw new Error('expected a rejection');
        },
        (e: unknown) => errors.push(e),
      );
    };
    const collectSync = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        errors.push(e);
        return;
      }
      throw new Error('expected a throw');
    };

    for (const bit of [0, 200, 300, 8 * 1000, 8 * (8192 + 44) - 1]) {
      await collect(openBlock(ctx, blockId, fileId, 0, flipBit(block, bit)));
      await collect(openTable(ctx, tableId, flipBit(table, bit)));
      await collect(openRoot(ctx, flipBit(root, bit)));
    }
    await collect(openBlock(ctx, blockId, fileId, 1, block));
    await collect(openBlock(ctx, blockId, random(16), 0, block));
    await collect(openTable(ctx, blockId, table));
    await collect(openRoot(ctx, block));
    await collect(openBlock(ctx, blockId, fileId, 0, block.subarray(1)));
    await collect(openHeader(await newKek(), header, header.slice()));
    await collect(openHeader(kek, flipBit(header, 900), flipBit(header, 900)));
    await collect(openHeader(kek, flipBit(header, 900), flipBit(header, 10)));
    await collect(rewrapHeader(await newKek(), kek, header));

    const body = await openTable(ctx, tableId, table);
    const trailing: Bytes = body.slice();
    trailing[blockSize - 1] = 1;
    collectSync(() => decodeTable(trailing));
    const badUtf8 = body.slice();
    badUtf8[2 + 34] = 0xff;
    collectSync(() => decodeTable(badUtf8));
    collectSync(() => decodeRoot(flipBit(rootBody, 8 * 17)));
    const twin: FileEntry = { ...file, fileId: random(16) };
    const r = { fileCount: 2, dataBlocks: 1, tableIds: [tableId] };
    collectSync(() => assembleFiles([file, twin, run], r, blockSize));
    collectSync(() => assembleFiles([file, run], { ...r, fileCount: 2 }, blockSize));
    collectSync(() => assembleFiles([run], { ...r, fileCount: 0 }, blockSize));

    expect(errors.length).toBeGreaterThan(25);
    const forbidden = [PLAIN_MARKER, PATH_MARKER, hex(ascii(PLAIN_MARKER)), hex(ascii(PATH_MARKER)), kekHex];
    for (const e of errors) {
      expect(e).toBeInstanceOf(Error);
      const text = `${(e as Error).name} ${(e as Error).message}`;
      for (const f of forbidden) expect(text).not.toContain(f);
    }
  });
});
