// Model-based property test: random filesystem operations through the real Emscripten FS, a model
// store fed only by snapshots, and at every quiescent sync the model must equal MEMFS.
import type { PGlite } from '@electric-sql/pglite';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { installTracker, type Snapshot } from '../../src/tracker/tracker.ts';
import {
  MAP_SHARED,
  ModelStore,
  O_RDWR_CREAT,
  PROT_RW,
  bytesFrom,
  checkModel,
  inBrowser,
  isDirMode,
  isErrno,
  isLinkMode,
  listTree,
  rmTree,
  saveOps,
  startPGlite,
  type Stream,
  type TestModule,
} from './harness.ts';

const KINDS = {
  create: 3,
  open: 2,
  close: 1,
  write: 8,
  truncate: 3,
  fallocate: 2,
  msync: 2,
  rename: 3,
  unlink: 2,
  mkdir: 2,
  rmdir: 1,
  symlink: 1,
  chmod: 1,
  utime: 1,
  begin: 1, // take a snapshot and leave it in flight while the engine keeps writing
  end: 1, // settle the in-flight snapshot
  sync: 2, // settle, snapshot, apply, commit, check
} as const;
type Kind = keyof typeof KINDS;
interface Op {
  k: Kind;
  a: number;
  b: number;
  c: number;
  d: number;
}

const opArb: fc.Arbitrary<Op> = fc.record({
  k: fc.oneof(...Object.entries(KINDS).map(([k, weight]) => ({ weight, arbitrary: fc.constant(k as Kind) }))),
  a: fc.nat(),
  b: fc.nat(),
  c: fc.nat(),
  d: fc.nat(),
});
const runArb = fc.tuple(fc.constantFrom(8, 16, 64), fc.array(opArb, { maxLength: 60, size: 'max' }));
const numRuns = inBrowser ? 200 : 2000;

let pg: PGlite;
let mod: TestModule;
let runs = 0;

beforeAll(async () => {
  ({ pg, mod } = await startPGlite());
}, 120_000);

afterAll(async () => {
  await pg.close();
});

function pick<T>(list: readonly T[], n: number): T | undefined {
  return list.length === 0 ? undefined : list[n % list.length];
}

