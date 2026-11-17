// The gate table of one bench result: the ratios against plain idb:// as they are, and the absolute
// budgets of #3 (open 100 MB in 1,500 ms, a WAL segment switch in 500 ms, desktop) times `factor`.
// The page judges with factor 1; the nightly workflow with its CI factor (bench/gates.ts).
import type { VariantResult } from './measure.ts';

export interface GateRow {
  gate: string;
  value: number | string;
  limit: string;
  pass: boolean | 'not measurable';
}

/** Desktop budgets the owner approved on #3. */
export const OPEN_BUDGET_MS = 1500;
export const SWITCH_BUDGET_MS = 500;
const MB = 1024 * 1024;

export interface GatesResult {
  sizeMB: number;
  blockSize: number;
  /** Absent in an encrypted-only part (`enc10`, `enc100`): the ratio gates then report "no plain baseline". */
  plain?: VariantResult;
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
  const row = (gate: string, value: number | string, limit: string, pass: GateRow['pass']) => rows.push({ gate, value, limit, pass });
  const ratio = (a: number, b: number) => Math.round((a / b) * 100) / 100;

  const NO_PLAIN = 'no plain baseline';
  const vsPlain = (gate: string, num: number, den: number | undefined, limit: number) => {
    const v = den === undefined ? undefined : ratio(num, den);
    row(gate, v ?? NO_PLAIN, `≤ ${String(limit)}`, v === undefined ? 'not measurable' : v <= limit);
  };
  vsPlain('G1 sync after a one-row UPDATE, p50 ÷ plain', e.g1.ms.p50, plain?.g1.ms.p50, 2);
  vsPlain('G2 open, p50 ÷ plain', e.g2.ms.p50, plain?.g2.ms.p50, 2);
  if (big) row('G2 open, p50 ms', e.g2.ms.p50, `≤ ${String(openBudget)}`, e.g2.ms.p50 <= openBudget);
  // G3 is recorded, never asserted in CI, and judged only from measureUserAgentSpecificMemory
  // (headed, cross-origin isolated). Headless, the page has only performance.memory plus the wasm
  // heap, which fails for plain idb:// too: that is "not measurable".
  const bytes = e.g3.bytes;
  const db = e.dataDir.bytes;
  const measured = e.g3.source === 'measureUserAgentSpecificMemory' && typeof bytes === 'number';
  row(`G3 memory after the open, bytes (${String(e.g3.source)})`, typeof bytes === 'number' ? bytes : 'not available', `≤ database (${String(db)}) + 64 MB`, measured ? bytes <= db + 64 * MB : 'not measurable');
  row('G4 segment switch, p50 ms', e.g4.ms.p50, `≤ ${String(SWITCH_BUDGET_MS * factor)}`, e.g4.ms.p50 <= SWITCH_BUDGET_MS * factor);
  vsPlain('G4 segment switch, p50 ÷ plain normal sync', e.g4.ms.p50, plain?.g1.ms.p50, 10);
  const tableMs = e.g2.tableMs?.p50 ?? NaN;
  // At 10 MB the owner replaced the open budget with "≤ 2× plain": G9 is then 5 % of the open measured.
  const g9Limit = big ? 0.05 * openBudget : 0.05 * e.g2.ms.p50;
  row('G9 file-table phase of the open, p50 ms', tableMs, `≤ ${String(Math.round(g9Limit * 10) / 10)}`, tableMs <= g9Limit);
  const unexplained = e.g1.tableBlocksWithoutFileChange ?? NaN;
  row('G9 G1 syncs that changed no file and wrote a table block', unexplained, '0', unexplained === 0);
  const g1Table = e.g1.tableBlocks?.p50 ?? NaN;
  row('G9 table blocks of a G1 sync, p50', g1Table, '0', g1Table === 0);
  const perFile = e.g1.maxTableBlocksPerChangedFile ?? NaN;
  row(`G9 table blocks per changed file, most of any G1 sync (${String(e.g1.fileChanges ?? 0)} changed a file)`, perFile, '≤ 1', perFile <= 1);
  // Key operations that threw (#63) fail here: the part keeps G1 to G4, but never reads as passed.
  if (e.keysError !== undefined) row('Key operations (changeKey, verify, rotateDataKey)', `failed: ${e.keysError}`, 'complete', false);
  return rows;
}

/** The rows for one result part, by its name: gates* and enc* parts are gate tables, year is G8; others have none. */
export function judgePart(name: string, part: unknown, factor: number): GateRow[] | null {
  if (name.startsWith('gates') || name.startsWith('enc')) return judgeGates(part as GatesResult, factor);
  if (name === 'year') return judgeYear(part as YearResult, factor);
  return null;
}

export function judgeYear(r: YearResult, factor: number): GateRow[] {
  const ms = Math.round(r.liveSalts * r.deriveKeyP50Ms * 1000) / 1000;
  const limit = 0.1 * OPEN_BUDGET_MS * factor;
  return [{ gate: 'G8 live salts × deriveKey p50 after a year, ms', value: ms, limit: `≤ ${String(limit)}`, pass: ms <= limit }];
}

export const table = (rows: readonly GateRow[]): string =>
  ['| Gate | Value | Limit | Pass |', '| --- | --- | --- | --- |', ...rows.map((g) => `| ${g.gate} | ${String(g.value)} | ${g.limit} | ${g.pass === 'not measurable' ? 'not measurable' : g.pass ? 'pass' : '**FAIL**'} |`)].join('\n');
