// A closed instance holds no database (#42). PGlite drops its module on close; EncryptedFs kept the
// module's FS, the tracker and the file map, so a host that keeps a closed PGlite (the bench keeps
// the last one until the next open returns) kept its wasm memory and data directory too: two
// databases in memory during a reopen, which an iPhone tab does not survive at 100 MB. Each cycle
// here opens, writes, closes and keeps the instance; once the GC has run, what is still reachable
// must not grow with the cycles. The bound is one instance in Node, Chromium and Firefox, for a GC
// that finds a stale pointer on the stack. It is two in WebKit: there plain PGlite, with none of our
// code loaded, keeps two closed instances through a forced full GC (the STOP comment on #42,
// issuecomment-6853534809). No engine gives a page gc(): allocation is the GC opportunity, repeated
// until the bound holds or a minute passes.
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { inBrowser, newKey, type Opened, openStore, PGDATA, shared } from './helpers.ts';

const CYCLES = 6;

/** How many closed instances may stay reachable in this engine (see above). */
async function engineBound(): Promise<number> {
  if (!inBrowser) return 1;
  const { server } = await import('vitest/browser');
  return server.browser === 'webkit' ? 2 : 1;
}

interface Held {
  module: WeakRef<object>;
  wasm: WeakRef<object>;
  dataDir: WeakRef<object>;
}

/** The instance's module, wasm memory and data directory (MEMFS keeps the tree from its root), weakly. */
function hold(pg: PGlite): Held {
  const mod = pg.Module as unknown as { HEAPU8: Uint8Array; FS: { lookupPath(path: string): { node: object } } };
  return { module: new WeakRef(mod), wasm: new WeakRef(mod.HEAPU8.buffer), dataDir: new WeakRef(mod.FS.lookupPath(PGDATA).node) };
}

const reachable = (held: Held[]) =>
  held.filter((h) => h.module.deref() !== undefined || h.wasm.deref() !== undefined || h.dataDir.deref() !== undefined).length;

/** 32 MB of buffers and 320,000 objects, garbage on return. */
function churn(): void {
  const junk: unknown[] = [];
  for (let i = 0; i < 32; i++) junk.push(new ArrayBuffer(1 << 20), Array.from({ length: 10_000 }, (_, j) => ({ j })));
}

/** How many of `held` are still reachable, once that is at most `bound` or a minute has passed. */
async function afterGc(held: Held[], bound: number): Promise<number> {
  const until = performance.now() + 60_000;
  for (;;) {
    churn();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const n = reachable(held);
    if (n <= bound || performance.now() > until) return n;
  }
}

describe('close', () => {
  it(`${String(CYCLES)} closed instances, all kept by the host, hold at most one database (two in WebKit)`, async () => {
    const max = await engineBound();
    const memory = new MemoryBackend();
    const key = await newKey();
    const closed: Opened[] = [];
    const held: Held[] = [];
    for (let i = 0; i < CYCLES; i++) {
      const opened = await openStore({ backend: shared(memory), key });
      const { pg, fs } = opened;
      if (i === 0) await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text)');
      await pg.exec(`INSERT INTO t SELECT i, repeat(md5(i::text), 28) FROM generate_series(${String(i * 2000 + 1)}, ${String((i + 1) * 2000)}) i`);
      expect(fs.stats().files).toBeGreaterThan(0);
      held.push(hold(pg));
      await pg.close();
      closed.push(opened);
    }
    expect(await afterGc(held, max)).toBeLessThanOrEqual(max);
    // The file map holds no module memory, so the count above does not see it; stats() reads it.
    // The host holds every closed instance to here.
    expect(closed.map(({ fs }) => fs.stats().files)).toEqual(closed.map(() => 0));
  }, 240_000);
});
