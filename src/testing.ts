// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
// Test hooks, exported as `pglite-cipher/testing`. Never for production use: the random source
// in particular makes every nonce and salt predictable.
export { setRandomSource } from './format/bytes.ts';
export { setSubkeyMaxEncryptions } from './format/keys.ts';
export { resetSelfTest } from './format/selfTest.ts';
export { FaultyBackend, InjectedFault, type FaultPlan } from './backend/faulty.ts';
