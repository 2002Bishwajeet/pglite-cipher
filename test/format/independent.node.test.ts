// An independent reader of the known-answer vectors, written from FORMAT.md with node:crypto only.
// It imports nothing from src/: two implementations that agree only with themselves fail here.
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Vectors {
  kek: string;
  dek: string;
  blockSize: number;
  keyId: number;
  storeId: string;
  header: string;
  table: { blockId: string; entries: unknown[]; sealed: string };
  block: { blockId: string; fileId: string; index: number; data: string; sealed: string };
  root: {
    gen: number;
    encryptions: number;
    state: string;
    origin: string;
    fileCount: number;
    dataBlocks: number;
    tableDigest: string;
    manifest: string;
    tableIds: string[];
    sealed: string;
  };
}

const v = JSON.parse(readFileSync(new URL('vectors.json', import.meta.url), 'utf8')) as Vectors;
const hex = (s: string) => Buffer.from(s, 'hex');
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** AES-256-GCM open of `ciphertext ‖ tag16`. */
const gcmOpen = (key: Buffer, nonce: Buffer, aad: Buffer, sealed: Buffer) => {
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
};

const hkdf = (dek: Buffer, salt: Buffer, info: string) => Buffer.from(hkdfSync('sha256', dek, salt, info, 32));

/** A sealed record: `salt16 ‖ nonce12 ‖ ciphertext ‖ tag16` under the HKDF record subkey. */
const openRecord = (dek: Buffer, stored: Buffer, aad: Buffer) =>
  gcmOpen(hkdf(dek, stored.subarray(0, 16), 'pglite-cipher/v1/record'), stored.subarray(16, 28), aad, stored.subarray(28));

const allZero = (b: Buffer) => b.every((x) => x === 0);

