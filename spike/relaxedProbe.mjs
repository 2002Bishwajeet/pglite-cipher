// Spike (issue #2), electric-sql/pglite#1063: does a rejected background sync under
// relaxedDurability surface anywhere? Runs in its own Node process so that the unhandled
// rejection it provokes does not fail the test runner. Prints one JSON line.
import { MemoryFS, PGlite } from '@electric-sql/pglite';

class FailingFS extends MemoryFS {
  fail = false;
  calls = 0;
  async syncToFs() {
    this.calls++;
    await Promise.resolve();
    if (this.fail) throw new Error('probe: sync failed');
  }
}

const unhandled = [];
process.on('unhandledRejection', (e) => {
  unhandled.push(e instanceof Error ? e.message : String(e));
});
const fs = new FailingFS();
const pg = await PGlite.create({ fs, relaxedDurability: true });
fs.fail = true;
const errorOf = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
const queryError = await errorOf(() => pg.query('SELECT 1'));
await new Promise((r) => setTimeout(r, 50));
const syncError = await errorOf(() => pg.syncToFs());
await new Promise((r) => setTimeout(r, 50));
const failedCalls = fs.calls;
fs.fail = false;
await pg.close();
console.log(JSON.stringify({ queryError, syncError, failedSyncCalls: failedCalls, unhandledRejections: unhandled }));
