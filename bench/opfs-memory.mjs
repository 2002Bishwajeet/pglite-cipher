// Research measurement for issue #43 (docs/research/opfs-on-demand.md): opens a plain PGlite
// database of --mb MB on idb:// and on opfs-ahp:// in a dedicated worker, headless, and records the
// wasm memory, the bytes MEMFS holds, the worker's JS heap (Chromium) and the browser processes'
// RSS against a baseline; also probes features, the sync access handle limit, and the latency of a
// synchronous read served by WebCrypto in a second worker through SharedArrayBuffer + Atomics.wait.
// Usage: node bench/opfs-memory.mjs [chromium] [firefox] [webkit] [--mb 100]
// Writes bench/results/opfs-memory/<browser>-<platform>.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as playwright from 'playwright';

const args = process.argv.slice(2);
const mbAt = args.indexOf('--mb');
const mb = mbAt < 0 ? 100 : Number(args.splice(mbAt, 2)[1]);
const browsers = args.length > 0 ? args : ['chromium'];
const out = new URL('./results/opfs-memory/', import.meta.url);
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
const settle = () => new Promise((r) => setTimeout(r, 3000));

const server = await createServer({
  configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 47910, fs: { strict: false } },
});
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:47910/';

try {
  for (const name of browsers) {
    const launchArgs = name === 'chromium' ? ['--enable-precise-memory-info', '--js-flags=--expose-gc'] : [];
    // A persistent profile: WebKit refuses OPFS in an ephemeral (private) context.
    const profile = mkdtempSync(join(tmpdir(), 'pc43-'));
    const context = await playwright[name].launchPersistentContext(profile, { headless: true, args: launchArgs });
    const result = { browser: name, mb, measuredAt: new Date().toISOString(), fs: {} };
    // Each section gets a fresh page (and so fresh workers) in one context, so storage carries over;
    // a call that hangs (a worker that failed to load) times out instead of stalling the run.
    const section = async (label, fn) => {
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
      const call = (w, op, a = {}, ms = 120_000) =>
        Promise.race([
          page.evaluate(([w, op, a]) => window.__opfs.call(w, op, a), [w, op, a]),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${String(ms)} ms`)), ms)),
        ]);
      try {
        await page.goto(`${base}opfs-memory.html`);
        await page.waitForFunction(() => window.__opfs);
        return await fn(call, page);
      } catch (e) {
        const error = e.message.split('\n')[0];
        console.log(`[${name}] ${label}: ${error}`);
        return { error };
      } finally {
        await page.close();
      }
    };
    try {
      result.features = await section('features', (call) => call('pg', 'features'));
      result.bridge = await section('bridge', (_, page) => page.evaluate(() => window.__opfs.bridge(1024, 2000)));
      console.log(`[${name}] features, bridge done`);

      for (const fs of ['idb', 'opfs-ahp']) {
        const dataDir = `${fs}://pc43`;
        const r = (result.fs[fs] = {});
        r.build = await section(`${fs} build`, (call) => call('pg', 'build', { dataDir, mb }, 900_000));
        if (r.build.error) continue;
        console.log(`[${name}] ${fs} built: ${JSON.stringify(r.build)}`);
        const opened = await section(`${fs} open`, async (call) => {
          await settle();
          r.baselineRssKb = rssKb();
          r.open = await call('pg', 'open', { dataDir });
          await settle();
          r.openRssDeltaKb = rssKb() - r.baselineRssKb;
          r.point = await call('pg', 'query', { sql: 'select length(payload) as n from t where id = 4242' });
          r.scan = await call('pg', 'query', { sql: 'select count(*)::int as rows, sum(length(payload))::bigint::text as bytes from t' }, 600_000);
          await settle();
          r.scanRssDeltaKb = rssKb() - r.baselineRssKb;
          await call('pg', 'close');
        });
        if (opened?.error) r.error = opened.error;
        console.log(`[${name}] ${fs}: ${JSON.stringify({ open: r.open, openRssDeltaKb: r.openRssDeltaKb, scanRssDeltaKb: r.scanRssDeltaKb })}`);
      }
      // Last: on WebKit, running out of handles can leave the origin's OPFS unusable for a while.
      result.handles = await section('handles', (call) => call('pg', 'handles', { n: 1100 }));
      console.log(`[${name}] handles: ${JSON.stringify(result.handles)}`);
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
    writeFileSync(new URL(`${name}-${platform()}.json`, out), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`[${name}] saved bench/results/opfs-memory/${name}-${platform()}.json`);
  }
} finally {
  await server.close();
}
process.exit(0);
