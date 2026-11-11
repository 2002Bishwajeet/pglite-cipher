// Spike (issue #2): the prototype filesystem round-trips a database through IndexedDB
// (fake-indexeddb in Node, the real one in browsers).
import { describe, expect, it } from 'vitest';
import { ProtoFS, deleteDb, importMasterKey } from './protoFs.ts';
import type { BlockSize } from './protoFs.ts';
import { SCHEMA, createPg, randomBytes, summarize } from './workload.ts';

const sizes: BlockSize[] = [8192, 32768, 65536];

describe('prototype filesystem', () => {
  for (const blockSize of sizes) {
    it(`write, sync, reopen at ${String(blockSize)}-byte blocks: row counts and blob checksum equal`, async () => {
      const name = `spike-proto-${String(blockSize)}-${crypto.randomUUID()}`;
      const key = await importMasterKey(crypto.getRandomValues(new Uint8Array(32)));
      try {
        let pg = await createPg(new ProtoFS({ name, key, blockSize }));
        await pg.exec(SCHEMA);
        const doc = crypto.randomUUID();
        for (let i = 0; i < 150; i++) {
          await pg.query('INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)', [doc, randomBytes(4096)]);
        }
        await pg.query(`INSERT INTO doc_search (doc_id, title, body) VALUES ($1, 'note', 'first body')`, [doc]);
        await pg.query(`INSERT INTO kv (key, value) VALUES ('a', '{"v":1}'), ('b', '{"v":2}')`);
        await pg.query('DELETE FROM doc_updates WHERE id % 5 = 0');
        await pg.exec('CHECKPOINT');
        const first = await summarize(pg);
        expect(first.counts).toEqual({ doc_updates: 120, doc_search: 1, kv: 2 });
        await pg.close();

        const second = new ProtoFS({ name, key, blockSize });
        pg = await createPg(second);
        expect(second.openStat?.fresh).toBe(false);
        expect(await summarize(pg)).toEqual(first);
        // A second session writes under a new salt; the third open needs both subkeys.
        await pg.query(`UPDATE doc_search SET body = 'second body' WHERE doc_id = $1`, [doc]);
        await pg.query('INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)', [doc, randomBytes(9000)]);
        const again = await summarize(pg);
        await pg.close();

        const third = new ProtoFS({ name, key, blockSize });
        pg = await createPg(third);
        expect(await summarize(pg)).toEqual(again);
        expect(third.openStat?.salts).toBe(2);
        const body = await pg.query<{ body: string }>('SELECT body FROM doc_search WHERE doc_id = $1', [doc]);
        expect(body.rows[0]?.body).toBe('second body');
        await pg.close();
      } finally {
        await deleteDb(name);
      }
    }, 300_000);
  }
});
