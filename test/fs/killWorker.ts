// The worker for worker.test.ts: opens the store in IndexedDB, reports what it holds, then inserts
// rows one strict transaction at a time, recording each before it starts and once it is durable,
// until it is terminated. The record is a write to a side IndexedDB database that completes before
// the worker goes on, not a message: terminate() can discard messages the page has not yet
// received, which would make the page's count of started rows lag the rows that exist.
import { PGlite } from '@electric-sql/pglite';
import { IndexedDbBackend } from '../../src/backend/indexeddb.ts';
import { EncryptedFs } from '../../src/encryptedFs.ts';
import { importKek } from '../../src/format/keys.ts';
import { openProgress, record } from './killProgress.ts';

export interface ToWorker {
  name: string;
  raw: Uint8Array<ArrayBuffer>;
}

export type FromWorker =
  | { type: 'opened'; n: number; max: number }
  | { type: 'error'; message: string };

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker) => {
  scope.postMessage(message);
};

scope.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  void (async () => {
    const { name, raw } = event.data;
    const progress = await openProgress(name);
    const fs = new EncryptedFs({ backend: new IndexedDbBackend(name), key: await importKek(raw), mode: 'open-or-create' });
    const pg = await PGlite.create({ fs });
    await pg.exec('CREATE TABLE IF NOT EXISTS t (id int PRIMARY KEY, v text NOT NULL)');
    const row = (await pg.query<{ n: number; max: number }>('SELECT count(*)::int AS n, coalesce(max(id), 0) AS max FROM t')).rows[0];
    const { n, max } = row ?? { n: -1, max: -1 };
    post({ type: 'opened', n, max });
    for (let id = n + 1; ; id++) {
      await record(progress, 'started', id);
      await pg.exec(`INSERT INTO t VALUES (${String(id)}, repeat(md5(${String(id)}::text), 16))`);
      await record(progress, 'acked', id);
    }
  })().catch((error: unknown) => {
    post({ type: 'error', message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  });
});
