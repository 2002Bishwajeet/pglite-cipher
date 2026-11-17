// Builds the bench page to bench/dist, cross-origin isolated (PGlite and measureUserAgentSpecificMemory need it).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export const BENCH_PORT = 47900;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  server: { headers },
  preview: { headers, host: '127.0.0.1', port: BENCH_PORT, strictPort: true },
});
