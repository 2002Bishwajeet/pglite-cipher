// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// Incrementally packed file table: after random file operations it still describes MEMFS exactly and stays within twice its dense size;
// removals taking it under half full repack it once; a crash at the repack commit leaves the old table or the new.
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { StorageBackend } from '../../src/backend/backend.ts';
import { FaultyBackend } from '../../src/backend/faulty.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { EncryptedFs } from '../../src/encryptedFs.ts';
import { toHex, type Bytes } from '../../src/format/bytes.ts';
import { packEntries } from '../../src/format/table.ts';
import {
  expectStoreEquals,
  fsOf,
  inspect,
  listTree,
  newKey,
  openStore,
  PGDATA,
  records,
  restore,
  shared,
  type Opened,
  type TestFS,
} from './helpers.ts';

const B = 8192;
const FUZZ = `${PGDATA}/fuzz`;
const MANY = `${PGDATA}/many`;
const FILES = 4000;

/** xorshift32 from a seed, so every run does the same operations. */
function prng(seed: number) {
  let x = seed | 0 || 1;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    bytes: (n: number) => Uint8Array.from({ length: n }, () => Math.floor(next() * 256)),
  };
}

const entries = (FS: TestFS, dir: string) => [...listTree(FS, dir)].map(([p, s]) => ({ path: `${dir}/${p}`, ...s }));

/** The tree under PGDATA: modes and SHA-256 of contents or symlink targets (hex of the whole directory takes gigabytes of heap). */
async function treeOf(FS: TestFS): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [path, { mode }] of listTree(FS)) {
    const full = `${PGDATA}/${path}`;
    const body = FS.isDir(mode)
      ? 'dir'
      : FS.isLink(mode)
        ? FS.readlink(full)
        : toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', FS.readFile(full) as Bytes)));
    out.set(path, `${String(mode)}:${body}`);
  }
  return out;
}

class LoadSnapshotFs extends EncryptedFs {
  loaded: Map<string, string> | null = null;
  #moduleFs: TestFS | null = null;

  override async init(pg: PGlite, options: Parameters<EncryptedFs['init']>[1]) {
    const { emscriptenOpts } = await super.init(pg, options);
    const keep = (mod: { FS: unknown }) => {
      this.#moduleFs = mod.FS as TestFS;
    };
    return { emscriptenOpts: { ...emscriptenOpts, preRun: [...(emscriptenOpts.preRun ?? []), keep] } };
  }

