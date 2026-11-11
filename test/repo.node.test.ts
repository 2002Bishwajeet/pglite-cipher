// Reads the repository itself, so it runs in Node only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('repository invariants', () => {
  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('runs every CI job on the self-hosted yantra-box runner', () => {
    const workflow = read('.github/workflows/ci.yml');
    const jobs = /^jobs:\n([\s\S]*)$/m.exec(workflow)?.[1] ?? '';
    const jobCount = jobs.match(/^ {2}[\w-]+:$/gm)?.length ?? 0;
    const runsOn = jobs.match(/^ {4}runs-on: \[self-hosted, yantra-box\]$/gm)?.length ?? 0;
    expect(jobCount).toBeGreaterThan(0);
    expect(runsOn).toBe(jobCount);
    expect(workflow).not.toContain('pull_request_target');
  });
});
