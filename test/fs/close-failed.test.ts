// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// A failed close: PGlite 0.5.10 keeps its module when closeFs rejects, so a host keeping the instance keeps its database (docs/usage.md says drop it).
// What EncryptedFs holds must not keep it too; bounds and GC loop are release.test.ts's (1 instance, 2 in WebKit).
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

const failingWhen = (backend: StorageBackend, failing: () => boolean, fault: Error): StorageBackend =>
  new Proxy(backend, {
    get(target, prop, receiver) {
      if (failing() && (prop === 'commit' || prop === 'get')) return () => Promise.reject(fault);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

function churn(): void {
  const junk: unknown[] = [];
  for (let i = 0; i < 32; i++) junk.push(new ArrayBuffer(1 << 20), Array.from({ length: 10_000 }, (_, j) => ({ j })));
}

async function afterGc(held: Array<Array<WeakRef<object>>>, bound: number): Promise<number> {
  const until = performance.now() + 60_000;
  for (;;) {
    churn();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const n = held.filter((refs) => refs.some((ref) => ref.deref() !== undefined)).length;
    if (n <= bound || performance.now() > until) return n;
  }
}

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
