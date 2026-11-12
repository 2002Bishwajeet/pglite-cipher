// Property: the same random sequence of batches leaves MemoryBackend and IndexedDbBackend with the
// same contents, and each batch succeeds or fails the same way on both.
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import type { CommitBatch, RecordKey, StorageBackend } from '../../src/backend/backend.ts';
import { testBlockId, testValue } from '../../src/backend/conformance.ts';
import { IndexedDbBackend } from '../../src/backend/indexeddb.ts';
import { MemoryBackend } from '../../src/backend/memory.ts';
import { freshName } from './names.ts';

const RUNS = 40;

// A small key universe, so puts, deletes and root checks collide often.
const key: fc.Arbitrary<RecordKey> = fc.oneof(
  fc.constantFrom<RecordKey>(0, 1, 2),
  fc.integer({ min: 0, max: 11 }).map(testBlockId),
);
const value = fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 40 })).map(([n, len]) => testValue(n, len));

type Step = Omit<CommitBatch, 'expectRoot'> & { root: 'none' | 'absent' | 'current' | 'wrong' };
const step: fc.Arbitrary<Step> = fc.record({
  puts: fc.array(fc.tuple(key, value), { maxLength: 6 }),
  deletes: fc.array(key, { maxLength: 4 }),
  durability: fc.constantFrom('relaxed' as const, 'strict' as const),
  root: fc.constantFrom('none' as const, 'absent' as const, 'current' as const, 'wrong' as const),
});

const contents = async (b: StorageBackend) => ({
  slots: await Promise.all([b.get(0), b.get(1), b.get(2)]),
  blocks: await b.readRange(null, 100),
  count: await b.count(),
  empty: await b.isEmpty(),
});

const outcome = (p: Promise<void>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof Error ? e.name : 'unknown'),
  );

describe('MemoryBackend and IndexedDbBackend agree', () => {
  it('random batch sequences leave identical contents', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        const memory = new MemoryBackend();
        const idb = new IndexedDbBackend(freshName());
        try {
          for (const { root, ...rest } of steps) {
            const current = await memory.get(2);
            const expectRoot =
              root === 'none' ? undefined : root === 'absent' ? null : root === 'current' ? (current ?? null) : testValue(99);
            const batch: CommitBatch = expectRoot === undefined ? rest : { ...rest, expectRoot };
            expect(await outcome(idb.commit(batch))).toBe(await outcome(memory.commit(batch)));
            expect(await contents(idb)).toEqual(await contents(memory));
          }
        } finally {
          await idb.clear();
          await idb.close();
        }
      }),
      { numRuns: RUNS },
    );
  });
});
