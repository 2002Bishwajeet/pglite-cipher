// Runs the vitest browser projects: chromium, firefox and webkit, or only the --project ones.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const hasProject = args.some((a) => a === '--project' || a.startsWith('--project='));
const projects = hasProject ? [] : ['chromium', 'firefox', 'webkit'].flatMap((p) => ['--project', p]);
const { status } = spawnSync('npx', ['vitest', 'run', ...projects, ...args], { stdio: 'inherit' });
process.exit(status ?? 1);
