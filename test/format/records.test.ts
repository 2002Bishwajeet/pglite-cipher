// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Sealed records: round trips, tamper detection, binding to place and type, and the digests.
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Bytes } from '../../src/format/bytes.ts';
import { BLOCK_SIZES, type BlockSize } from '../../src/format/codec.ts';
import { CorruptStoreError } from '../../src/format/errors.ts';
import { computeManifest, computeTableDigest } from '../../src/format/manifest.ts';
import {
  newBlockId,
  openBlock,
  openRoot,
  openTable,
  SEALED_OVERHEAD,
  sealBlock,
  sealRoot,
  sealTable,
  type RecordContext,
} from '../../src/format/records.ts';
import { flipBit, newStore, random, rejection, seeded } from './helpers.ts';
import { runs, timeout } from '../long.ts';

type Kind = 'root' | 'table' | 'block';

const stores = new Map<BlockSize, RecordContext>();
beforeAll(async () => {
  for (const blockSize of BLOCK_SIZES) stores.set(blockSize, (await newStore(blockSize, 7)).ctx);
});
const ctxFor = (blockSize: BlockSize) => stores.get(blockSize) as RecordContext;

const fileId = random(16);
const blockId = random(16);

const sealAs = (ctx: RecordContext, kind: Kind, body: Bytes) =>
  kind === 'root' ? sealRoot(ctx, body) : kind === 'table' ? sealTable(ctx, blockId, body) : sealBlock(ctx, fileId, 3, body);
const openAs = (ctx: RecordContext, kind: Kind, sealed: Bytes) =>
  kind === 'root'
    ? openRoot(ctx, sealed)
    : kind === 'table'
      ? openTable(ctx, blockId, sealed)
      : openBlock(ctx, blockId, fileId, 3, sealed);

const KINDS: Kind[] = ['root', 'table', 'block'];
const body = (blockSize: BlockSize) =>
  fc.record({ seed: fc.integer(), length: fc.integer({ min: 0, max: blockSize }) }).map(({ seed, length }) => seeded(seed, length));
const padded = (b: Bytes, blockSize: number) => {
  const out = new Uint8Array(blockSize);
  out.set(b);
  return out;
};

describe('sealed records', () => {
  for (const blockSize of BLOCK_SIZES) {
    it(`round-trip random bodies at ${String(blockSize)} bytes`, async () => {
      const ctx = ctxFor(blockSize);
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...KINDS), body(blockSize), async (kind, b) => {
          const sealed = await sealAs(ctx, kind, b);
          expect(sealed.length).toBe(SEALED_OVERHEAD + blockSize);
          expect(await openAs(ctx, kind, sealed)).toEqual(padded(b, blockSize));
        }),
        { numRuns: runs(60) },
      );
    }, timeout(120_000));
  }

  it('reject any single-bit flip in salt, nonce, ciphertext or tag', async () => {
    const ctx = ctxFor(8192);
    const sealed = new Map<Kind, Bytes>();
    for (const kind of KINDS) sealed.set(kind, await sealAs(ctx, kind, random(100)));
    const length = (SEALED_OVERHEAD + 8192) * 8;
    const edges = [0, 127, 128, 223, 224, length - 129, length - 128, length - 1];
    for (const kind of KINDS) {
      for (const bit of edges) await rejection(openAs(ctx, kind, flipBit(sealed.get(kind) as Bytes, bit)), CorruptStoreError);
    }
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...KINDS), fc.integer({ min: 0, max: length - 1 }), async (kind, bit) => {
        await rejection(openAs(ctx, kind, flipBit(sealed.get(kind) as Bytes, bit)), CorruptStoreError);
      }),
      { numRuns: runs(300) },
    );
  }, timeout(120_000));

  it('do not open a data block under another fileId, index, storeId or keyId', async () => {
    const ctx = ctxFor(8192);
    const plain = random(50);
    const sealed = await sealBlock(ctx, fileId, 3, plain);
    expect(await openBlock(ctx, blockId, fileId, 3, sealed)).toEqual(padded(plain, 8192));
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.record({ fileId: fc.uint8Array({ minLength: 16, maxLength: 16 }) }),
          fc.record({ index: fc.nat({ max: 0xffffffff }).filter((i) => i !== 3) }),
          fc.record({ storeId: fc.uint8Array({ minLength: 16, maxLength: 16 }) }),
          fc.record({ keyId: fc.nat({ max: 0xffffffff }).filter((k) => k !== 7) }),
        ),
        async (change) => {
          const other: RecordContext = {
            ...ctx,
            meta: {
              ...ctx.meta,
              ...('storeId' in change ? { storeId: new Uint8Array(change.storeId) } : {}),
              ...('keyId' in change ? { keyId: change.keyId } : {}),
            },
          };
          const id = 'fileId' in change ? new Uint8Array(change.fileId) : fileId;
          const index = 'index' in change ? change.index : 3;
          fc.pre(!('fileId' in change) || id.some((b, i) => b !== fileId[i]));
          fc.pre(!('storeId' in change) || other.meta.storeId.some((b, i) => b !== ctx.meta.storeId[i]));
          await rejection(openBlock(other, blockId, id, index, sealed), CorruptStoreError);
        },
      ),
      { numRuns: runs(200) },
    );
  });

  it('do not open a table block under another block id', async () => {
    const ctx = ctxFor(8192);
    const sealed = await sealTable(ctx, blockId, random(64));
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 16, maxLength: 16 }), async (other) => {
        fc.pre(other.some((b, i) => b !== blockId[i]));
        await rejection(openTable(ctx, new Uint8Array(other), sealed), CorruptStoreError);
      }),
      { numRuns: runs(200) },
    );
  });

  it('do not open as another record type', async () => {
    const ctx = ctxFor(8192);
    for (const from of KINDS) {
      const sealed = await sealAs(ctx, from, random(64));
      for (const to of KINDS) {
        if (to === from) expect((await openAs(ctx, to, sealed)).length).toBe(8192);
        else await rejection(openAs(ctx, to, sealed), CorruptStoreError);
      }
    }
  });

  it('do not open when swapped between two files, or between two indexes of one file', async () => {
    const ctx = ctxFor(8192);
    const fileA = random(16);
    const fileB = random(16);
    for (const [a, b] of [
      [
        { fileId: fileA, index: 3 },
        { fileId: fileB, index: 3 },
      ],
      [
        { fileId: fileA, index: 3 },
        { fileId: fileA, index: 4 },
      ],
    ] as const) {
      const idA = newBlockId();
      const idB = newBlockId();
      const store = new Map([
        [idA, await sealBlock(ctx, a.fileId, a.index, random(10))],
        [idB, await sealBlock(ctx, b.fileId, b.index, random(10))],
      ]);
      expect((await openBlock(ctx, idA, a.fileId, a.index, store.get(idA) as Bytes)).length).toBe(8192);
      const valueA = store.get(idA) as Bytes;
      store.set(idA, store.get(idB) as Bytes);
      store.set(idB, valueA);
      await rejection(openBlock(ctx, idA, a.fileId, a.index, store.get(idA) as Bytes), CorruptStoreError);
      await rejection(openBlock(ctx, idB, b.fileId, b.index, store.get(idB) as Bytes), CorruptStoreError);
    }
  });

  it('reject a value of the wrong length', async () => {
    const ctx = ctxFor(8192);
    const sealed = await sealRoot(ctx, random(10));
    await rejection(openRoot(ctx, sealed.subarray(0, sealed.length - 1)), CorruptStoreError);
    await rejection(openRoot(ctx, new Uint8Array(sealed.length + 1)), CorruptStoreError);
    await rejection(openRoot(ctxFor(32768), sealed), CorruptStoreError);
  });
});

