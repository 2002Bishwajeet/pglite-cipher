// Reads the repository itself, so it runs in Node only.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('repository invariants', () => {
  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('runs every CI job on a self-hosted runner: pc-ci, browser jobs on pc-ci-heavy, WebKit on yantra-box', () => {
    const workflow = read('.github/workflows/ci.yml');
    const jobs = /^jobs:\n([\s\S]*)$/m.exec(workflow)?.[1] ?? '';
    const jobCount = jobs.match(/^ {2}[\w-]+:$/gm)?.length ?? 0;
    const anyFree = jobs.match(/^ {4}runs-on: \[self-hosted, pc-ci\]$/gm)?.length ?? 0;
    const webkitOnBox =
      jobs.match(/^ {4}runs-on: \$\{\{ matrix\.(browser|project) == 'webkit' && fromJSON\('\["self-hosted", "yantra-box"\]'\) \|\| fromJSON\('\["self-hosted", "pc-ci-heavy"\]'\) \}\}$/gm)?.length ?? 0;
    expect(jobCount).toBeGreaterThan(0);
    expect(anyFree + webkitOnBox).toBe(jobCount);
    expect(workflow).not.toContain('pull_request_target');
  });

  it('keeps every workflow on self-hosted runners', () => {
    const dir = new URL('../.github/workflows/', import.meta.url);
    for (const file of readdirSync(dir)) {
      const runsOn = read(`.github/workflows/${file}`).match(/^ +runs-on: .*$/gm) ?? [];
      expect(runsOn.length, file).toBeGreaterThan(0);
      for (const line of runsOn) expect(line, file).toContain('self-hosted');
    }
  });

  it('gives every CI job a timeout-minutes', () => {
    const jobs = /^jobs:\n([\s\S]*)$/m.exec(read('.github/workflows/ci.yml'))?.[1] ?? '';
    const jobCount = jobs.match(/^ {2}[\w-]+:$/gm)?.length ?? 0;
    expect(jobCount).toBeGreaterThan(0);
    expect(jobs.match(/^ {4}timeout-minutes: \d+$/gm)?.length ?? 0).toBe(jobCount);
  });
});
