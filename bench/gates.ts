// Nightly gate check: judges bench/run.mjs results against the budgets times `--factor`, prints Markdown tables, exits 1 on failure.
// Usage: node bench/gates.ts --factor 2 --require gates100,year bench/results/chromium.json ...
import { readFileSync } from 'node:fs';
import { judgePart, table } from './judge.ts';

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
    const rows = judgePart(name, part, factor);
    if (!rows) continue;
    if (rows.some((r) => r.pass === false)) failed = true;
    out.push(`#### ${name}`, '', table(rows), '');
  }
}
console.log(out.join('\n'));
process.exit(failed ? 1 : 0);
