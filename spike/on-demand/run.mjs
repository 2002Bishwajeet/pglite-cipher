// Throwaway spike code (issue #47): runs the bench page's on-demand parts (part.ts) headless in
// Playwright with a persistent profile (WebKit refuses OPFS in an ephemeral one), and answers the
// page's window.__odProbe(label) with the RSS of the browser's processes 3 s later, as
// bench/opfs-memory.mjs measures it. Rebuilds bench/dist first.
// Usage: node spike/on-demand/run.mjs [chromium] [firefox] [webkit] [--mb 100] [--parts ondemand,...]
// Writes spike/results/on-demand/<browser>-<platform>.json (remote.sh copies spike/results back).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import * as playwright from 'playwright';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args.splice(i, 2)[1];
};
const mb = Number(opt('mb', '100'));
const parts = opt('parts', 'ondemand,ondemand-aes,ondemand-idb,ondemand-handles').split(',');
const browsers = args.length > 0 ? args : ['chromium', 'firefox'];
const config = fileURLToPath(new URL('../../bench/vite.config.ts', import.meta.url));
const out = new URL('../results/on-demand/', import.meta.url);
const PART_TIMEOUT = 45 * 60 * 1000;
mkdirSync(out, { recursive: true });

// RSS (KB) of the processes this run started: descendants of this process, plus Playwright's
// browser processes that launchd adopted (WebKit's WebContent on macOS).
function rssKb() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), cmd: m[4] }));
  const mine = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (!mine.has(r.pid) && mine.has(r.ppid)) {
        mine.add(r.pid);
        grew = true;
      }
    }
  }
  mine.delete(process.pid);
  return rows.filter((r) => mine.has(r.pid) || (r.ppid === 1 && r.cmd.includes('ms-playwright'))).reduce((a, r) => a + r.rss, 0);
}

await build({ configFile: config, logLevel: 'warn' });
const server = await preview({ configFile: config, logLevel: 'warn' });
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:47900/';
let failed = false;
try {
  for (const name of browsers) {
    const profile = mkdtempSync(join(tmpdir(), 'pc47-'));
    const context = await playwright[name].launchPersistentContext(profile, { headless: true });
    const result = { browser: name, platform: platform(), mb, measuredAt: new Date().toISOString(), parts: {} };
    try {
      for (const part of parts) {
        const page = await context.newPage();
        let baseKb = 0;
        await page.exposeFunction('__odProbe', async (label) => {
          await new Promise((r) => setTimeout(r, 3000));
          const kb = rssKb();
          if (label === 'baseline') baseKb = kb;
          return { label, rssKb: kb, overBaselineKb: kb - baseKb };
        });
        page.on('console', (m) => {
          if (m.text().startsWith('[bench]') || m.type() === 'error') console.log(`${new Date().toISOString().slice(11, 19)} [${name}] ${m.text()}`);
        });
        page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
        await page.goto(`${base}?auto=1&parts=${part}&runs=1&odmb=${String(mb)}`);
        await page.waitForFunction(() => window.__benchResult || window.__benchError, undefined, { timeout: PART_TIMEOUT, polling: 1000 });
        const { value, error } = await page.evaluate((p) => ({ value: window.__benchResult?.[p], error: window.__benchError }), part);
        await page.close();
        result.parts[part] = value ?? { error: String(error) };
        if (!value || value.error) failed = true;
        writeFileSync(new URL(`${name}-${platform()}.json`, out), `${JSON.stringify(result, null, 2)}\n`);
        console.log(`[${name}] ${part} saved`);
      }
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
