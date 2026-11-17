// The compatibility lock across engines (the CI compat jobs): one engine writes a store with
// CIPHER_COMPAT_WRITE=1 to test-results/compat/<engine>.bin, and every other engine opens it with
// CIPHER_COMPAT_READ=<engine>,… (WebKit's in Chromium and Node, Chromium's in WebKit and Node).
// Two engines that each read only their own stores is the failure this catches. Without either
// variable nothing runs: test/fs/reference.test.ts opens the frozen v1 store on every engine.
import { describe, expect, inject, it } from 'vitest';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { importKek } from '../../src/format/keys.ts';
import { inBrowser, openStore, records, restore, shared } from './helpers.ts';
import { decodeRecords, encodeRecords } from './recordFile.ts';

/** The published test key of the v1 reference store: the bytes 0x00, 0x01, …, 0x1f. */
const TEST_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const NOTE = 'written by pglite-cipher for another engine';

const WRITE = inject('compatWrite');
const READ = inject('compatRead');

async function engine(): Promise<string> {
  if (!inBrowser) return 'node';
  const { server } = await import('vitest/browser');
  return server.browser;
}

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function writeFixture(name: string, bytes: Uint8Array): Promise<void> {
  if (inBrowser) {
    const { commands } = await import('vitest/browser');
    // Relative to the project root.
    await commands.writeFile(`test-results/compat/${name}.bin`, toBase64(bytes), 'base64');
    return;
  }
  const fs = 'node:fs/promises';
  const { mkdir, writeFile } = (await import(/* @vite-ignore */ fs)) as typeof import('node:fs/promises');
  const url = new URL('../../test-results/compat/', import.meta.url);
  await mkdir(url, { recursive: true });
  await writeFile(new URL(`${name}.bin`, url), bytes);
}

async function readFixture(name: string): Promise<Uint8Array> {
  const url = new URL(`../../test-results/compat/${name}.bin`, import.meta.url);
  if (inBrowser) {
    const response = await fetch(url);
    expect(response.ok, `test-results/compat/${name}.bin`).toBe(true);
    return new Uint8Array(await response.arrayBuffer());
  }
  const fs = 'node:fs/promises';
  const { readFile } = (await import(/* @vite-ignore */ fs)) as typeof import('node:fs/promises');
  return new Uint8Array(await readFile(url));
}

describe.runIf(WRITE)('compatibility lock: write', () => {
  it('writes a store for the other engines to open', async () => {
    const name = await engine();
    const memory = new MemoryBackend();
    const { pg } = await openStore({ backend: shared(memory), key: await importKek(TEST_KEY.slice()), mode: 'create', blockSize: 8192 });
    await pg.exec('CREATE TABLE compat (engine text PRIMARY KEY, note text NOT NULL)');
    await pg.query('INSERT INTO compat VALUES ($1, $2)', [name, NOTE]);
    await pg.close();
    await writeFixture(name, encodeRecords(await records(memory)));
  }, 120_000);
});

describe.runIf(READ.length > 0)('compatibility lock: read', () => {
  for (const writer of READ) {
    it(`opens the store ${writer} wrote, and verifies it`, async () => {
      const recs = decodeRecords(await readFixture(writer));
      const { pg, fs } = await openStore({ backend: shared(await restore(recs)), key: await importKek(TEST_KEY.slice()), mode: 'open' });
      expect((await pg.query('SELECT engine, note FROM compat')).rows).toEqual([{ engine: writer, note: NOTE }]);
      const verified = await fs.verify();
      expect(verified.problems).toEqual([]);
      expect(verified.ok).toBe(true);
      await pg.close();
    }, 120_000);
  }
});
