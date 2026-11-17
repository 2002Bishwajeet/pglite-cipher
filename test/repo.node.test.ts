// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('repository invariants', () => {
  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('runs every CI job on a GitHub-hosted Ubuntu runner and never on pull_request_target', () => {
    const workflow = read('.github/workflows/ci.yml');
    const jobs = /^jobs:\n([\s\S]*)$/m.exec(workflow)?.[1] ?? '';
    const jobCount = jobs.match(/^ {2}[\w-]+:$/gm)?.length ?? 0;
    expect(jobCount).toBeGreaterThan(0);
    expect(jobs.match(/^ {4}runs-on: ubuntu-latest$/gm)?.length ?? 0).toBe(jobCount);
    expect(workflow).not.toContain('pull_request_target');
  });

  // A public repository must not run fork pull requests on self-hosted machines.
  it('keeps every workflow off self-hosted runners', () => {
    const dir = new URL('../.github/workflows/', import.meta.url);
    for (const file of readdirSync(dir)) {
      const runsOn = read(`.github/workflows/${file}`).match(/^ +runs-on: .*$/gm) ?? [];
      expect(runsOn.length, file).toBeGreaterThan(0);
      for (const line of runsOn) expect(line, file).not.toContain('self-hosted');
    }
  });

  it('puts the licence header on every code file', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(ts|mjs|js|cjs|html)$/.test(f) && !f.startsWith('bench/results/'));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const head = read(file).slice(0, 400);
      expect(head, file).toContain('Copyright 2026 Bishwajeet Parhi');
      expect(head, file).toContain('SPDX-License-Identifier: FSL-1.1-ALv2');
    }
  });

  it('publishes the version the code reports, and only the built package', async () => {
    const pkg = JSON.parse(read('package.json')) as { version: string; private?: boolean; files: string[] };
    const { VERSION } = await import('../src/index.ts');
    expect(VERSION).toBe(pkg.version);
    expect(pkg.private).toBeUndefined();
    expect(pkg.files).toContain('dist');
    expect(pkg.files.filter((f) => /^(test|bench|scripts|docs)\b/.test(f))).toEqual([]);
  });

  it('gives every CI job a timeout-minutes', () => {
    const jobs = /^jobs:\n([\s\S]*)$/m.exec(read('.github/workflows/ci.yml'))?.[1] ?? '';
    const jobCount = jobs.match(/^ {2}[\w-]+:$/gm)?.length ?? 0;
    expect(jobCount).toBeGreaterThan(0);
    expect(jobs.match(/^ {4}timeout-minutes: \d+$/gm)?.length ?? 0).toBe(jobCount);
  });
});
