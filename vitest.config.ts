import { realpathSync } from 'node:fs';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const shared = {
  include: ['test/**/*.test.ts'],
};

// PGlite loads .wasm and .data files and uses SharedArrayBuffer-dependent features in some
// builds, so the browser server is cross-origin isolated.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// node_modules may be a symlink (shared between harness worktrees); vite refuses to serve files
// outside its allow list, and PGlite's .wasm/.data would come back as small error pages.
const allow = [process.cwd(), realpathSync('node_modules')];

const browserProject = (browser: 'chromium' | 'firefox' | 'webkit') => ({
  extends: true as const,
  server: { headers: isolation, fs: { allow } },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  test: {
    ...shared,
    name: browser,
    // Tests that read the repository (node:fs) are Node-only.
    exclude: ['test/**/*.node.test.ts'],
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
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: 'node',
          environment: 'node',
          setupFiles: ['test/setup.node.ts'],
        },
      },
      browserProject('chromium'),
      browserProject('firefox'),
      browserProject('webkit'),
    ],
  },
});
