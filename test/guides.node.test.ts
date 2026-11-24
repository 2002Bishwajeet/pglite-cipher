// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// The guides' code samples may use only the public API: every name imported from the package and every
// `fs.` or `IndexedDbBackend.` member they call must exist.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.ts';

const dir = new URL('../docs/guides/', import.meta.url);
const guides = readdirSync(dir).filter((f) => f.endsWith('.md'));
const code = (file: string) => [...readFileSync(new URL(file, dir), 'utf8').matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');

describe('docs/guides', () => {
  it('has the five guides and an index', () => {
    expect(guides.sort()).toEqual(['README.md', 'errors.md', 'existing-app.md', 'keys.md', 'quick-start.md', 'rotation.md']);
  });

  for (const file of guides.filter((f) => f !== 'README.md')) {
    it(`${file} uses only the public API`, () => {
      const samples = code(file).join('\n');
      expect(samples.length, file).toBeGreaterThan(0);
      for (const m of samples.matchAll(/import \{([^}]+)\} from 'pglite-cipher'/g)) {
        for (const name of (m[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean)) expect(name in api, `${file}: ${name}`).toBe(true);
      }
      for (const m of samples.matchAll(/\bfs\.(\w+)\(/g)) expect(m[1] as string in api.EncryptedFs.prototype, `${file}: fs.${String(m[1])}`).toBe(true);
      for (const m of samples.matchAll(/\bIndexedDbBackend\.(\w+)\(/g)) expect(m[1] as string in api.IndexedDbBackend, `${file}: ${String(m[1])}`).toBe(true);
      for (const m of samples.matchAll(/\bbackend\.(\w+)\(/g)) expect(m[1] as string in api.IndexedDbBackend.prototype, `${file}: backend.${String(m[1])}`).toBe(true);
    });
  }

  it('makes no audit claim', () => {
    for (const file of guides) expect(readFileSync(new URL(file, dir), 'utf8'), file).not.toMatch(/\baudit(ed)?\b/i);
  });
});
