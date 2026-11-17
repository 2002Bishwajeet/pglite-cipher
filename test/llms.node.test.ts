// llms-full.txt is read by coding agents: every exported name it mentions must really be exported.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Type-only exports leave nothing at runtime; read them from the index source.
const typeExports = new Set(
  [...read('src/index.ts').matchAll(/\btype ([A-Z]\w+)/g), ...read('src/index.ts').matchAll(/export type \{([^}]+)\}/g)]
    .flatMap((m) => (m[1] ?? '').split(','))
    .map((name) => name.trim())
    .filter(Boolean),
);

describe('llms-full.txt', () => {
  const text = read('llms-full.txt');

  it('names only exports that exist', () => {
    // Backticked identifiers that look like package exports: PascalCase names and the two functions.
    const named = new Set(
      [...text.matchAll(/`([A-Z][A-Za-z]+(?:Error|Fs|Backend|Options|Stats|Mode|Progress|Result|Size)|importKek|verifyStore|VERSION|FORMAT_VERSION)\b/g)].map(
        (m) => m[1] as string,
      ),
    );
    expect(named.size).toBeGreaterThan(10);
    for (const name of named) expect(name in api || typeExports.has(name), name).toBe(true);
  });

  it('names every error the package exports', () => {
    for (const name of Object.keys(api).filter((n) => n.endsWith('Error'))) expect(text, name).toContain(`\`${name}\``);
  });

  it('is linked from llms.txt', () => {
    expect(read('llms.txt')).toContain('llms-full.txt');
  });
});
