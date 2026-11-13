// A closed instance holds no database (#42). PGlite drops its module on close; EncryptedFs kept the
// module's FS, the tracker and the file map, so a host that keeps a closed PGlite (the bench keeps
// the last one until the next open returns) kept its wasm memory and data directory too: two
// databases in memory during a reopen, which an iPhone tab does not survive at 100 MB. Each cycle
// here opens, writes, closes and keeps the instance; once the GC has run, what is still reachable
// must not grow with the cycles. The bound is one instance, for a GC that finds a stale pointer on
// the stack (WebKit's scans it conservatively). No engine gives a page gc(): allocation is the GC
// opportunity, repeated until the bound holds or a minute passes.
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { newKey, openStore, PGDATA, shared } from './helpers.ts';

const CYCLES = 3;

interface Held {
  wasm: WeakRef<object>;
  dataDir: WeakRef<object>;
}

/** The instance's wasm memory and data directory (MEMFS keeps the tree from its root), weakly. */
function hold(pg: PGlite): Held {
  const mod = pg.Module as unknown as { HEAPU8: Uint8Array; FS: { lookupPath(path: string): { node: object } } };
  return { wasm: new WeakRef(mod.HEAPU8.buffer), dataDir: new WeakRef(mod.FS.lookupPath(PGDATA).node) };
}

const reachable = (held: Held[]) => held.filter((h) => h.wasm.deref() !== undefined || h.dataDir.deref() !== undefined).length;

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
  it(`${String(CYCLES)} closed instances, all kept by the host, hold at most one database`, async () => {
    const memory = new MemoryBackend();
    const key = await newKey();
    const closed: PGlite[] = [];
    const held: Held[] = [];
    for (let i = 0; i < CYCLES; i++) {
      const { pg } = await openStore({ backend: shared(memory), key });
      if (i === 0) await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text)');
      await pg.exec(`INSERT INTO t SELECT i, repeat(md5(i::text), 28) FROM generate_series(${String(i * 2000 + 1)}, ${String((i + 1) * 2000)}) i`);
      held.push(hold(pg));
      await pg.close();
      closed.push(pg);
    }
    expect(await afterGc(held, 1)).toBeLessThanOrEqual(1);
    expect(closed).toHaveLength(CYCLES); // the host holds them to the end
  }, 240_000);
});
