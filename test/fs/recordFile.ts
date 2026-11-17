// A whole store in one file for test/fixtures: per record u8 key length ‖ key (ASCII "0", "1", "2" or 32-hex id) ‖ u32 big-endian value length ‖ value.
import type { RecordKey } from '../../src/backend/backend.ts';

export function encodeRecords(recs: Map<RecordKey, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [key, value] of recs) {
    const name = new TextEncoder().encode(String(key));
    const head = new Uint8Array(1 + name.length + 4);
    head[0] = name.length;
    head.set(name, 1);
    new DataView(head.buffer).setUint32(1 + name.length, value.length);
    parts.push(head, value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function decodeRecords(file: Uint8Array): Map<RecordKey, Uint8Array> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const out = new Map<RecordKey, Uint8Array>();
  for (let at = 0; at < file.length; ) {
    const n = file[at] as number;
    const name = new TextDecoder().decode(file.subarray(at + 1, at + 1 + n));
    const length = view.getUint32(at + 1 + n);
    const start = at + 1 + n + 4;
    if (start + length > file.length) throw new RangeError('the record file is cut short');
    out.set(name === '0' || name === '1' || name === '2' ? (Number(name) as 0 | 1 | 2) : name, file.slice(start, start + length));
    at = start + length;
  }
  return out;
}
