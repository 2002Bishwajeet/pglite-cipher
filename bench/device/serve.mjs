// Throwaway spike code (issue #11): serves the built bench page (bench/dist) cross-origin isolated
// and collects what device runs send. `POST /result` takes the page's JSON plus a `target` name and
// merges it per part into bench/results/<target>.json; `POST /log` prints a progress line.
// Usage: node bench/device/serve.mjs [--port 47901] [--until target,...] [--timeout-min 170]
//        node bench/device/serve.mjs --self-test
// --until exits once every named target has posted: 0, or 1 if a result holds an error; 2 on timeout.
// No dependencies beyond Node. Build the page first: npm run bench:build.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const DIST = fileURLToPath(new URL('../../bench/dist/', import.meta.url));
const RESULTS = fileURLToPath(new URL('../results/', import.meta.url));
const META = ['userAgent', 'crossOriginIsolated', 'hardwareConcurrency', 'deviceMemory', 'runs', 'startedAt', 'finishedAt'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const HEADERS = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
const stamp = () => new Date().toISOString().slice(11, 19);

/** Merges one posted body into <dir>/<target>.json; returns whether it carries an error. */
function save(dir, body) {
  const { target, error, ...rest } = body;
  delete rest.partial;
  const file = join(dir, `${target}.json`);
  const merged = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { target, parts: {} };
  let failed = error !== undefined;
  if (failed) merged.error = error;
  for (const [k, v] of Object.entries(rest)) {
    if (META.includes(k)) merged[k] = v;
    else {
      merged.parts[k] = { ...v, measuredAt: rest.finishedAt, runs: rest.runs };
      if (v && typeof v === 'object' && 'error' in v) failed = true;
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return failed;
}

function serve({ port, dir, until, onDone }) {
  const pending = new Set(until);
  let failed = false;
  const server = createServer((req, res) => {
    const send = (code, body, type = 'text/plain') => {
      res.writeHead(code, { ...HEADERS, 'Content-Type': type });
      res.end(body);
    };
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/log') {
          console.log(`${stamp()} ${text.slice(0, 300)}`);
          return send(204, '');
        }
        if (req.url !== '/result') return send(404, 'not found');
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return send(400, 'not JSON');
        }
        if (typeof body?.target !== 'string' || !/^[a-z0-9-]{1,40}$/.test(body.target)) return send(400, 'bad target');
        const bad = save(dir, body);
        failed ||= bad;
        console.log(`${stamp()} ${body.target}: ${body.partial === true ? 'part saved' : `saved to ${join(dir, `${body.target}.json`)}`}${bad ? ' (with an error)' : ''}`);
        send(204, '');
        pending.delete(body.target);
        if (until.length > 0 && pending.size === 0) onDone(failed ? 1 : 0);
      });
      return;
    }
    const path = normalize(join(DIST, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)));
    const file = path.endsWith(sep) ? join(path, 'index.html') : path;
    if (!file.startsWith(DIST) || !existsSync(file)) return send(404, 'not found');
    send(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
  });
  server.listen(port, '127.0.0.1');
  return server;
}

async function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'pc-serve-'));
  try {
    const server = serve({ port: 0, dir, until: [], onDone: () => undefined });
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const post = (body) => fetch(`${base}/result`, { method: 'POST', body: JSON.stringify(body) });
    const sample = { target: 'self-test', userAgent: 'test', runs: 3, finishedAt: 'now', gates10: { sizeMB: 10 } };
    const checks = {
      'POST /result 204': (await post(sample)).status === 204,
      'second part merged': (await post({ ...sample, extras: { g6: {} }, gates10: undefined })).status === 204,
      'bad target 400': (await post({ ...sample, target: '../x' })).status === 400,
      'POST /log 204': (await fetch(`${base}/log`, { method: 'POST', body: 'self-test hello' })).status === 204,
      'COOP header': (await fetch(`${base}/missing`)).headers.get('cross-origin-opener-policy') === 'same-origin',
    };
    const saved = JSON.parse(readFileSync(join(dir, 'self-test.json'), 'utf8'));
    checks['partial post 204'] = (await post({ target: 'self-test', partial: true, finishedAt: 'later', ops: { a: 1 } })).status === 204;
    const saved2 = JSON.parse(readFileSync(join(dir, 'self-test.json'), 'utf8'));
    checks['partial merged, no partial field'] = saved2.parts.ops?.a === 1 && !('partial' in saved2) && !('partial' in saved2.parts.ops);
    checks['file written'] = saved.target === 'self-test' && saved.parts.gates10?.runs === 3 && 'extras' in saved.parts;
    server.close();
    const failedChecks = Object.entries(checks).filter(([, ok]) => !ok);
    console.log(failedChecks.length === 0 ? 'self-test passed' : `self-test failed: ${failedChecks.map(([k]) => k).join(', ')}`);
    return failedChecks.length === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (args.includes('--self-test')) process.exit(await selfTest());
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('bench/dist is missing: npm run bench:build');
  process.exit(1);
}
const port = Number(opt('port', '47901'));
const until = (opt('until', '') ?? '').split(',').filter(Boolean);
const server = serve({ port, dir: RESULTS, until, onDone: (code) => setTimeout(() => process.exit(code), 200) });
server.once('listening', () => {
  console.log(`${stamp()} bench page on http://localhost:${String(port)}/${until.length ? `, waiting for ${until.join(', ')}` : ''}`);
});
if (until.length > 0) {
  setTimeout(() => {
    console.error(`${stamp()} timed out waiting for ${until.join(', ')}`);
    process.exit(2);
  }, Number(opt('timeout-min', '170')) * 60_000);
}
