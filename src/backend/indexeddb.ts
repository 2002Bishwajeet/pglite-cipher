// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// The IndexedDB backend: one database named as given, one object store `kv`. Slots are number keys 0-2, blocks 32-char
// string keys; numbers sort before strings, so a range from "" holds blocks only.
import { StaleWriterError } from '../format/errors.ts';
import {
  invalidKey,
  isRecordKey,
  ROOT,
  rootMatches,
  type BlockId,
  type CommitBatch,
  type Slot,
  type StorageBackend,
} from './backend.ts';

const STORE = 'kv';

const BLOCKED_GRACE_MS = 2000;

const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDbBackend: request failed'));
    };
  });

export class IndexedDbBackend implements StorageBackend {
  readonly #name: string;
  #db: Promise<IDBDatabase> | null = null;
  #closed: string | null = null;

  /** `databaseName` is used as given: no prefix, suffix or version. */
  constructor(databaseName: string) {
    this.#name = databaseName;
  }

  /** The databases `<name>.a` and `<name>.b`, for `EncryptedFs`'s `backend: [a, b]`. */
  static pair(name: string): [IndexedDbBackend, IndexedDbBackend] {
    return [new IndexedDbBackend(`${name}.a`), new IndexedDbBackend(`${name}.b`)];
  }

  async isEmpty(): Promise<boolean> {
    return (await this.count()) === 0;
  }

  async count(): Promise<number> {
    const store = this.#transaction(await this.#database(), 'readonly').objectStore(STORE);
    return done(store.count());
  }

  async get(slot: Slot): Promise<Uint8Array | undefined> {
    const store = this.#transaction(await this.#database(), 'readonly').objectStore(STORE);
    return done(store.get(slot) as IDBRequest<Uint8Array | undefined>);
  }

  async getMany(ids: BlockId[]): Promise<Array<Uint8Array | undefined>> {
    if (ids.length === 0) return [];
    const store = this.#transaction(await this.#database(), 'readonly').objectStore(STORE);
    return Promise.all(ids.map((id) => done(store.get(id) as IDBRequest<Uint8Array | undefined>)));
  }

  async readRange(after: BlockId | null, limit: number): Promise<Array<[BlockId, Uint8Array]>> {
    // getAll treats a count of 0 as "no limit".
    if (limit < 1) return [];
    const store = this.#transaction(await this.#database(), 'readonly').objectStore(STORE);
    const range = IDBKeyRange.lowerBound(after ?? '', after !== null);
    const [keys, values] = await Promise.all([
      done(store.getAllKeys(range, limit) as IDBRequest<BlockId[]>),
      done(store.getAll(range, limit) as IDBRequest<Uint8Array[]>),
    ]);
    return keys.map((key, i): [BlockId, Uint8Array] => [key, values[i] as Uint8Array]);
  }

  async commit(batch: CommitBatch): Promise<void> {
    const db = await this.#database();
    // No await between opening the transaction and its last request: one would let it commit early.
    return new Promise((resolve, reject) => {
      const tx = this.#transaction(db, 'readwrite', batch.durability);
      const store = tx.objectStore(STORE);
      let failure: Error | null = null;
      const fail = (error: Error) => {
        failure = error;
        tx.abort();
      };
      tx.oncomplete = () => {
        resolve();
      };
      tx.onabort = () => {
        reject(failure ?? tx.error ?? new Error('IndexedDbBackend: the commit was aborted'));
      };
      const write = () => {
        try {
          for (const key of batch.deletes) {
            if (!isRecordKey(key)) throw invalidKey();
            store.delete(key);
          }
          for (const [key, value] of batch.puts) {
            if (!isRecordKey(key)) throw invalidKey();
            // A put clones the whole buffer behind a view, so partial views are copied; SharedArrayBuffer can't be cloned and is
            // undefined without cross-origin isolation, hence `instanceof ArrayBuffer`.
            const whole = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength && value.buffer instanceof ArrayBuffer;
            store.put(whole ? value : value.slice(), key);
          }
        } catch (error) {
          fail(error as Error);
        }
      };
      if (batch.expectRoot === undefined) {
        write();
        return;
      }
      const root = store.get(ROOT) as IDBRequest<Uint8Array | undefined>;
      root.onsuccess = () => {
        if (rootMatches(root.result, batch.expectRoot)) write();
        else fail(new StaleWriterError('commit: the root changed since this writer read it'));
      };
    });
  }

  async clear(): Promise<void> {
    const store = this.#transaction(await this.#database(), 'readwrite').objectStore(STORE);
    await done(store.clear());
  }

  /** Deletes the database; the next call recreates it empty. A connection open elsewhere delays the deletion. */
  async destroy(): Promise<void> {
    if (this.#closed !== null) throw new Error(this.#closed);
    const db = this.#db;
    this.#db = null;
    await db?.then(
      (open) => {
        open.close();
      },
      () => undefined,
    );
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.#name);
      let grace: ReturnType<typeof setTimeout> | undefined;
      request.onsuccess = () => {
        clearTimeout(grace);
        resolve();
      };
      // WebKit reports a blocked deletion while the just-closed connection is still closing, then deletes: wait. Records
      // are already cleared; a lingering connection delays the deletion past the grace period.
      request.onblocked = () => {
        clearTimeout(grace);
        grace = setTimeout(resolve, BLOCKED_GRACE_MS);
      };
      request.onerror = () => {
        clearTimeout(grace);
        reject(request.error ?? new Error('IndexedDbBackend: the database was not deleted'));
      };
    });
  }

  async close(): Promise<void> {
    this.#closed ??= 'IndexedDbBackend: the backend is closed';
    await this.#db?.then(
      (db) => {
        db.close();
      },
      () => undefined,
    );
  }

  async #database(): Promise<IDBDatabase> {
    const db = await this.#open();
    if (this.#closed !== null) throw new Error(this.#closed);
    return db;
  }

  #transaction(db: IDBDatabase, mode: IDBTransactionMode, durability?: 'relaxed' | 'strict'): IDBTransaction {
    if (durability === undefined) return db.transaction(STORE, mode);
    try {
      return db.transaction(STORE, mode, { durability });
    } catch (error) {
      // A browser that rejects the option: open without it.
      if (error instanceof TypeError) return db.transaction(STORE, mode);
      throw error;
    }
  }

  #open(): Promise<IDBDatabase> {
    if (this.#closed !== null) return Promise.reject(new Error(this.#closed));
    this.#db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another connection wants to delete or upgrade: step aside and refuse later calls rather than recreate it.
        db.onversionchange = () => {
          db.close();
          this.#closed = 'IndexedDbBackend: the database was deleted or upgraded by another connection';
        };
        db.onclose = () => {
          this.#closed = 'IndexedDbBackend: the browser closed the database';
        };
        resolve(db);
      };
      request.onerror = () => {
        this.#db = null; // a failed open is not cached: the next call tries again
        reject(request.error ?? new Error('IndexedDbBackend: the database did not open'));
      };
    });
    return this.#db;
  }
}
