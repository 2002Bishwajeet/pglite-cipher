// A close whose sync fails. PGlite 0.5.10 keeps its module when closeFs rejects (it stops
// before it drops it), so a host that keeps such an instance keeps its database: docs/usage.md says to
// drop it. What EncryptedFs holds must not keep it too: a host that keeps only the filesystem
// keeps none of the instance, its module, the tracker (it holds the data directory's nodes) or the
// file map. Each cycle opens, writes, and closes on a backend that fails once the close starts;
// the host keeps every filesystem and drops every instance. The bounds and the GC loop are those of
// release.test.ts: one instance (two in WebKit) for a GC that finds a stale pointer.
import { describe, expect, it } from 'vitest';
import type { StorageBackend } from '../../src/backend/backend.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import type { EncryptedFs } from '../../src/encryptedFs.ts';
import { InjectedFault } from '../../src/testing.ts';
import { inBrowser, newKey, openStore, PGDATA, shared } from './helpers.ts';

const CYCLES = 6;

async function engineBound(): Promise<number> {
  if (!inBrowser) return 1;
  const { server } = await import('vitest/browser');
  return server.browser === 'webkit' ? 2 : 1;
}

/** `backend`, whose commits and root reads reject with `fault` once `failing()` is true. */
const failingWhen = (backend: StorageBackend, failing: () => boolean, fault: Error): StorageBackend =>
  new Proxy(backend, {
    get(target, prop, receiver) {
      if (failing() && (prop === 'commit' || prop === 'get')) return () => Promise.reject(fault);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

/** 32 MB of buffers and 320,000 objects, garbage on return. */
function churn(): void {
  const junk: unknown[] = [];
  for (let i = 0; i < 32; i++) junk.push(new ArrayBuffer(1 << 20), Array.from({ length: 10_000 }, (_, j) => ({ j })));
}

/** How many of `held` still deref, once that is at most `bound` or a minute has passed. */
async function afterGc(held: Array<Array<WeakRef<object>>>, bound: number): Promise<number> {
  const until = performance.now() + 60_000;
  for (;;) {
    churn();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const n = held.filter((refs) => refs.some((ref) => ref.deref() !== undefined)).length;
    if (n <= bound || performance.now() > until) return n;
  }
}

/**
 * One cycle: opens, writes, and closes with a failing backend. Returns the filesystem, the close's
 * rejection, and weak references to the instance, its module, the module's FS, wasm memory and data
 * directory. The instance is dropped on return.
 */
async function cycle(memory: MemoryBackend, key: CryptoKey, i: number, fault: Error) {
  let failing = false;
  const { pg, fs } = await openStore({ backend: failingWhen(shared(memory), () => failing, fault), key });
  if (i === 0) await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text)');
  await pg.exec(`INSERT INTO t SELECT i, repeat(md5(i::text), 28) FROM generate_series(${String(i * 2000 + 1)}, ${String((i + 1) * 2000)}) i`);
  expect(fs.stats().files).toBeGreaterThan(0);
  const mod = pg.Module as unknown as { HEAPU8: Uint8Array; FS: { lookupPath(path: string): { node: object } } };
  const refs = [pg, mod, mod.FS, mod.HEAPU8.buffer, mod.FS.lookupPath(PGDATA).node].map((o) => new WeakRef(o));
  failing = true;
  const closed = await pg.close().then(
    () => null,
    (error: unknown) => error,
  );
  return { fs, closed, refs };
}

describe('close', () => {
  it(`${String(CYCLES)} closes whose sync fails reject with its error, and their filesystems, all kept, hold no instance`, async () => {
    const max = await engineBound();
    const memory = new MemoryBackend();
    const key = await newKey();
    const kept: EncryptedFs[] = [];
    const held: Array<Array<WeakRef<object>>> = [];
    for (let i = 0; i < CYCLES; i++) {
      const fault = new InjectedFault('the backend is gone');
      const { fs, closed, refs } = await cycle(memory, key, i, fault);
      expect(closed).toBe(fault);
      kept.push(fs);
      held.push(refs);
    }
    expect(await afterGc(held, max)).toBeLessThanOrEqual(max);
    expect(kept.map((fs) => fs.stats().files)).toEqual(kept.map(() => 0));
    expect(kept.map((fs) => fs.hasDirty())).toEqual(kept.map(() => false));
    // Reopening recovers: the store holds every row the syncs before each failed close committed.
    const { pg } = await openStore({ backend: shared(memory), key, mode: 'open' });
    const rows = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM t');
    expect(rows.rows[0]?.n).toBe(CYCLES * 2000);
    await pg.close();
  }, 240_000);
});
