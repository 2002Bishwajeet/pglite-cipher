// Runs the benchmark page headless in Playwright's browsers and saves what it reports to
// bench/results/<browser>.json (merged per part, so parts can run apart).
// Usage: node bench/run.mjs [chromium] [firefox] [webkit] [--parts gates10,gates100,extras,year,ops] [--runs 20] [--throttle 4] [--block 262144] [--pack 8]
// --throttle N (Chromium only) slows the page's CPU N times through CDP and saves to <browser>-throttle<N>.json.
// --block N builds the gates' encrypted store with N-byte blocks (#63) and saves to <browser>-block<N>.json.
// --pack N stores N blocks per IndexedDB record (#83; needs bench/patches/pack.patch) and saves to <browser>-pack<N>.json.
// Builds bench/dist first if it is missing. WebKit on the Linux host: scripts/harness/webkit.sh node bench/run.mjs webkit
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import * as playwright from 'playwright';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args.splice(i, 2)[1];
};
const parts = opt('parts', 'gates10,gates100,extras,year').split(',');
const runs = Number(opt('runs', '20'));
const throttle = Number(opt('throttle', '1'));
const block = opt('block', '');
const pack = opt('pack', '');
const browsers = args.length > 0 ? args : ['chromium', 'firefox', 'webkit'];
const config = fileURLToPath(new URL('./vite.config.ts', import.meta.url));
const results = new URL('./results/', import.meta.url);
const PART_TIMEOUT = 60 * 60 * 1000;

if (!existsSync(new URL('./dist/index.html', import.meta.url))) await build({ configFile: config, logLevel: 'warn' });
const server = await preview({ configFile: config, logLevel: 'warn' });
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:47900/';
mkdirSync(results, { recursive: true });

let failed = false;
try {
  for (const name of browsers) {
    const slow = throttle > 1 && name === 'chromium';
    const file = new URL(`${name}${slow ? `-throttle${String(throttle)}` : ''}${block ? `-block${block}` : ''}${pack ? `-pack${pack}` : ''}.json`, results);
    const merged = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { browser: name, parts: {} };
    // Without the flag Chromium buckets performance.memory (G3); headless has no measureUserAgentSpecificMemory.
    const launchArgs = name === 'chromium' ? ['--enable-precise-memory-info'] : [];
    const browser = await playwright[name].launch({ headless: true, args: launchArgs });
    try {
      for (const part of parts) {
        const page = await browser.newPage();
        if (slow) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
        page.on('console', (m) => {
          if (m.text().startsWith('[bench]') || m.type() === 'error') console.log(`${new Date().toISOString().slice(11, 19)} [${name}] ${m.type()}: ${m.text()}`);
        });
        page.on('pageerror', (e) => {
          console.log(`[${name}] pageerror: ${e.message}`);
        });
        await page.goto(`${base}?auto=1&parts=${part}&runs=${String(runs)}${block ? `&block=${block}` : ''}${pack ? `&pack=${pack}` : ''}`);
        await page.waitForFunction(() => window.__benchResult || window.__benchError, undefined, { timeout: PART_TIMEOUT, polling: 1000 });
        const { result, error } = await page.evaluate(() => ({ result: window.__benchResult, error: window.__benchError }));
        await page.close();
        if (error || !result) throw new Error(`${name} ${part}: ${String(error)}`);
        const { [part]: value, ...meta } = result;
        if (value && typeof value === 'object' && 'error' in value) failed = true;
        merged.userAgent = meta.userAgent;
        merged.parts[part] = { ...value, measuredAt: meta.finishedAt, runs };
        writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
        console.log(`[${name}] ${part} saved to ${fileURLToPath(file)}`);
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
