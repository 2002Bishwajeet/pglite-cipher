// Runs the vitest browser projects. With no --project it runs chromium, firefox and webkit;
// with --project it runs only those, so `npm run test:browser -- --project chromium` works.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const hasProject = args.some((a) => a === '--project' || a.startsWith('--project='));
const projects = hasProject ? [] : ['chromium', 'firefox', 'webkit'].flatMap((p) => ['--project', p]);
const { status } = spawnSync('npx', ['vitest', 'run', ...projects, ...args], { stdio: 'inherit' });
process.exit(status ?? 1);
