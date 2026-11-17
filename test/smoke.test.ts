// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2

import { MemoryFS, PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, VERSION } from '../src/index.ts';

describe('smoke', () => {
  it('exports the version constants', () => {
    expect(VERSION).toBe('0.1.0');
    expect(FORMAT_VERSION).toBe(1);
  });

  it('starts PGlite on MemoryFS and answers SELECT 1', async () => {
    const db = new PGlite({ fs: new MemoryFS() });
    try {
      const result = await db.query<{ one: number }>('SELECT 1 AS one');
      expect(result.rows).toEqual([{ one: 1 }]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('has AES-GCM, HKDF and wrapKey/unwrapKey in WebCrypto', async () => {
    const { subtle } = globalThis.crypto;
    const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));

    const kek = await subtle.importKey('raw', raw, 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
    const dek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
    const unwrapped = await subtle.unwrapKey('raw', wrapped, kek, { name: 'AES-GCM', iv }, 'AES-GCM', true, [
      'encrypt',
      'decrypt',
    ]);
    expect(new Uint8Array(await subtle.exportKey('raw', unwrapped))).toEqual(
      new Uint8Array(await subtle.exportKey('raw', dek)),
    );

    const hkdfKey = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const derived = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new Uint8Array([1]) },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, derived, new Uint8Array([1, 2, 3]));
    const opened = await subtle.decrypt({ name: 'AES-GCM', iv }, derived, sealed);
    expect(new Uint8Array(opened)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('IndexedDB orders number keys before string keys and answers a key-range getAll', async () => {
    const dbName = `smoke-${String(Math.random())}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(dbName, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('blocks');
      };
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(open.error ?? new Error('open failed'));
      };
    });
    try {
      const tx = db.transaction('blocks', 'readwrite');
      const store = tx.objectStore('blocks');
      store.put('s-b', 'b');
      store.put('n-2', 2);
      store.put('s-a', 'a');
      store.put('n-1', 1);
      store.put('s-c', 'c');
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error('tx failed'));
        };
      });

      const request = <T>(r: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          r.onsuccess = () => {
            resolve(r.result);
          };
          r.onerror = () => {
            reject(r.error ?? new Error('request failed'));
          };
        });
      const read = db.transaction('blocks', 'readonly').objectStore('blocks');
      expect(await request(read.getAllKeys())).toEqual([1, 2, 'a', 'b', 'c']);
      expect(await request(read.getAll(IDBKeyRange.bound('a', 'b')))).toEqual(['s-a', 's-b']);
    } finally {
      db.close();
      indexedDB.deleteDatabase(dbName);
    }
  });
});
