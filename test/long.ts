// The CIPHER_LONG=1 switch (`npm run test:long`, the nightly workflow): longer fuzz, property,
// crash and soak runs, in Node and in the browsers. Without it every budget is what it was.
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** CIPHER_LONG=1. */
    long: boolean;
    /** The fast-check seed of a long run (CIPHER_SEED repeats one), printed when the run starts. */
    seed: number;
    /** CIPHER_SOAK_MINUTES, 30 by default. */
    soakMinutes: number;
    /** CIPHER_COMPAT_WRITE=1: test/fs/compat.test.ts writes this engine's store. */
    compatWrite: boolean;
    /** CIPHER_COMPAT_READ=webkit,chromium: the engines whose stores test/fs/compat.test.ts opens. */
    compatRead: string[];
  }
}

export const LONG = inject('long');

/** fast-check runs: × 25 under CIPHER_LONG. */
export const runs = (n: number): number => (LONG ? n * 25 : n);

/** A test timeout, × `factor` under CIPHER_LONG (for a test whose budget grows that much). */
export const timeout = (ms: number, factor = 25): number => (LONG ? ms * factor : ms);
