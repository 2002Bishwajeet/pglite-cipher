import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BlockBitmap } from '../../src/tracker/bitmap.ts';
import { inBrowser } from './harness.ts';
import { runs } from '../long.ts';

describe('BlockBitmap', () => {
  it('holds the same indexes as a Set across word boundaries', () => {
    const range = fc.tuple(fc.nat({ max: 300 }), fc.nat({ max: 80 }));
    fc.assert(
      fc.property(fc.array(range, { maxLength: 20 }), fc.nat({ max: 400 }), (ranges, limit) => {
        const bitmap = new BlockBitmap();
        const set = new Set<number>();
        for (const [from, n] of ranges) {
          bitmap.add(from, from + n);
          for (let i = from; i < from + n; i++) set.add(i);
        }
        expect(bitmap.isEmpty).toBe(ranges.every(([, n]) => n === 0));
        expect(bitmap.indexes(limit)).toEqual([...set].filter((i) => i < limit).sort((a, b) => a - b));
        bitmap.clear();
        expect(bitmap.isEmpty).toBe(true);
        expect(bitmap.indexes(limit)).toEqual([]);
      }),
      { numRuns: runs(inBrowser ? 100 : 1000) },
    );
  });
});
