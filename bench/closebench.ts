// Close time at about 100 MB, in Node over a MemoryBackend (#91): builds a store, then five times
// reopens it, changes one row and times pg.close(). Prints one JSON object with the p50.
// Usage: node bench/closebench.ts [path to a src/ directory, default ../src] [MB, default 100]
import { PGlite } from '@electric-sql/pglite';

const src = process.argv[2] ?? new URL('../src', import.meta.url).pathname;
const mb = Number(process.argv[3] ?? '100');
const { EncryptedFs } = (await import(`${src}/encryptedFs.ts`)) as typeof import('../src/encryptedFs.ts');
const { MemoryBackend } = (await import(`${src}/backend/memory.ts`)) as typeof import('../src/backend/memory.ts');
const { importKek } = (await import(`${src}/format/keys.ts`)) as typeof import('../src/format/keys.ts');

const key = await importKek(crypto.getRandomValues(new Uint8Array(32)));
const memory = new MemoryBackend();
const shared = new Proxy(memory, {
  get(target, prop, receiver) {
    if (prop === 'close') return () => Promise.resolve();
    const value: unknown = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
});
const open = () => PGlite.create({ fs: new EncryptedFs({ backend: shared, key, mode: 'open-or-create' }) });

let pg = await open();
await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text)');
await pg.exec(`INSERT INTO t SELECT i, repeat(md5(i::text), 28) FROM generate_series(1, ${String(Math.round((mb * 1024 * 1024) / 900))}) i`);
await pg.exec('CHECKPOINT');
await pg.close();

const ms: number[] = [];
for (let run = 0; run < 5; run++) {
  pg = await open();
  await pg.exec(`UPDATE t SET v = v WHERE id = ${String(run + 1)}`);
  const t0 = performance.now();
  await pg.close();
  ms.push(performance.now() - t0);
}
const sorted = [...ms].sort((a, b) => a - b);
console.log(JSON.stringify({ mb, closeMs: ms.map((x) => Math.round(x)), p50: Math.round(sorted[2] as number) }));