const manifestFiles = fc.uniqueArray(
  fc.record({
    fileId: fc.uint8Array({ minLength: 16, maxLength: 16 }),
    tags: fc.array(fc.uint8Array({ minLength: 16, maxLength: 16 }), { maxLength: 8 }),
  }),
  { minLength: 1, maxLength: 6, selector: (f) => f.fileId.join(',') },
);
const flat = (tags: Uint8Array[]) => {
  const out = new Uint8Array(tags.length * 16);
  tags.forEach((t, i) => {
    out.set(t, i * 16);
  });
  return out;
};
const manifestOf = (files: { fileId: Uint8Array; tags: Uint8Array[] }[]) =>
  computeManifest(files.map((f) => ({ fileId: f.fileId, blockTags: flat(f.tags) })));
const hexOf = async (p: Promise<Bytes>) => Array.from(await p, (b) => b.toString(16).padStart(2, '0')).join('');

describe('digests', () => {
  it('manifest: does not depend on the order files are given in', async () => {
    await fc.assert(
      fc.asyncProperty(manifestFiles, async (files) => {
        expect(await hexOf(manifestOf([...files].reverse()))).toBe(await hexOf(manifestOf(files)));
      }),
    );
  });

  it('manifest: changes when a tag changes, a file or a block is removed, or two blocks of one file swap', async () => {
    await fc.assert(
      fc.asyncProperty(manifestFiles, fc.nat(), fc.nat(), fc.nat(), async (files, f, i, j) => {
        const base = await hexOf(manifestOf(files));
        const file = files[f % files.length];
        if (file === undefined) return;
        const others = files.filter((x) => x !== file);
        const changed: { fileId: Uint8Array; tags: Uint8Array[] }[][] = [others];
        if (file.tags.length > 0) {
          const at = i % file.tags.length;
          const tags = file.tags.map((t, k) => (k === at ? t.map((b, n) => (n === 0 ? b ^ 1 : b)) : t));
          changed.push([...others, { ...file, tags }]);
          changed.push([...others, { ...file, tags: file.tags.filter((_, k) => k !== at) }]);
          const bt = j % file.tags.length;
          const [x, y] = [file.tags[at], file.tags[bt]];
          if (x !== undefined && y !== undefined && x.some((b, n) => b !== y[n])) {
            const swapped = [...file.tags];
            swapped[at] = y;
            swapped[bt] = x;
            changed.push([...others, { ...file, tags: swapped }]);
          }
        }
        for (const c of changed) expect(await hexOf(manifestOf(c))).not.toBe(base);
      }),
    );
  });

  it('table digest: changes when a table-block tag changes or two table blocks swap places', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ minLength: 16, maxLength: 16 }), { minLength: 1, maxLength: 10 }),
        fc.nat(),
        fc.nat(),
        async (tags, i, j) => {
          const base = await hexOf(computeTableDigest(tags));
          const at = i % tags.length;
          const changed = tags.map((t, k) => (k === at ? t.map((b, n) => (n === 15 ? b ^ 0x80 : b)) : t));
          expect(await hexOf(computeTableDigest(changed))).not.toBe(base);
          const bt = j % tags.length;
          const [x, y] = [tags[at], tags[bt]];
          if (x !== undefined && y !== undefined && x.some((b, n) => b !== y[n])) {
            const swapped = [...tags];
            swapped[at] = y;
            swapped[bt] = x;
            expect(await hexOf(computeTableDigest(swapped))).not.toBe(base);
          }
        },
      ),
    );
  });
});
