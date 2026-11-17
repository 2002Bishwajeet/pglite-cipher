// Every project: a long run (CIPHER_LONG=1) uses one fast-check seed, printed by vitest.config.ts,
// so a failure can be repeated with CIPHER_SEED.
import fc from 'fast-check';
import { inject } from 'vitest';

if (inject('long')) fc.configureGlobal({ seed: inject('seed') });
