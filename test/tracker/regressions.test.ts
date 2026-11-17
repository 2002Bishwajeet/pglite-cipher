// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// Named regressions: "mark blocks on write" losing data, the safety net, and snapshot isolation.
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installTracker, type MemNode, type Snapshot, type Tracker } from '../../src/tracker/tracker.ts';
import {
  MAP_SHARED,
  ModelStore,
  O_RDWR_CREAT,
  PROT_RW,
  bytesFrom,
  checkModel,
  hex,
  rmTree,
  saveOps,
  startPGlite,
  type Stream,
  type TestFS,
  memfsOf,
  type TestModule,
} from './harness.ts';

let pg: PGlite;
let mod: TestModule;
let fs: TestFS;
let count = 0;
let cleanup: (() => void) | undefined;

beforeAll(async () => {
  ({ pg, mod } = await startPGlite());
  fs = mod.FS;
}, 120_000);

afterAll(async () => {
  await pg.close();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

interface Original {
  write: (s: Stream, buf: Uint8Array, off: number, len: number, pos: number) => number;
  mknod: (parent: MemNode, name: string, mode: number, dev: number) => MemNode;
  unlink: (parent: MemNode, name: string) => void;
}

interface Env {
  root: string;
  tracker: Tracker;
  model: ModelStore;
  original: Original;
  sync(): Snapshot;
  write(path: string, pos: number, data: Uint8Array): void;
  id(path: string): string;
}

function setup(B: number): Env {
  const root = `/tmp/reg-${String(++count)}`;
  fs.mkdir(root);
  const memfs = memfsOf(mod);
  const restore = saveOps(memfs);
  const original = {
    write: memfs.stream_ops.write as Original['write'],
    mknod: memfs.node_ops.mknod as Original['mknod'],
    unlink: memfs.node_ops.unlink as Original['unlink'],
  };
  const tracker = installTracker(fs, memfs, root, B);
  const model = new ModelStore(B);
  cleanup = () => {
    restore();
    rmTree(fs, root);
  };
  return {
    root,
    tracker,
    model,
    original,
    sync() {
      const snap = tracker.snapshot();
      model.apply(snap);
      tracker.commit(snap);
      checkModel(fs, root, model);
      return snap;
    },
    write(path, pos, data) {
      const s = fs.open(`${root}/${path}`, O_RDWR_CREAT);
      fs.write(s, data, 0, data.length, pos);
      fs.close(s);
    },
    id(path) {
      const file = model.byPath(path);
      if (!file) throw new Error(`no record for ${path}`);
      return hex(file.inode.fileId);
    },
  };
}

const indexes = (snap: Snapshot) => snap.blocks.map((b) => b.index);
const isEmpty = (snap: Snapshot) =>
  snap.blocks.length + snap.inodes.length + snap.deleteRanges.length + snap.deadFiles.length === 0;

describe('tracker regressions', () => {
  it('a write past the end marks the zero-filled hole', () => {
    const env = setup(16);
    env.write('f', 0, bytesFrom(1, 10));
    env.sync();
    env.write('f', 100, bytesFrom(2, 4));
    expect(indexes(env.sync())).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(env.tracker.stats.trackingGaps).toBe(0);
  });

  it('posix_fallocate growth with no write marks the new blocks', () => {
    const env = setup(16);
    env.write('f', 0, bytesFrom(1, 16));
    env.sync();
    // ___syscall_fallocate in this build: FS.ftruncate when offset + len passes the end.
    const s = fs.open(`${env.root}/f`, O_RDWR_CREAT);
    fs.ftruncate(s.fd, 80);
    fs.close(s);
    const snap = env.sync();
    expect(indexes(snap)).toEqual([1, 2, 3, 4]);
    expect(snap.inodes.map((i) => i.size)).toEqual([80]);
  });

  it('truncate then re-extend between syncs leaves no stale block', () => {
    const env = setup(16);
    env.write('f', 0, bytesFrom(1, 64));
    env.sync();
    fs.truncate(`${env.root}/f`, 20);
    fs.truncate(`${env.root}/f`, 64);
    const snap = env.sync(); // checkModel: bytes 20… are zeros in the store too
    expect(indexes(snap)).toEqual([1, 2, 3]);
    expect(snap.deleteRanges).toEqual([]);
  });

  it('msync after mmap marks the written-back range', () => {
    const env = setup(16);
    env.write('f', 0, bytesFrom(1, 48));
    env.sync();
    const s = fs.open(`${env.root}/f`, O_RDWR_CREAT);
    const { ptr } = fs.mmap(s, 16, 16, PROT_RW, MAP_SHARED);
    mod.HEAPU8.set(bytesFrom(2, 8), ptr + 4);
    fs.msync(s, mod.HEAPU8.subarray(ptr, ptr + 16), 16, 16, MAP_SHARED);
    mod._free(ptr);
    fs.close(s);
    expect(indexes(env.sync())).toEqual([1]);
  });

  it('rename over an existing file removes all of the old file blocks', () => {
    const env = setup(16);
    env.write('a', 0, bytesFrom(1, 40));
    env.write('b', 0, bytesFrom(2, 80));
    env.sync();
    const a = env.id('a');
    const b = env.id('b');
    fs.rename(`${env.root}/a`, `${env.root}/b`);
    const snap = env.sync();
    expect(snap.blocks).toEqual([]);
    expect(snap.inodes.map((i) => [hex(i.fileId), i.path])).toEqual([[a, 'b']]);
    expect(snap.deadFiles.map(hex)).toEqual([b]);
    expect(snap.deleteRanges.map((r) => [hex(r.fileId), r.start, r.end])).toEqual([[b, 0, 5]]);
  });

  it('renaming a directory reports the new path of every node below it, and no block', () => {
    const env = setup(16);
    fs.mkdir(`${env.root}/d`);
    fs.mkdir(`${env.root}/d/e`);
    env.write('d/e/f', 0, bytesFrom(1, 40));
    env.sync();
    fs.rename(`${env.root}/d`, `${env.root}/g`);
    const snap = env.sync();
    expect(snap.inodes.map((i) => i.path).sort()).toEqual(['g', 'g/e', 'g/e/f']);
    expect(snap.blocks).toEqual([]);
  });

  it('a write to an unlinked but open file produces nothing', () => {
    const env = setup(16);
    env.write('f', 0, bytesFrom(1, 40));
    env.sync();
    const id = env.id('f');
    const s = fs.open(`${env.root}/f`, O_RDWR_CREAT);
    fs.unlink(`${env.root}/f`);
    fs.write(s, bytesFrom(2, 30), 0, 30, 10);
    const removal = env.sync();
    expect(removal.blocks).toEqual([]);
    expect(removal.inodes).toEqual([]);
    expect(removal.deadFiles.map(hex)).toEqual([id]);
    fs.write(s, bytesFrom(3, 30), 0, 30, 100);
    fs.ftruncate(s.fd, 3);
    fs.close(s);
    expect(isEmpty(env.sync())).toBe(true);
  });

  it('a 16 MB file renamed (WAL recycling) produces one inode and zero blocks', () => {
    const env = setup(8192);
    fs.mkdir(`${env.root}/pg_wal`);
    env.write('pg_wal/000000010000000000000001', 0, bytesFrom(1, 16 * 1024 * 1024));
    expect(env.sync().blocks.length).toBe(2048);
    fs.rename(`${env.root}/pg_wal/000000010000000000000001`, `${env.root}/pg_wal/000000010000000000000003`);
    const snap = env.sync();
    expect(snap.inodes.map((i) => i.path)).toEqual(['pg_wal/000000010000000000000003']);
    expect(snap.blocks).toEqual([]);
    expect(snap.deleteRanges).toEqual([]);
    expect(snap.deadFiles).toEqual([]);
  });

  it('a file created and deleted between syncs produces nothing', () => {
    const env = setup(16);
    env.sync();
    env.write('f', 0, bytesFrom(1, 40));
    fs.mkdir(`${env.root}/d`);
    fs.symlink('f', `${env.root}/l`);
    fs.unlink(`${env.root}/f`);
    fs.rmdir(`${env.root}/d`);
    fs.unlink(`${env.root}/l`);
    expect(isEmpty(env.sync())).toBe(true);
  });

  it('markAllDirty owes every node again; loadState owes nothing', () => {
    const env = setup(16);
    fs.mkdir(`${env.root}/d`);
    env.write('d/f', 0, bytesFrom(1, 40));
    env.sync();
    env.tracker.markAllDirty();
    const snap = env.sync();
    expect(snap.inodes.map((i) => i.path).sort()).toEqual(['d', 'd/f']);
    expect(indexes(snap)).toEqual([0, 1, 2]);
    env.tracker.loadState(env.model.storedFiles());
    expect(isEmpty(env.sync())).toBe(true);
  });
});

describe('tracker safety net', () => {
  it('a write that bypasses the wrappers rewrites the whole file and counts one gap', () => {
    const env = setup(16);
    env.write('secret-name', 0, bytesFrom(1, 40));
    env.sync();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const s = fs.open(`${env.root}/secret-name`, O_RDWR_CREAT);
      env.original.write(s, bytesFrom(2, 8), 0, 8, 40);
      fs.close(s);
      const snap = env.sync();
      expect(indexes(snap)).toEqual([0, 1, 2]);
      expect(env.tracker.stats.trackingGaps).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0])).not.toContain('secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('a node created or removed behind the wrappers is caught', () => {
    const env = setup(16);
    env.write('kept', 0, bytesFrom(1, 20));
    env.sync();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const rootNode = fs.lookupPath(env.root).node;
      env.original.mknod(rootNode, 'sneaky', 0o100600, 0);
      env.original.unlink(rootNode, 'kept');
      const snap = env.sync();
      expect(snap.inodes.map((i) => i.path)).toEqual(['sneaky']);
      expect(snap.deadFiles.length).toBe(1);
      expect(env.tracker.stats.trackingGaps).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('tracker snapshot isolation', () => {
  it('a write after snapshot() leaves the snapshot bytes as they were', () => {
    const env = setup(16);
    env.write('f', 0, bytesFrom(1, 32));
    const snap = env.tracker.snapshot();
    const copies = snap.blocks.map((b) => b.bytes.slice());
    env.write('f', 0, bytesFrom(2, 32));
    fs.truncate(`${env.root}/f`, 0);
    expect(snap.blocks.map((b) => b.bytes)).toEqual(copies);
    env.tracker.commit(snap);
  });
});
