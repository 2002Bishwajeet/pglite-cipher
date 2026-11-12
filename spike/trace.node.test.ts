// Spike (issue #2): runs the workload on the trace filesystem and writes spike/results/trace.json.
// Node only: it writes the results file and starts a child process (relaxedProbe.mjs).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dirStats, fsOf } from './memfs.ts';
import { Trace, TraceFS } from './traceFs.ts';
import type { SyncEvent } from './traceFs.ts';
import { createPg, runWorkload } from './workload.ts';

const tableChange = (s: SyncEvent) => s.creates.length + s.sizeChanges.length + s.renames.length + s.removes.length > 0;

function summarizeSyncs(syncs: SyncEvent[]) {
  // A write commit is a sync with at least one write; the others (a SELECT) are no-op syncs.
  const byPhase: Record<string, { syncs: number; writeCommits: number; withTableChange: number; creates: number; sizeChanges: number; renames: number; removes: number; sizeChangedFiles: Record<string, number> }> = {};
  for (const s of syncs) {
    const p = (byPhase[s.phase] ??= { syncs: 0, writeCommits: 0, withTableChange: 0, creates: 0, sizeChanges: 0, renames: 0, removes: 0, sizeChangedFiles: {} });
    p.syncs++;
    if (s.writes > 0) p.writeCommits++;
    if (tableChange(s)) p.withTableChange++;
    p.creates += s.creates.length;
    p.sizeChanges += s.sizeChanges.length;
    p.renames += s.renames.length;
    p.removes += s.removes.length;
    for (const f of s.sizeChanges) p.sizeChangedFiles[f] = (p.sizeChangedFiles[f] ?? 0) + 1;
  }
  return { total: syncs.length, writeCommits: syncs.filter((s) => s.writes > 0).length, withTableChange: syncs.filter(tableChange).length, byPhase };
}

async function probeSyncBehaviour() {
  const fs = new TraceFS({ syncDelayMs: 50 });
  const pg = await createPg(fs);
  const count = () => fs.trace.syncs.length;
  let n = count();
  await pg.query('SELECT 1');
  const perQuery = count() - n;
  n = count();
  await pg.exec('CREATE TABLE t (x int); INSERT INTO t VALUES (1); SELECT 1;');
  const perExecOfThreeStatements = count() - n;
  n = count();
  await pg.transaction(async (tx) => {
    await tx.query('INSERT INTO t VALUES (2)');
    await tx.query('INSERT INTO t VALUES (3)');
  });
  const perTransactionOfTwoQueries = count() - n;

  // electric-sql/pglite#1191: a second pg.syncToFs() while one is queued.
  let done0 = fs.syncsDone;
  const p1 = pg.syncToFs();
  const p2 = pg.syncToFs();
  await p2;
  const syncsDoneWhenSecondCallReturned = fs.syncsDone - done0;
  await p1;
  // The same while a sync is already running: the third call queues, the fourth returns at once.
  const running = pg.syncToFs();
  await new Promise((r) => setTimeout(r, 10));
  done0 = fs.syncsDone;
  const queued = pg.syncToFs();
  const fourth = pg.syncToFs();
  await fourth;
  const syncsDoneWhenFourthCallReturned = fs.syncsDone - done0;
  await Promise.all([running, queued]);
  await pg.close();
  return {
    syncsPerQuery: perQuery,
    syncsPerExecOfThreeStatements: perExecOfThreeStatements,
    syncsPerTransactionOfTwoQueriesIncludingCommit: perTransactionOfTwoQueries,
    syncsDoneWhenSecondCallReturned,
    syncsDoneWhenFourthCallReturned,
  };
}

describe('filesystem-operation trace', () => {
  it('runs the workload in Node and writes spike/results/trace.json', async () => {
    const trace = new Trace();
    let fs: TraceFS | undefined;
    let fresh: ReturnType<typeof dirStats> | undefined;
    const open = async (reopen: boolean) => {
      const last = fs?.last;
      fs = new TraceFS({ trace, ...(reopen && last ? { restore: last } : {}) });
      const pg = await createPg(fs);
      if (!reopen) fresh = dirStats(fsOf(pg));
      return pg;
    };
    const result = await runWorkload(open, (phase) => {
      trace.phase = phase;
    });
    expect(result.afterReopen).toEqual(result.beforeClose);
    expect(result.walFiles.length).toBe(3);

    const syncBehaviour = await probeSyncBehaviour();
    const probe = spawnSync(process.execPath, [fileURLToPath(new URL('./relaxedProbe.mjs', import.meta.url))], { encoding: 'utf8' });
    const relaxed = JSON.parse(probe.stdout.trim().split('\n').pop() ?? '{}') as unknown;

    const pkg = JSON.parse(readFileSync(new URL('../node_modules/@electric-sql/pglite/package.json', import.meta.url), 'utf8')) as { version: string };
    const out = {
      pglite: pkg.version,
      node: process.version,
      freshDataDir: fresh,
      workload: result,
      ops: trace.ops,
      otherOps: trace.otherOps,
      writes: trace.writes,
      sizes: trace.sizes,
      mmaps: trace.mmaps,
      msyncs: trace.msyncs,
      creates: trace.creates,
      unlinks: trace.unlinks,
      rmdirs: trace.rmdirs,
      symlinks: trace.symlinks,
      renames: trace.renames,
      truncateThenExtend: trace.truncateThenExtend,
      syncsByPhase: trace.syncsByPhase,
      syncSummary: summarizeSyncs(trace.syncs),
      syncBehaviour,
      relaxedDurability: relaxed,
    };
    mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
    writeFileSync(new URL('./results/trace.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
  }, 600_000);
});
