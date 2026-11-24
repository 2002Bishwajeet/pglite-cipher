// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0
// CIPHER_LONG=1 (`npm run test:long`, nightly): longer fuzz, property, crash and soak runs.
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    long: boolean;
    /** The fast-check seed of a long run (CIPHER_SEED repeats one), printed when the run starts. */
    seed: number;
    /** CIPHER_SOAK_MINUTES, 30 by default. */
    soakMinutes: number;
    compatWrite: boolean;
    compatRead: string[];
  }
}

export const LONG = inject('long');

/** fast-check runs: × 25 under CIPHER_LONG. */
export const runs = (n: number): number => (LONG ? n * 25 : n);

/** A test timeout, × `factor` under CIPHER_LONG (for a test whose budget grows that much). */
export const timeout = (ms: number, factor = 25): number => (LONG ? ms * factor : ms);
