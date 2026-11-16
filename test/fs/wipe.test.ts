// Best-effort memory hygiene (#91): closing a store overwrites the MEMFS file contents and the wasm
// memory with zeros, so the plaintext of the database does not linger in RAM after close.
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { EncryptedFs } from '../../src/encryptedFs.ts';
import { fsOf, newKey, PGDATA, shared, template } from './helpers.ts';

const MARKER = 'wipe-marker-6f1c9a3e-plaintext';
const markerBytes = new TextEncoder().encode(MARKER);

interface ModuleView {
  HEAPU8: Uint8Array;
  FS: { lookupPath(path: string): { node: { contents?: unknown } } };
}

/** The content buffers of every regular file under `dir`, by reference. */
function buffersUnder(mod: ModuleView, dir: string, out: Uint8Array[] = []): Uint8Array[] {
  const fs = fsOf({ Module: mod } as never);
  for (const name of fs.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = `${dir}/${name}`;
    const { mode } = fs.lstat(path);
    if (fs.isDir(mode)) buffersUnder(mod, path, out);
    else if (!fs.isLink(mode)) {
      const contents = mod.FS.lookupPath(path).node.contents;
      if (contents instanceof Uint8Array) out.push(contents);
    }
  }
  return out;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0] as number;
  outer: for (let i = haystack.indexOf(first); i !== -1 && i <= haystack.length - needle.length; i = haystack.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Keeps the buffers as they are when PGlite hands over to closeFs: its shutdown wrote the last of them. */
class SpyFs extends EncryptedFs {
  files: Uint8Array[] = [];
  heap: Uint8Array = new Uint8Array(0);
  override async closeFs(): Promise<void> {
    const mod = (this as unknown as { pg: PGlite }).pg.Module as unknown as ModuleView;
    this.files = buffersUnder(mod, PGDATA);
    this.heap = mod.HEAPU8;
    this.before = this.files.some((b) => contains(b, markerBytes));
    await super.closeFs();
  }
  before = false;
}

describe('wipe on close', () => {
  it('zeroes the MEMFS file buffers and the wasm memory, marker included', async () => {
    const fs = new SpyFs({ backend: shared(new MemoryBackend()), key: await newKey(), mode: 'open-or-create' });
    const pg = await PGlite.create({ fs, loadDataDir: await template() });
    await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text)');
    await pg.query('INSERT INTO t VALUES (1, $1)', [MARKER]);
    await pg.close();
    const { files, heap } = fs;
    expect(fs.before).toBe(true); // control: the marker was in memory when close began
    expect(files.length).toBeGreaterThan(0);
    for (const b of files) expect(b.every((x) => x === 0)).toBe(true);
    expect(contains(heap, markerBytes)).toBe(false);
    // PGlite exits the runtime right after closeFs, which may write a few bytes of its own.
    expect(heap.reduce((n, x) => n + (x ? 1 : 0), 0)).toBeLessThan(64);
  }, 120_000);
});