describe('independent decoder (node:crypto, from FORMAT.md)', () => {
  it('reads header → DEK → meta → root → table block → data block', () => {
    const header = hex(v.header);
    expect(header.length).toBe(168);

    // Header: the wrap, then the meta under the header key.
    const dek = gcmOpen(hex(v.kek), header.subarray(0, 12), Buffer.from('pglite-cipher/wrap'), header.subarray(12, 60));
    expect(dek.toString('hex')).toBe(v.dek);
    const headerKey = hkdf(dek, header.subarray(60, 76), 'pglite-cipher/header');
    const meta = gcmOpen(
      headerKey,
      header.subarray(76, 88),
      Buffer.concat([Buffer.from('pglite-cipher/header'), header.subarray(0, 60)]),
      header.subarray(88, 168),
    );
    expect(meta.length).toBe(64);
    expect(meta.readUInt16BE(0)).toBe(1);
    expect([meta[2], meta[3], meta[4]]).toEqual([1, 0, 1]);
    expect(allZero(meta.subarray(5, 8))).toBe(true);
    const blockSize = meta.readUInt32BE(8);
    const keyId = meta.readUInt32BE(12);
    const storeId = meta.subarray(16, 32);
    expect(allZero(meta.subarray(32, 64))).toBe(true);
    expect(blockSize).toBe(v.blockSize);
    expect(keyId).toBe(v.keyId);
    expect(storeId.toString('hex')).toBe(v.storeId);

    // Root.
    const rootStored = hex(v.root.sealed);
    expect(rootStored.length).toBe(44 + blockSize);
    const root = openRecord(dek, rootStored, Buffer.concat([Buffer.from('r'), storeId, u32(keyId)]));
    expect(root.length).toBe(blockSize);
    expect(Number(root.readBigUInt64BE(0))).toBe(v.root.gen);
    expect(Number(root.readBigUInt64BE(8))).toBe(v.root.encryptions);
    expect(root[16]).toBe(1); // ready
    expect(root[17]).toBe(0);
    const originLen = root.readUInt16BE(18);
    expect(root.readUInt32BE(20)).toBe(v.root.fileCount);
    expect(root.readUInt32BE(24)).toBe(v.root.dataBlocks);
    const tableDigest = root.subarray(28, 60);
    const manifest = root.subarray(60, 92);
    const tableCount = root.readUInt32BE(92);
    const tableIds = Array.from({ length: tableCount }, (_, i) => root.subarray(96 + 16 * i, 112 + 16 * i));
    const originAt = 96 + 16 * tableCount;
    expect(root.subarray(originAt, originAt + originLen).toString('utf8')).toBe(v.root.origin);
    expect(allZero(root.subarray(originAt + originLen))).toBe(true);
    expect(tableIds.map((id) => id.toString('hex'))).toEqual(v.root.tableIds);
    expect(tableDigest.toString('hex')).toBe(v.root.tableDigest);
    expect(manifest.toString('hex')).toBe(v.root.manifest);

    // Table block: its AAD names its own id.
    const tableId = tableIds[0] ?? Buffer.alloc(0);
    expect(tableId.toString('hex')).toBe(v.table.blockId);
    const tableStored = hex(v.table.sealed);
    expect(tableStored.length).toBe(44 + blockSize);
    const table = openRecord(dek, tableStored, Buffer.concat([Buffer.from('t'), storeId, u32(keyId), tableId]));
    const types = ['file', 'directory', 'symlink'];
    const entries: unknown[] = [];
    let at = 2;
    for (let i = 0; i < table.readUInt16BE(0); i++) {
      const kind = table[at];
      const fileId = table.subarray(at + 1, at + 17).toString('hex');
      if (kind === 1) {
        const pathLen = table.readUInt16BE(at + 30);
        const path = table.subarray(at + 32, at + 32 + pathLen).toString('utf8');
        const targetLen = table.readUInt16BE(at + 32 + pathLen);
        const target = table.subarray(at + 34 + pathLen, at + 34 + pathLen + targetLen).toString('utf8');
        entries.push({
          kind: 'file',
          fileId,
          type: types[(table[at + 17] ?? 0) - 1],
          mode: table.readUInt32BE(at + 18),
          size: Number(table.readBigUInt64BE(at + 22)),
          path,
          target,
        });
        at += 34 + pathLen + targetLen;
      } else {
        expect(kind).toBe(2);
        const first = table.readUInt32BE(at + 17);
        const n = table.readUInt16BE(at + 21);
        const ids = Array.from({ length: n }, (_, j) => table.subarray(at + 23 + 16 * j, at + 39 + 16 * j).toString('hex'));
        entries.push({ kind: 'run', fileId, first, ids });
        at += 23 + 16 * n;
      }
    }
    expect(allZero(table.subarray(at))).toBe(true);
    expect(entries).toEqual(v.table.entries);

    // Data block: opened with the file and index the table gives for its id.
    const file = entries.find((e) => (e as { kind: string; type?: string }).type === 'file') as { fileId: string; size: number };
    const run = entries.find((e) => (e as { kind: string }).kind === 'run') as { fileId: string; first: number; ids: string[] };
    expect(run.fileId).toBe(file.fileId);
    expect(run.ids[0]).toBe(v.block.blockId);
    const blockStored = hex(v.block.sealed);
    expect(blockStored.length).toBe(44 + blockSize);
    const block = openRecord(
      dek,
      blockStored,
      Buffer.concat([Buffer.from('b'), storeId, u32(keyId), hex(file.fileId), u32(run.first)]),
    );
    expect(block.subarray(0, file.size).toString('hex')).toBe(v.block.data);
    expect(allZero(block.subarray(file.size))).toBe(true);

    // Digests over the tags (the last 16 bytes of each stored value).
    const tag = (stored: Buffer) => stored.subarray(stored.length - 16);
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect(sha(tag(tableStored))).toBe(tableDigest.toString('hex'));
    expect(sha(Buffer.concat([hex(file.fileId), u32(1), tag(blockStored)]))).toBe(manifest.toString('hex'));
  });
});
