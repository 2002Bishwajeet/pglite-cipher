// A long run (CIPHER_LONG=1) uses one fast-check seed, printed by vitest.config.ts; CIPHER_SEED repeats it.
import fc from 'fast-check';
import { inject } from 'vitest';

if (inject('long')) fc.configureGlobal({ seed: inject('seed') });