/** Runs one sequence; `failures` lets syncs fail (requeue instead of commit). */
function run(B: number, ops: readonly Op[], failures: boolean): void {
  const fs = mod.FS;
  const memfs = fs.filesystems.MEMFS;
  const root = `/tmp/prop-${String(++runs)}`;
  fs.mkdir(root);
  const restore = saveOps(memfs);
  const streams: Stream[] = [];
  try {
    const tracker = installTracker(fs, memfs, root, B);
    const model = new ModelStore(B);
    let inflight: Snapshot | null = null;
    let names = 0;
    const fresh = () => `n${String(names++)}`;
    const settle = (fail: boolean) => {
      if (!inflight) return;
      if (fail) tracker.requeue(inflight);
      else {
        model.apply(inflight);
        tracker.commit(inflight);
      }
      inflight = null;
    };
    const sync = (fail: boolean) => {
      settle(fail);
      const snap = tracker.snapshot();
      if (fail) {
        tracker.requeue(snap);
        return;
      }
      model.apply(snap);
      tracker.commit(snap);
      checkModel(fs, root, model);
      if (tracker.stats.trackingGaps !== 0) throw new Error(`trackingGaps = ${String(tracker.stats.trackingGaps)}`);
    };

    for (const { k, a, b, c, d } of ops) {
      const tree = [...listTree(fs, root)];
      const all = tree.map(([path]) => `${root}/${path}`);
      const files = tree.filter(([, s]) => !isDirMode(s.mode) && !isLinkMode(s.mode)).map(([p]) => `${root}/${p}`);
      const links = tree.filter(([, s]) => isLinkMode(s.mode)).map(([p]) => `${root}/${p}`);
      const dirs = [root, ...tree.filter(([, s]) => isDirMode(s.mode)).map(([p]) => `${root}/${p}`)];
      const stream = pick(streams, a);
      const size = stream?.node.usedBytes ?? 0;
      const fail = failures && d % 2 === 1;
      try {
        switch (k) {
          case 'create':
            streams.push(fs.open(`${pick(dirs, a) ?? root}/${fresh()}`, O_RDWR_CREAT, 0o600));
            break;
          case 'open': {
            const file = pick(files, a);
            if (file) streams.push(fs.open(file, O_RDWR_CREAT));
            break;
          }
          case 'close':
            if (stream) {
              streams.splice(streams.indexOf(stream), 1);
              fs.close(stream);
            }
            break;
          case 'write': {
            if (!stream) break;
            // before, at and past the end; lengths that cross block boundaries
            const pos = [size === 0 ? 0 : b % size, size, size + 1 + (b % (3 * B))][c % 3] ?? 0;
            const len = 1 + (d % (3 * B));
            // canOwn: MEMFS may take the buffer as the whole file, ignoring the position
            fs.write(stream, bytesFrom(d, len), 0, len, pos, c % 4 === 3);
            break;
          }
          case 'truncate': {
            const len = b % (8 * B); // shorter or longer than the file
            const file = pick(files, a);
            if (c % 2 === 0 && file) fs.truncate(file, len);
            else if (stream) fs.ftruncate(stream.fd, len);
            break;
          }
          case 'fallocate': {
            // posix_fallocate in this build: ___syscall_fallocate grows the file with ftruncate.
            const end = (b % (6 * B)) + 1 + (c % (4 * B));
            if (stream && end > size) fs.ftruncate(stream.fd, end);
            break;
          }
          case 'msync': {
            if (!stream) break;
            const pos = b % (size + B + 1);
            const len = 1 + (c % (2 * B));
            const { ptr } = fs.mmap(stream, len, pos, PROT_RW, MAP_SHARED);
            const from = d % len;
            mod.HEAPU8.set(bytesFrom(d, len - from), ptr + from);
            fs.msync(stream, mod.HEAPU8.subarray(ptr, ptr + len), pos, len, MAP_SHARED);
            mod._free(ptr);
            break;
          }
          case 'rename': {
            const src = pick(all, a);
            const dst = b % 2 === 0 ? pick(all, c) : `${pick(dirs, c) ?? root}/${fresh()}`;
            if (src && dst) fs.rename(src, dst);
            break;
          }
          case 'unlink': {
            const path = pick([...files, ...links], a);
            if (path) fs.unlink(path);
            break;
          }
          case 'mkdir':
            fs.mkdir(`${pick(dirs, a) ?? root}/${fresh()}`, 0o700);
            break;
          case 'rmdir': {
            const dir = pick(dirs.slice(1), a);
            if (dir) fs.rmdir(dir);
            break;
          }
          case 'symlink':
            fs.symlink(pick(all, b) ?? 'nowhere', `${pick(dirs, a) ?? root}/${fresh()}`);
            break;
          case 'chmod': {
            const path = pick(all, a);
            if (path) fs.chmod(path, 0o700 | (b & 0o077)); // owner keeps rwx: FS checks permissions
            break;
          }
          case 'utime': {
            const path = pick(all, a);
            if (path) fs.utime(path, b, Date.now() + 1 + b);
            break;
          }
          case 'begin':
            if (!inflight) inflight = tracker.snapshot();
            break;
          case 'end':
            settle(fail);
            break;
          case 'sync':
            sync(fail);
            break;
        }
      } catch (e) {
        if (!isErrno(e)) throw e; // the operation was refused (ENOTEMPTY, EISDIR, …): nothing changed
      }
    }
    settle(false);
    sync(false);
  } finally {
    for (const s of streams) fs.close(s);
    restore();
    rmTree(fs, root);
  }
}

describe('tracker model-based property', () => {
  it(
    'the model store equals MEMFS at every sync',
    () => {
      fc.assert(
        fc.property(runArb, ([B, ops]) => {
          run(B, ops, false);
        }),
        { numRuns },
      );
    },
    600_000,
  );

  it(
    'with failing syncs requeued, the model equals MEMFS after the next successful sync',
    () => {
      fc.assert(
        fc.property(runArb, ([B, ops]) => {
          run(B, ops, true);
        }),
        { numRuns },
      );
    },
    600_000,
  );
});
