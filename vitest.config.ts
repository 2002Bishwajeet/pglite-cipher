import { realpathSync } from 'node:fs';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// CIPHER_LONG=1 raises the budgets of the long suites (test/long.ts); the rest are its knobs.
const long = process.env.CIPHER_LONG === '1';
// vitest loads this file more than once: the first load draws the seed and the others inherit it.
if (long && process.env.CIPHER_SEED === undefined) {
  process.env.CIPHER_SEED = String(Math.floor(Math.random() * 2 ** 31));
  console.log(`CIPHER_LONG=1, fast-check seed ${process.env.CIPHER_SEED} (CIPHER_SEED=${process.env.CIPHER_SEED} repeats it)`);
}
const seed = Number(process.env.CIPHER_SEED ?? 0);

const shared = {
  include: ['test/**/*.test.ts'],
  provide: {
    long,
    seed,
    soakMinutes: Number(process.env.CIPHER_SOAK_MINUTES ?? 30),
    compatWrite: process.env.CIPHER_COMPAT_WRITE === '1',
    compatRead: (process.env.CIPHER_COMPAT_READ ?? '').split(',').filter(Boolean),
  },
};

// PGlite loads .wasm and .data files and uses SharedArrayBuffer-dependent features in some
// builds, so the browser server is cross-origin isolated.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// node_modules may be a symlink (shared between git worktrees); vite refuses to serve files
// outside its allow list, and PGlite's .wasm/.data would come back as small error pages.
const allow = [process.cwd(), realpathSync('node_modules')];

const browserProject = (browser: 'chromium' | 'firefox' | 'webkit') => ({
  extends: true as const,
  server: { headers: isolation, fs: { allow } },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  test: {
    ...shared,
    name: browser,
    setupFiles: ['test/setup.ts'],
    // Tests that read the repository (node:fs) are Node-only; the perf gates run in Chromium only.
    exclude: ['test/**/*.node.test.ts', ...(browser === 'chromium' ? [] : ['test/perf/**'])],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser }],
    },
  },
});

export default defineConfig({
  test: {
    // Most test files start PGlite, at about 1 GB each (a worker, or a browser page): the default
    // of one per core runs a 16 GB machine out of memory.
    maxWorkers: 4,
    // A long run multiplies the budgets of tests that keep vitest's default timeout.
    ...(long ? { testTimeout: 3_600_000 } : {}),
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: 'node',
          environment: 'node',
          // *.browser.test.ts files run in a browser only.
          exclude: ['test/**/*.browser.test.ts'],
          setupFiles: ['test/setup.node.ts', 'test/setup.ts'],
        },
      },
      browserProject('chromium'),
      browserProject('firefox'),
      browserProject('webkit'),
    ],
  },
});
