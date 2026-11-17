// Spike #82 (bench only): OPFS read throughput, to set beside IndexedDB's, on the same
// device. About `mb` MB as sealed-size records (65580 B) are written once; each run then reads all of
// it back sequentially through three layouts: (a) one file per record, (b) segment files of 255
// records (about 16 MiB) read in 1 MiB slices, (c) the same segments through a
// FileSystemSyncAccessHandle in a worker. The page cannot drop the OS cache, so "cold" here means a
// fresh file or handle per read, not an empty page cache.
import { MB, errorText, now, pct, randomBytes, round, type Json } from './measure.ts';

const RECORD = 65580;
const PER_SEGMENT = 255;
const CHUNK = MB;
const WRITE_CHUNK = 64; // records held in memory while writing

async function writeFile(dir: FileSystemDirectoryHandle, name: string, records: number): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  for (let at = 0; at < records; at += WRITE_CHUNK) await w.write(randomBytes(Math.min(WRITE_CHUNK, records - at) * RECORD));
  await w.close();
}

async function readPerRecord(dir: FileSystemDirectoryHandle, count: number): Promise<number> {
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    const file = await (await dir.getFileHandle(`r${String(i)}`)).getFile();
    bytes += (await file.arrayBuffer()).byteLength;
  }
  return bytes;
}

async function readSegments(dir: FileSystemDirectoryHandle, segments: number): Promise<number> {
  let bytes = 0;
  for (let s = 0; s < segments; s++) {
    const file = await (await dir.getFileHandle(`s${String(s)}`)).getFile();
    for (let at = 0; at < file.size; at += CHUNK) bytes += (await file.slice(at, at + CHUNK).arrayBuffer()).byteLength;
  }
  return bytes;
}

/** Layout (c): a fresh worker per read, so no handle or buffer survives between runs. */
function readSync(dirs: string[], segments: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./opfsread-worker.ts', import.meta.url), { type: 'module' });
    let bytes = 0;
    worker.onmessage = (ev: MessageEvent<{ bytes?: number; done?: true; error?: string }>) => {
      const d = ev.data;
      if (d.error === undefined && !d.done) {
        bytes += d.bytes ?? 0;
        return;
      }
      worker.terminate();
      if (d.error !== undefined) reject(new Error(d.error));
      else resolve(bytes);
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(ev.message || 'worker failed'));
    };
    worker.postMessage({ dirs, names: Array.from({ length: segments }, (_, s) => `s${String(s)}`), chunk: CHUNK });
  });
}

async function timed(label: string, total: number, runs: number, log: (msg: string) => void, read: () => Promise<number>): Promise<Json> {
  const ms: number[] = [];
  for (let r = 0; r < runs; r++) {
    log(`opfsread ${label}, run ${String(r + 1)} of ${String(runs)}`);
    const t = now();
    const got = await read();
    ms.push(now() - t);
    if (got !== total) throw new Error(`opfsread ${label}: read ${String(got)} bytes of ${String(total)}`);
  }
  const p50 = pct(ms, 50);
  return { ms: round(p50), MBps: round(total / MB / (p50 / 1000)) };
}

export async function runOpfsRead(mb: number, runs: number, log: (msg: string) => void): Promise<Json> {
  if (typeof navigator.storage.getDirectory !== 'function') throw new Error('OPFS unavailable: navigator.storage.getDirectory is missing');
  if (typeof FileSystemFileHandle.prototype.createWritable !== 'function') throw new Error('OPFS unavailable: FileSystemFileHandle.createWritable is missing');
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
  } catch (e) {
    // Headless WebKit refuses OPFS on the page (it allows it in workers): record it, never a zero.
    return { unavailable: `navigator.storage.getDirectory() failed on the page: ${errorText(e)}` };
  }
  const name = `bench-opfsread-${crypto.randomUUID()}`;
  const count = Math.ceil((mb * MB) / RECORD);
  const total = count * RECORD;
  const segments = Math.ceil(count / PER_SEGMENT);
  const out: Json = { sizeMB: mb, recordBytes: RECORD, records: count, segments };
  const base = await root.getDirectoryHandle(name, { create: true });
  try {
    const perRecord = await base.getDirectoryHandle('rec', { create: true });
    const segs = await base.getDirectoryHandle('seg', { create: true });

    // One layout on disk at a time: Firefox's quota does not hold two copies of 300 MB.
    log(`opfsread: writing ${String(count)} record files`);
    let t = now();
    for (let i = 0; i < count; i++) await writeFile(perRecord, `r${String(i)}`, 1);
    out.writePerRecordMBps = round(total / MB / ((now() - t) / 1000));
    out.perRecordFiles = await timed('per-record files', total, runs, log, () => readPerRecord(perRecord, count));
    await base.removeEntry('rec', { recursive: true });

    log(`opfsread: writing ${String(segments)} segment files`);
    t = now();
    for (let s = 0; s < segments; s++) await writeFile(segs, `s${String(s)}`, Math.min(PER_SEGMENT, count - s * PER_SEGMENT));
    out.writeSegmentMBps = round(total / MB / ((now() - t) / 1000));
    out.segmentSlices = await timed('segments, getFile().slice()', total, runs, log, () => readSegments(segs, segments));
    try {
      out.syncHandleWorker = await timed('segments, sync handle in worker', total, runs, log, () => readSync([name, 'seg'], segments));
    } catch (e) {
      out.syncHandleWorker = { unavailable: errorText(e) };
    }
  } finally {
    await root.removeEntry(name, { recursive: true });
  }
  return out;
}
