// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// CIPHER_LONG=1 raises the long suites' budgets (test/long.ts); the rest are its knobs.
const long = process.env.CIPHER_LONG === '1';
// Loaded more than once: the first load draws the seed, the others inherit it.
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

// Cross-origin isolated, for PGlite's SharedArrayBuffer.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// node_modules may be a symlink (worktrees); vite refuses to serve outside its allow list.
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
  // examples/ import the package by name, as an app would.
  resolve: { alias: { 'pglite-cipher': fileURLToPath(new URL('./src/index.ts', import.meta.url)) } },
  test: {
    // Each test file starts PGlite (~1 GB); one worker per core would OOM a 16 GB machine.
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
