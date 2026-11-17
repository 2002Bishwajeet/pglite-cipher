// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// The frozen format v1 reference store (test/fixtures/v1-reference): every later version must open it with the published test key.
import { describe, expect, it } from 'vitest';
import { importKek } from '../../src/format/keys.ts';
import { inBrowser, openStore, restore, shared } from './helpers.ts';
import { decodeRecords } from './recordFile.ts';

/** The published test key: the bytes 0x00, 0x01, …, 0x1f. */
const TEST_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

async function fixture(): Promise<Uint8Array> {
  const url = new URL('../fixtures/v1-reference/records.bin', import.meta.url);
  if (inBrowser) return new Uint8Array(await (await fetch(url)).arrayBuffer());
  const name = 'node:fs/promises';
  const { readFile } = (await import(/* @vite-ignore */ name)) as typeof import('node:fs/promises');
  return new Uint8Array(await readFile(url));
}

describe('the v1 reference store', () => {
  it('opens with the published test key and holds its known row', async () => {
    const recs = decodeRecords(await fixture());
    const { pg, fs } = await openStore({ backend: shared(await restore(recs)), key: await importKek(TEST_KEY.slice()), mode: 'open' });
    expect((await pg.query('SELECT id, note FROM reference')).rows).toEqual([{ id: 1, note: 'written by pglite-cipher format v1' }]);
    expect(fs.stats().gen).toBeGreaterThan(0);
    await pg.close();
  }, 120_000);
});
