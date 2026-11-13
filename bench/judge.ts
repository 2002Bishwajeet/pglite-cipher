// The gate table of one bench result: the ratios against plain idb:// as they are, and the absolute
// budgets of #3 (open 100 MB in 1,500 ms, a WAL segment switch in 500 ms, desktop) times `factor`.
// The page judges with factor 1; the nightly workflow with its CI factor (bench/gates.ts).
import type { VariantResult } from './measure.ts';

export interface GateRow {
  gate: string;
  value: number | string;
  limit: string;
  pass: boolean | 'n/a';
}

/** Desktop budgets the owner approved on #3. */
export const OPEN_BUDGET_MS = 1500;
export const SWITCH_BUDGET_MS = 500;
const MB = 1024 * 1024;

export interface GatesResult {
  sizeMB: number;
  blockSize: number;
  plain: VariantResult;
  encrypted: VariantResult;
}

export interface YearResult {
  liveSalts: number;
  deriveKeyP50Ms: number;
}

export function judgeGates(r: GatesResult, factor: number): GateRow[] {
  const { plain, encrypted: e } = r;
  const big = r.sizeMB >= 100;
  const openBudget = OPEN_BUDGET_MS * factor;
  const rows: GateRow[] = [];
  const row = (gate: string, value: number | string, limit: string, pass: boolean | 'n/a') => rows.push({ gate, value, limit, pass });
  const ratio = (a: number, b: number) => Math.round((a / b) * 100) / 100;

  const g1 = ratio(e.g1.ms.p50, plain.g1.ms.p50);
  row('G1 sync after a one-row UPDATE, p50 ÷ plain', g1, '≤ 2', g1 <= 2);
  const g2 = ratio(e.g2.ms.p50, plain.g2.ms.p50);
  row('G2 open, p50 ÷ plain', g2, '≤ 2', g2 <= 2);
  if (big) row('G2 open, p50 ms', e.g2.ms.p50, `≤ ${String(openBudget)}`, e.g2.ms.p50 <= openBudget);
  // G3 is judged only from measureUserAgentSpecificMemory (headed, cross-origin isolated). Headless,
  // the page has only performance.memory plus the wasm heap, which fails for plain idb:// too
  // (SPIKE-RESULTS.md, G3); the owner left G3 as recorded (#2, #3).
  const bytes = e.g3.bytes;
  const db = e.dataDir.bytes;
  const measured = e.g3.source === 'measureUserAgentSpecificMemory' && typeof bytes === 'number';
  row(`G3 memory after the open, bytes (${String(e.g3.source)})`, typeof bytes === 'number' ? bytes : 'not available', `≤ database (${String(db)}) + 64 MB`, measured ? bytes <= db + 64 * MB : 'n/a');
  row('G4 segment switch, p50 ms', e.g4.ms.p50, `≤ ${String(SWITCH_BUDGET_MS * factor)}`, e.g4.ms.p50 <= SWITCH_BUDGET_MS * factor);
  const g4 = ratio(e.g4.ms.p50, plain.g1.ms.p50);
  row('G4 segment switch, p50 ÷ plain normal sync', g4, '≤ 10', g4 <= 10);
  const tableMs = e.g2.tableMs?.p50 ?? NaN;
  // At 10 MB the owner replaced the open budget with "≤ 2× plain": G9 is then 5 % of the open measured.
  const g9Limit = big ? 0.05 * openBudget : 0.05 * e.g2.ms.p50;
  row('G9 file-table phase of the open, p50 ms', tableMs, `≤ ${String(Math.round(g9Limit * 10) / 10)}`, tableMs <= g9Limit);
  const unexplained = e.g1.tableBlocksWithoutFileChange ?? NaN;
  row('G9 G1 syncs that changed no file and wrote a table block', unexplained, '0', unexplained === 0);
  return rows;
}

export function judgeYear(r: YearResult, factor: number): GateRow[] {
  const ms = Math.round(r.liveSalts * r.deriveKeyP50Ms * 1000) / 1000;
  const limit = 0.1 * OPEN_BUDGET_MS * factor;
  return [{ gate: 'G8 live salts × deriveKey p50 after a year, ms', value: ms, limit: `≤ ${String(limit)}`, pass: ms <= limit }];
}

export const table = (rows: readonly GateRow[]): string =>
  ['| Gate | Value | Limit | Pass |', '| --- | --- | --- | --- |', ...rows.map((g) => `| ${g.gate} | ${String(g.value)} | ${g.limit} | ${g.pass === 'n/a' ? 'n/a' : g.pass ? 'pass' : '**FAIL**'} |`)].join('\n');
