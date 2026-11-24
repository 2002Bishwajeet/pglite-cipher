// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Writes test/fixtures/v1-reference/records.bin, the frozen format v1 store. Run once by hand; later versions must open it.
// Key and known row: that folder's README.
import { writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { RecordKey, StorageBackend } from '../src/backend/backend.ts';
import { MemoryBackend } from '../src/backend/memory.ts';
import { EncryptedFs } from '../src/encryptedFs.ts';
import { importKek } from '../src/format/keys.ts';
import { encodeRecords } from '../test/fs/recordFile.ts';

const TEST_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

const memory = new MemoryBackend();
// Closing the filesystem leaves the records readable.
const backend: StorageBackend = {
  get: (slot) => memory.get(slot),
  getMany: (ids) => memory.getMany(ids),
  readRange: (after, limit) => memory.readRange(after, limit),
  isEmpty: () => memory.isEmpty(),
  count: () => memory.count(),
  commit: (batch) => memory.commit(batch),
  clear: () => memory.clear(),
  close: () => Promise.resolve(),
};
// Smallest block size and no template databases keep the file small.
const fs = new EncryptedFs({ backend, key: await importKek(TEST_KEY), mode: 'create', blockSize: 8192 });
const pg = await PGlite.create({ fs });
for (const sql of [
  `UPDATE pg_database SET datistemplate = false WHERE datname IN ('template0', 'template1')`,
  'DROP DATABASE template0',
  'DROP DATABASE template1',
  'CREATE TABLE reference (id int PRIMARY KEY, note text NOT NULL)',
  `INSERT INTO reference VALUES (1, 'written by pglite-cipher format v1')`,
]) {
  await pg.exec(sql);
}
await pg.close();

const records = new Map<RecordKey, Uint8Array>();
for (const slot of [0, 1, 2] as const) {
  const value = await memory.get(slot);
  if (value) records.set(slot, value);
}
for (const [id, value] of await memory.readRange(null, 1_000_000)) records.set(id, value);
await writeFile(new URL('../test/fixtures/v1-reference/records.bin', import.meta.url), encodeRecords(records));
console.log(`${String(records.size)} records`);
