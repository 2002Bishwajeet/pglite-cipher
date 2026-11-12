// Test hooks, exported as `pglite-cipher/testing`. Never for production use: the random source
// in particular makes every nonce and salt predictable.
export { setRandomSource } from './format/bytes.ts';
export { setSubkeyMaxEncryptions } from './format/keys.ts';
export { resetSelfTest } from './format/selfTest.ts';
