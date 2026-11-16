// The nightly gate check: reads bench/run.mjs results (bench/results/<browser>.json), judges every
// gates and year part with the absolute budgets times `--factor`, prints the gate tables as
// Markdown (the job summary), and exits 1 if a gate fails or a part errored or is missing.
// Usage: node bench/gates.ts --factor 2 --require gates100,year bench/results/chromium.json ...
import { readFileSync } from 'node:fs';
import { judgeGates, judgeYear, table, type GatesResult, type YearResult } from './judge.ts';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : (args.splice(i, 2)[1] ?? fallback);
};
const factor = Number(opt('factor', '1'));
const required = opt('require', '').split(',').filter(Boolean);

let failed = false;
const out: string[] = [`Absolute budgets × ${String(factor)} (ratios against plain idb:// are not relaxed).`, ''];
for (const file of args) {
  const result = JSON.parse(readFileSync(file, 'utf8')) as { browser?: string; userAgent?: string; parts?: Record<string, unknown> };
  const parts = result.parts ?? {};
  out.push(`### ${result.browser ?? file}`, '', `\`${result.userAgent ?? 'unknown user agent'}\``, '');
  for (const name of required) {
    if (!(name in parts)) {
      failed = true;
      out.push(`**FAIL**: part \`${name}\` is missing`, '');
    }
  }
  for (const [name, part] of Object.entries(parts)) {
    if (part !== null && typeof part === 'object' && 'error' in part) {
      failed = true;
      out.push(`**FAIL**: part \`${name}\`: ${String(part.error)}`, '');
      continue;
    }
    const rows = name.startsWith('gates') || name.startsWith('enc') ? judgeGates(part as GatesResult, factor) : name === 'year' ? judgeYear(part as YearResult, factor) : null;
    if (!rows) continue;
    if (rows.some((r) => r.pass === false)) failed = true;
    out.push(`#### ${name}`, '', table(rows), '');
  }
}
console.log(out.join('\n'));
process.exit(failed ? 1 : 0);
