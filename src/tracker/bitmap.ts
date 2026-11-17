// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
/** A set of block indexes, one bit each: 16 KB for a 1 GB file of 8 KB blocks. */
export class BlockBitmap {
  #words = new Uint32Array(0);
  #empty = true;

  get isEmpty(): boolean {
    return this.#empty;
  }

  add(from: number, to: number): void {
    if (from >= to) return;
    const need = ((to - 1) >>> 5) + 1;
    if (need > this.#words.length) {
      const grown = new Uint32Array(Math.max(need, this.#words.length * 2));
      grown.set(this.#words);
      this.#words = grown;
    }
    const words = this.#words;
    for (let i = from; i < to; ) {
      const bit = i & 31;
      const n = Math.min(32 - bit, to - i);
      const mask = n === 32 ? 0xffffffff : ((1 << n) - 1) << bit;
      words[i >>> 5] = (words[i >>> 5] ?? 0) | mask;
      i += n;
    }
    this.#empty = false;
  }

  indexes(limit: number): number[] {
    const out: number[] = [];
    const words = this.#words;
    const end = Math.min(words.length, Math.ceil(limit / 32));
    for (let w = 0; w < end; w++) {
      let word = words[w] ?? 0;
      while (word !== 0) {
        const bit = 31 - Math.clz32(word & -word);
        const index = w * 32 + bit;
        if (index >= limit) return out;
        out.push(index);
        word &= word - 1;
      }
    }
    return out;
  }

  clear(): void {
    this.#words = new Uint32Array(0);
    this.#empty = true;
  }
}