  override async initialSyncFs(): Promise<void> {
    await super.initialSyncFs();
    this.loaded = await treeOf(this.#moduleFs as TestFS);
  }
}

function randomOp(FS: TestFS, rnd: ReturnType<typeof prng>, n: number): void {
  const all = entries(FS, FUZZ);
  const files = all.filter((e) => !FS.isDir(e.mode));
  const dirs = [FUZZ, ...all.filter((e) => FS.isDir(e.mode)).map((e) => e.path)];
  const pick = <T,>(list: T[]) => list[rnd.int(list.length)] as T;
  const op = files.length < 20 ? 0 : rnd.int(100);
  if (op < 30) {
    FS.writeFile(`${pick(dirs)}/f${String(n)}`, rnd.bytes(rnd.int(3 * B)));
  } else if (op < 50) {
    const f = pick(files);
    const stream = FS.open(f.path, 2 /* O_RDWR */);
    const more = rnd.bytes(1 + rnd.int(2 * B));
    FS.write(stream, more, 0, more.length, f.size);
    FS.close(stream);
  } else if (op < 63) {
    const f = pick(files);
    FS.truncate(f.path, rnd.int(f.size + 1));
  } else if (op < 80) {
    const f = pick(files);
    const target = rnd.int(4) === 0 ? pick(files).path : `${pick(dirs)}/r${String(n)}`;
    if (target !== f.path) FS.rename(f.path, target);
  } else if (op < 84) {
    const d = pick(dirs);
    if (d !== FUZZ) FS.rename(d, `${FUZZ}/m${String(n)}`);
  } else if (op < 86) {
    FS.mkdir(`${pick(dirs)}/d${String(n)}`);
  } else {
    FS.unlink(pick(files).path);
  }
}

async function createMany({ pg, fs }: Opened): Promise<void> {
  const FS = fsOf(pg);
  FS.mkdir(MANY);
  for (let i = 0; i < FILES; i++) FS.writeFile(`${MANY}/file-number-${String(i)}`, new Uint8Array(1 + (i % 100)));
  await fs.syncToFs(false);
}

/** Removes three files of every four so no table block empties; `sync` every hundred removals and at the end, false ends the run. */
async function removeMost({ pg }: Opened, sync: () => Promise<boolean>): Promise<void> {
  const FS = fsOf(pg);
  let removed = 0;
  for (let i = 0; i < FILES; i++) {
    if (i % 4 === 0) continue;
    FS.unlink(`${MANY}/file-number-${String(i)}`);
    if (++removed % 100 === 0 && !(await sync())) return;
  }
  await sync();
}

function counting(inner: StorageBackend): { backend: StorageBackend; commits: () => number } {
  let n = 0;
  const backend = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'commit') {
        return (...args: Parameters<StorageBackend['commit']>) => {
          n++;
          return target.commit(...args);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { backend, commits: () => n };
}

describe('file-table packing', () => {
  it('after 2,000 random file operations the table is MEMFS, a reopen is MEMFS, and the table stays small', async () => {
    const memory = new MemoryBackend();
    const key = await newKey();
    const { pg, fs } = await openStore({ backend: shared(memory), key, blockSize: B });
    const FS = fsOf(pg);
    FS.mkdirTree(FUZZ);
    const rnd = prng(20261112);
    for (let n = 1; n <= 2000; n++) {
      randomOp(FS, rnd, n);
      if (n % 20 === 0) await fs.syncToFs(false);
    }
    await fs.syncToFs(false);
    await expectStoreEquals(memory, key, FS);
    const { table } = await inspect(memory, key);
    expect(fs.stats().table.blocks).toBeLessThanOrEqual(2 * packEntries(table.files.values(), B).length + 4);

    const live = await treeOf(FS);
    const reopen = new LoadSnapshotFs({ backend: shared(await restore(await records(memory))), key, mode: 'open' });
    const pg2 = await PGlite.create({ fs: reopen });
    expect(reopen.loaded).toEqual(live);
    await pg2.close();
    await pg.close();
  }, 300_000);

  it('a run of removals that takes the table under half full repacks it exactly once', async () => {
    const memory = new MemoryBackend();
    const key = await newKey();
    const opened = await openStore({ backend: shared(memory), key, blockSize: B });
    await createMany(opened);
    const repacks: boolean[] = [];
    await removeMost(opened, async () => {
      await opened.fs.syncToFs(false);
      repacks.push(opened.fs.stats().lastSync?.repacked ?? false);
      return true;
    });
    expect(repacks.length).toBeGreaterThan(20);
    expect(repacks.filter(Boolean)).toHaveLength(1);
    expect(opened.fs.stats().table.fill).toBeGreaterThan(0.5);
    await expectStoreEquals(memory, key, fsOf(opened.pg));
    await opened.pg.close();
  }, 300_000);

  for (const mode of ['before', 'after', 'hang'] as const) {
    it(`a crash at the repack commit (${mode}) leaves the old table or the new one`, async () => {
      const key = await newKey();
      const clean = counting(new MemoryBackend());
      const a = await openStore({ backend: clean.backend, key, blockSize: B });
      await createMany(a);
      let repackCommit = 0;
      await removeMost(a, async () => {
        await a.fs.syncToFs(false);
        if (repackCommit === 0 && a.fs.stats().lastSync?.repacked === true) repackCommit = clean.commits();
        return true;
      });
      expect(repackCommit).toBeGreaterThan(0);
      await a.pg.close();

      const memory = new MemoryBackend();
      const faulted = counting(new FaultyBackend(shared(memory), { commit: { n: repackCommit, mode } }));
      const b = await openStore({ backend: faulted.backend, key, blockSize: B });
      await createMany(b);
      let oldIds: string[] = [];
      await removeMost(b, async () => {
        if (faulted.commits() < repackCommit - 1) {
          await b.fs.syncToFs(false);
          return true;
        }
        oldIds = (await inspect(memory, key)).root.tableIds.map(toHex);
        const attempt = b.fs.syncToFs(false).catch(() => undefined);
        if (mode === 'hang') await expect.poll(faulted.commits).toBe(repackCommit);
        else await attempt;
        return false;
      });
      expect(faulted.commits()).toBe(repackCommit);
      const store = await restore(await records(memory));
      if (mode !== 'hang') await b.pg.close();

      const ids = (await inspect(store, key)).root.tableIds.map(toHex);
      expect(oldIds.length).toBeGreaterThan(4);
      if (mode === 'after') expect(ids.filter((id) => oldIds.includes(id))).toEqual([]);
      else expect(ids).toEqual(oldIds);
      const reopened = await openStore({ backend: shared(store), key, mode: 'open' });
      const { table, dataBlocks } = reopened.fs.stats();
      expect(await store.count()).toBe(3 + table.blocks + dataBlocks);
      await reopened.fs.syncToFs(false);
      await expectStoreEquals(store, key, fsOf(reopened.pg));
      await reopened.pg.close();
    }, 300_000);
  }
});
