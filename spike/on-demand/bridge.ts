// Throwaway spike code (issue #47): the layout of the bridge's SharedArrayBuffer, shared by the PG
// worker (fs.ts, the synchronous side) and the IO worker (io-worker.ts, which owns the OPFS files).
// One request at a time: the PG worker fills the header (and the data area for a write), rings the
// IO worker's MessagePort and blocks in Atomics.wait on STATE; the IO worker answers through the
// data area, stores RESULT and STATE = 1, and calls Atomics.notify.

/** Container block size: one Postgres page. */
export const BLOCK = 8192;
/** The most bytes one round trip moves; longer reads and writes take several. */
export const CHUNK = 256 * 1024;
/** Int32 slots of the header. The container offset is OFF_BLOCK * BLOCK + OFF_IN, so it fits Int32 Atomics. */
export const STATE = 0;
export const OP = 1;
export const LEN = 2;
export const OFF_BLOCK = 3;
export const OFF_IN = 4;
/** Bytes moved, or a negative errno. */
export const RESULT = 5;
export const HEADER_INTS = 8;
export const HEADER_BYTES = HEADER_INTS * 4;
export const SAB_BYTES = HEADER_BYTES + CHUNK;

export const OP_READ = 1;
export const OP_WRITE = 2;

/** Emscripten's EIO; PGlite's ERRNO_CODES does not list it. */
export const EIO = 29;
