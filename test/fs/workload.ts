// 200 small transactions (2,000 under CIPHER_LONG in the crash matrix) that change the file table: CREATE TABLE, growth, a second table grown, shrunk and VACUUM-truncated, a DROP unlinked by a checkpoint.
// Every step but VACUUM and CHECKPOINT logs its number in `log`, so a database can be checked against the prefix it holds.
import type { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';

export interface Step {
  sql: string;
  log: number | null;
}

const BIG_FROM = 41;
const BIG_DELETE = 91;
const BIG_DROP = 141;
const BIG_ROWS_PER_STEP = 40;
const BIG_KEPT = 200;

export const workload = (count: number): readonly Step[] => {
  const out: Step[] = [];
  let n = 0;
  const log = (before = ''): Step => {
    n++;
    return { sql: `${before}INSERT INTO log VALUES (${String(n)}, repeat(md5('${String(n)}'), 40));`, log: n };
  };
  out.push(log('CREATE TABLE log (i int PRIMARY KEY, pad text); '));
  while (out.length < BIG_FROM - 1) out.push(log());
  out.push(log('CREATE TABLE big (id serial PRIMARY KEY, pad text); '));
  while (out.length < BIG_DELETE - 1) {
    out.push(log(`INSERT INTO big (pad) SELECT repeat(md5(g::text), 30) FROM generate_series(1, ${String(BIG_ROWS_PER_STEP)}) g; `));
  }
  out.push(log(`DELETE FROM big WHERE id > ${String(BIG_KEPT)}; `));
  out.push({ sql: 'VACUUM big', log: null });
  while (out.length < BIG_DROP - 1) out.push(log());
  out.push(log('DROP TABLE big; '));
  out.push({ sql: 'CHECKPOINT', log: null });
  while (out.length < count) out.push(log());
  return out;
};

export const STEPS = workload(200);

export const lastLogging = (n: number, steps = STEPS): number => {
  for (let i = n; i > 0; i--) if (steps[i - 1]?.log !== null) return i;
  return 0;
};

function expected(m: number, all: readonly Step[]): { logs: number; big: number | null } {
  const steps = all.slice(0, m);
  const logs = steps.filter((s) => s.log !== null).length;
  if (m < BIG_FROM || m >= BIG_DROP) return { logs, big: null };
  const inserts = Math.min(m, BIG_DELETE - 1) - BIG_FROM;
  return { logs, big: m >= BIG_DELETE ? Math.min(BIG_KEPT, inserts * BIG_ROWS_PER_STEP) : inserts * BIG_ROWS_PER_STEP };
}

/** The last logging step the database holds, checked as a consistent prefix: `log` is 1 … n and `big` matches those steps. */
export async function stepsHeld(pg: PGlite, steps = STEPS): Promise<number> {
  const { rows } = await pg.query<{ log: boolean; big: boolean }>(
    `SELECT to_regclass('log') IS NOT NULL AS log, to_regclass('big') IS NOT NULL AS big`,
  );
  const has = rows[0] ?? { log: false, big: false };
  let logs = 0;
  if (has.log) {
    const r = await pg.query<{ n: number; max: number | null; sum: string | null }>(
      'SELECT count(*)::int AS n, max(i) AS max, sum(i)::text AS sum FROM log',
    );
    const { n, max, sum } = r.rows[0] ?? { n: 0, max: null, sum: null };
    expect(max ?? 0).toBe(n);
    expect(Number(sum ?? 0)).toBe((n * (n + 1)) / 2);
    logs = n;
  }
  let m = 0;
  for (let i = 0; i < steps.length; i++) if ((steps[i]?.log ?? 0) <= logs && steps[i]?.log !== null) m = i + 1;
  if (!has.log) m = 0;
  const big = has.big ? ((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM big')).rows[0]?.n ?? 0) : null;
  // A step without a log entry right after m (VACUUM, CHECKPOINT) changes nothing these checks see.
  expect({ logs, big }).toEqual(expected(m, steps));
  return m;
}

export async function runSteps(pg: PGlite, onStep: (index: number, error: unknown) => Promise<void> | void, steps = STEPS): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    let error: unknown = null;
    try {
      await pg.exec((steps[i] as Step).sql);
    } catch (e) {
      error = e;
    }
    await onStep(i + 1, error);
  }
}
