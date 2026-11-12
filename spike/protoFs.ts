// Throwaway spike code (issue #2): the smallest encrypted filesystem that can be timed.
// Packed layout: every block is a record of 44 + blockSize bytes (salt 16 | nonce 12 | ciphertext
// and tag) under a random 16-byte id (32 hex characters), overwritten in place for as long as the
// block exists. An in-memory file map is packed into file-table blocks of the same size; the root
// record under the number key 2 lists the table blocks' ids. A file's ids are stored as runs
// (fragments); its size and mode count only in its last fragment (the tail run), so a file that
// grows or shrinks rewrites the table block of its tail run and no other. No key wrapping, no header
// envelope, no digests, no error handling beyond throwing. Nothing here ships.
import { MemoryFS } from '@electric-sql/pglite';
import type { PGlite } from '@electric-sql/pglite';
import { PGDATA, hookMemfs, walk, withPreRun } from './memfs.ts';
import type { EmFs, FsNode, FsStream } from './memfs.ts';

export type BlockSize = 8192 | 32768 | 65536;
type Bytes = Uint8Array<ArrayBuffer>;

export const STORE = 'blocks';
const ROOT_KEY = 2;
const HEADER = 28; // salt 16 + nonce 12
const FRAG_FIXED = 38; // file id 16, path length 2, mode 4, size 8, start 4, count 4
const CONCURRENCY = 64;
const BATCH = 512;
const INFO = new TextEncoder().encode('pglite-cipher spike block key');
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const hex = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += HEX[x] ?? '';
  return s;
};
const unhexInto = (s: string, out: Uint8Array, at: number) => {
  for (let i = 0; i < 16; i++) out[at + i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
};
const random = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));
const randomId = () => hex(random(16));
const now = () => performance.now();

export async function pool<T>(items: readonly T[], fn: (item: T, index: number) => Promise<void>, n = CONCURRENCY): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

export const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => {
      resolve(r.result);
    };
    r.onerror = () => {
      reject(r.error ?? new Error('IndexedDB request failed'));
    };
  });

export const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });

export const openDb = (name: string): Promise<IDBDatabase> => {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore(STORE);
  };
  return req(r).then((db) => {
    db.onversionchange = () => {
      db.close();
    };
    return db;
  });
};

export const deleteDb = async (name: string): Promise<void> => {
  const r = indexedDB.deleteDatabase(name);
  r.onblocked = () => {
    console.warn(`[bench] deleteDatabase is blocked by an open connection: ${name}`);
  };
  await req(r);
};

/** HKDF base key from 32 raw bytes. */
export const importMasterKey = (raw: Bytes): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);

export const deriveSubkey = (master: CryptoKey, salt: Bytes): Promise<CryptoKey> =>
  crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, master, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);

const aad = (id16: Uint8Array | string, index: number): Bytes => {
  const a = new Uint8Array(24);
  if (typeof id16 === 'string') unhexInto(id16, a, 0);
  else a.set(id16);
  new DataView(a.buffer).setUint32(16, index >>> 0);
  return a;
};
const TABLE_INDEX = 0xffffffff;
const ROOT_AAD = aad(new Uint8Array(16), 0xfffffffe);

interface Entry {
  fileId: Bytes;
  path: string;
  mode: number;
  size: number;
  ids: string[];
  /** Ordered by start. The last one is the tail run, and only its size and mode count. */
  frags: Frag[];
  node?: FsNode;
}
interface Frag {
  entry: Entry;
  start: number;
  count: number;
  tb: TableBlock;
}
interface TableBlock {
  id: string;
  frags: Set<Frag>;
  used: number;
}

export interface SyncStat {
  ms: number;
  dataBlocks: number;
  tableBlocks: number;
  deleted: number;
  root: boolean;
  /** Files created, grown, shrunk, renamed or removed since the previous sync. */
  entries: number;
}

export interface OpenStat {
  fresh: boolean;
  fileMapMs: number;
  totalMs: number;
  tableBlocks: number;
  blocks: number;
  files: number;
  salts: number;
}

export interface ProtoOptions {
  name: string;
  key: CryptoKey;
  blockSize: BlockSize;
}

export class ProtoFS extends MemoryFS {
  readonly name: string;
  readonly bs: BlockSize;
  private readonly master: CryptoKey;
  private readonly salt = random(16);
  private readonly keys = new Map<string, Promise<CryptoKey>>();
  private db?: IDBDatabase;
  private fs?: EmFs;
  private loading = false;
  private structural = false;
  private readonly dirty = new Map<number, { node: FsNode; blocks: Set<number> }>();
  private readonly outside = new Set<number>();
  private readonly byIno = new Map<number, Entry>();
  private tbs: TableBlock[] = [];
  private tail: TableBlock | undefined;
  private readonly dirtyTbs = new Set<TableBlock>();
  private rootDirty = false;
  readonly syncStats: SyncStat[] = [];
  openStat?: OpenStat;
  /** performance.now() when initialSyncFs started (gate G2 starts here). */
  openStartedAt = 0;

  constructor(opts: ProtoOptions) {
    super();
    this.name = opts.name;
    this.bs = opts.blockSize;
    this.master = opts.key;
  }

  override async init(pg: PGlite, opts: Parameters<MemoryFS['init']>[1]) {
    const { emscriptenOpts } = await super.init(pg, opts);
    return {
      emscriptenOpts: withPreRun(emscriptenOpts, (fs) => {
        this.fs = fs;
        hookMemfs(fs, this.around);
      }),
    };
  }

  private key(salt: Bytes): Promise<CryptoKey> {
    const k = hex(salt);
    let p = this.keys.get(k);
    if (!p) {
      p = deriveSubkey(this.master, salt);
      this.keys.set(k, p);
    }
    return p;
  }

  private async seal(plain: Bytes, ad: Bytes): Promise<Bytes> {
    const key = await this.key(this.salt);
    const iv = random(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, plain);
    const out = new Uint8Array(HEADER + ct.byteLength);
    out.set(this.salt, 0);
    out.set(iv, 16);
    out.set(new Uint8Array(ct), HEADER);
    return out;
  }

  private async unseal(rec: Bytes, ad: Bytes): Promise<ArrayBuffer> {
    const key = await this.key(rec.slice(0, 16));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.subarray(16, HEADER), additionalData: ad }, key, rec.subarray(HEADER));
  }

  // ---- dirty-block tracking -------------------------------------------------------------------

  private isData(node: FsNode): boolean {
    if (this.byIno.has(node.id)) return true;
    if (this.outside.has(node.id) || !this.fs) return false;
    if (this.fs.getPath(node).startsWith(`${PGDATA}/`)) return true;
    this.outside.add(node.id);
    return false;
  }

  private mark(node: FsNode, lo: number, hi: number) {
    let d = this.dirty.get(node.id);
    if (!d) {
      d = { node, blocks: new Set() };
      this.dirty.set(node.id, d);
    }
    for (let i = lo; i < hi; i++) d.blocks.add(i);
  }

  private markWrite(node: FsNode, pos: number, len: number, oldSize: number) {
    if (len <= 0 || !this.isData(node)) return;
    const size = node.usedBytes;
    // An in-place write marks its own range; a write that changes the size marks from the old end.
    const from = size === oldSize ? pos : Math.min(pos, oldSize, size);
    const to = size === oldSize ? pos + len : Math.max(pos + len, size);
    this.mark(node, Math.floor(from / this.bs), Math.ceil(to / this.bs));
  }

  private markResize(node: FsNode, oldSize: number, size: number) {
    if (size === oldSize || !this.isData(node)) return;
    this.mark(node, Math.floor(Math.min(oldSize, size) / this.bs), Math.ceil(size / this.bs));
  }

  private readonly around = (name: string, args: unknown[], call: () => unknown): unknown => {
    if (this.loading) return call();
    switch (name) {
      case 'write': {
        const [stream, , , length, position] = args as [FsStream, Uint8Array, number, number, number];
        const old = stream.node.usedBytes;
        const result = call();
        this.markWrite(stream.node, position, length, old);
        return result;
      }
      case 'msync': {
        // msync writes the mapped range back at `offset`; treated as a write.
        const [stream, , offset, length] = args as [FsStream, Uint8Array, number, number];
        const old = stream.node.usedBytes;
        const result = call();
        this.markWrite(stream.node, offset, length, old);
        return result;
      }
      case 'setattr': {
        const [node, attr] = args as [FsNode, { size?: number }];
        if (attr.size === undefined) return call();
        const old = node.usedBytes;
        const result = call();
        this.markResize(node, old, attr.size);
        return result;
      }
      case 'rename':
        this.outside.delete((args[0] as FsNode).id);
        this.structural = true;
        return call();
      case 'mknod':
      case 'unlink':
      case 'rmdir':
      case 'symlink':
        this.structural = true;
        return call();
      default:
        return call();
    }
  };

  // ---- file table -----------------------------------------------------------------------------

  private get cap() {
    return this.bs - 4;
  }

  private fragBytes(f: Frag) {
    return FRAG_FIXED + utf8.encode(f.entry.path).length + 16 * f.count;
  }

  private unplace(e: Entry): TableBlock[] {
    const prev: TableBlock[] = [];
    for (const f of e.frags) {
      f.tb.frags.delete(f);
      f.tb.used -= this.fragBytes(f);
      this.dirtyTbs.add(f.tb);
      if (!prev.includes(f.tb)) prev.push(f.tb);
    }
    e.frags = [];
    return prev;
  }

  private pick(need: number, prefer: TableBlock[]): TableBlock {
    for (const tb of prefer) if (this.cap - tb.used >= need) return tb;
    if (this.tail && this.cap - this.tail.used >= need) return this.tail;
    const tb: TableBlock = { id: randomId(), frags: new Set(), used: 0 };
    this.tbs.push(tb);
    this.tail = tb;
    this.rootDirty = true;
    return tb;
  }

  /** Places the ids of `e` from `start` on in new fragments after its existing ones. */
  private place(e: Entry, prefer: TableBlock[], start = 0) {
    const fixed = FRAG_FIXED + utf8.encode(e.path).length;
    const total = e.ids.length;
    do {
      const tb = this.pick(fixed + (total > start ? 16 : 0), prefer);
      const count = Math.min(total - start, Math.floor((this.cap - tb.used - fixed) / 16));
      const f: Frag = { entry: e, start, count, tb };
      tb.frags.add(f);
      tb.used += fixed + 16 * count;
      e.frags.push(f);
      this.dirtyTbs.add(tb);
      start += count;
    } while (start < total);
  }

  /**
   * Fits the fragments of `e` to its id count after a size change: drops the runs past the end,
   * trims or extends the tail run in place, and spills what does not fit into new fragments. Writes
   * the tail run's table block (it holds the size) and only the blocks whose runs changed.
   */
  private retail(e: Entry) {
    const total = e.ids.length;
    let tail = e.frags[e.frags.length - 1];
    if (!tail) {
      this.place(e, []);
      return;
    }
    while (e.frags.length > 1 && tail.start >= total) {
      e.frags.pop();
      tail.tb.frags.delete(tail);
      tail.tb.used -= this.fragBytes(tail);
      this.dirtyTbs.add(tail.tb);
      tail = e.frags[e.frags.length - 1] ?? tail;
    }
    const end = tail.start + tail.count;
    if (end > total) {
      tail.tb.used -= 16 * (end - total);
      tail.count = total - tail.start;
    } else if (end < total) {
      const fit = Math.min(total - end, Math.floor((this.cap - tail.tb.used) / 16));
      tail.count += fit;
      tail.tb.used += 16 * fit;
      if (end + fit < total) this.place(e, [], end + fit);
    }
    this.dirtyTbs.add(tail.tb);
  }

  private encodeTable(tb: TableBlock): Bytes {
    const buf = new Uint8Array(this.bs);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, tb.frags.size);
    let off = 4;
    for (const f of tb.frags) {
      const e = f.entry;
      const path = utf8.encode(e.path);
      buf.set(e.fileId, off);
      dv.setUint16(off + 16, path.length);
      buf.set(path, off + 18);
      off += 18 + path.length;
      dv.setUint32(off, e.mode);
      dv.setFloat64(off + 4, e.size);
      dv.setUint32(off + 12, f.start);
      dv.setUint32(off + 16, f.count);
      off += 20;
      for (let i = 0; i < f.count; i++, off += 16) unhexInto(e.ids[f.start + i] ?? '', buf, off);
    }
    return buf;
  }

  private decodeTable(tb: TableBlock, plain: Uint8Array, files: Map<string, Entry>) {
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const n = dv.getUint32(0);
    let off = 4;
    for (let k = 0; k < n; k++) {
      const fileId = plain.slice(off, off + 16);
      const plen = dv.getUint16(off + 16);
      const path = fromUtf8.decode(plain.subarray(off + 18, off + 18 + plen));
      off += 18 + plen;
      const mode = dv.getUint32(off);
      const size = dv.getFloat64(off + 4);
      const start = dv.getUint32(off + 12);
      const count = dv.getUint32(off + 16);
      off += 20;
      const fid = hex(fileId);
      let e = files.get(fid);
      if (!e) {
        e = { fileId, path, mode, size, ids: [], frags: [] };
        files.set(fid, e);
      } else if (e.frags.every((g) => g.start <= start)) {
        e.size = size; // a later run: the tail run's size and mode count
        e.mode = mode;
      }
      for (let i = 0; i < count; i++, off += 16) e.ids[start + i] = hex(plain.subarray(off, off + 16));
      const f: Frag = { entry: e, start, count, tb };
      e.frags.push(f);
      tb.frags.add(f);
      tb.used += FRAG_FIXED + plen + 16 * count;
    }
  }

  private encodeRoot(): Bytes {
    const buf = new Uint8Array(4 + 16 * this.tbs.length);
    new DataView(buf.buffer).setUint32(0, this.tbs.length);
    this.tbs.forEach((tb, i) => {
      unhexInto(tb.id, buf, 4 + 16 * i);
    });
    return buf;
  }

  /**
   * Walks PGDATA: new and renamed entries go to `moved` (all their runs rewritten), a mode change
   * to `resized` (the tail run rewritten). Returns the number of entries removed.
   */
  private reconcile(moved: Set<Entry>, resized: Set<Entry>, removed: string[]): number {
    const fs = this.fs;
    if (!fs) throw new Error('not initialised');
    const seen = new Set<Entry>();
    let gone = 0;
    walk(fs, (path, node) => {
      if (fs.isLink(node.mode)) throw new Error('symlink in PGDATA: not supported by the prototype');
      let e = this.byIno.get(node.id);
      if (!e) {
        e = { fileId: random(16), path, mode: node.mode, size: 0, ids: [], frags: [] };
        this.byIno.set(node.id, e);
        moved.add(e);
        if (fs.isFile(node.mode)) this.mark(node, 0, Math.ceil(node.usedBytes / this.bs));
      } else if (e.path !== path) {
        e.path = path;
        moved.add(e);
      }
      if (e.mode !== node.mode) {
        e.mode = node.mode;
        resized.add(e);
      }
      seen.add(e);
    });
    for (const [ino, e] of this.byIno) {
      if (seen.has(e)) continue;
      this.byIno.delete(ino);
      removed.push(...e.ids);
      this.unplace(e);
      gone++;
    }
    return gone;
  }

  // ---- sync and open --------------------------------------------------------------------------

  override async syncToFs(): Promise<void> {
    const fs = this.fs;
    const db = this.db;
    if (this.loading || !fs || !db) return;
    const t0 = now();
    const removed: string[] = [];
    const moved = new Set<Entry>();
    const resized = new Set<Entry>();
    const gone = this.structural ? this.reconcile(moved, resized, removed) : 0;
    this.structural = false;

    // Copy every dirty block synchronously, before the first await.
    const jobs: { id: string; ad: Bytes; plain: Bytes }[] = [];
    for (const { node, blocks } of this.dirty.values()) {
      const e = this.byIno.get(node.id);
      if (!e || !fs.isFile(node.mode)) continue;
      const size = node.usedBytes;
      const nb = Math.ceil(size / this.bs);
      if (size !== e.size) {
        e.size = size;
        resized.add(e);
      }
      if (e.ids.length > nb) removed.push(...e.ids.splice(nb));
      while (e.ids.length < nb) e.ids.push(randomId());
      const contents = node.contents as Uint8Array;
      for (const i of blocks) {
        if (i >= nb) continue;
        const plain = new Uint8Array(this.bs);
        plain.set(contents.subarray(i * this.bs, Math.min(size, (i + 1) * this.bs)));
        jobs.push({ id: e.ids[i] ?? '', ad: aad(e.fileId, i), plain });
      }
    }
    this.dirty.clear();

    for (const e of moved) this.place(e, this.unplace(e));
    for (const e of resized) if (!moved.has(e)) this.retail(e);
    let tableBlocks = 0;
    for (const tb of this.dirtyTbs) {
      if (tb.frags.size === 0) {
        this.tbs = this.tbs.filter((t) => t !== tb);
        if (this.tail === tb) this.tail = this.tbs[this.tbs.length - 1];
        removed.push(tb.id);
        this.rootDirty = true;
        continue;
      }
      jobs.push({ id: tb.id, ad: aad(tb.id, TABLE_INDEX), plain: this.encodeTable(tb) });
      tableBlocks++;
    }
    this.dirtyTbs.clear();
    const rootPlain = this.rootDirty ? this.encodeRoot() : undefined;
    this.rootDirty = false;

    const records = new Array<Bytes>(jobs.length);
    await pool(jobs, async (j, i) => {
      records[i] = await this.seal(j.plain, j.ad);
    });
    const root = rootPlain ? await this.seal(rootPlain, ROOT_AAD) : undefined;

    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    jobs.forEach((j, i) => store.put(records[i], j.id));
    for (const id of removed) store.delete(id);
    if (root) store.put(root, ROOT_KEY);
    await done(tx);
    this.syncStats.push({
      ms: now() - t0,
      dataBlocks: jobs.length - tableBlocks,
      tableBlocks,
      deleted: removed.length,
      root: !!root,
      entries: new Set([...moved, ...resized]).size + gone,
    });
  }

  override async initialSyncFs(): Promise<void> {
    this.openStartedAt = now();
    const fs = this.fs;
    if (!fs) throw new Error('not initialised');
    const db = (this.db = await openDb(this.name));
    const t0 = now();
    const rootRec = (await req(db.transaction(STORE).objectStore(STORE).get(ROOT_KEY))) as Bytes | undefined;
    if (!rootRec) {
      this.openStat = { fresh: true, fileMapMs: 0, totalMs: now() - t0, tableBlocks: 0, blocks: 0, files: 0, salts: 0 };
      return;
    }
    this.loading = true;
    const rootPlain = new Uint8Array(await this.unseal(rootRec, ROOT_AAD));
    const n = new DataView(rootPlain.buffer).getUint32(0);
    const tbIds = Array.from({ length: n }, (_, i) => hex(rootPlain.subarray(4 + 16 * i, 20 + 16 * i)));
    const st = db.transaction(STORE).objectStore(STORE);
    const tbRecs = (await Promise.all(tbIds.map((id) => req(st.get(id))))) as Bytes[];
    const plains = new Array<Uint8Array>(n);
    await pool(tbIds, async (id, i) => {
      plains[i] = new Uint8Array(await this.unseal(tbRecs[i] as Bytes, aad(id, TABLE_INDEX)));
    });
    const files = new Map<string, Entry>();
    this.tbs = tbIds.map((id) => ({ id, frags: new Set<Frag>(), used: 0 }));
    this.tbs.forEach((tb, i) => {
      this.decodeTable(tb, plains[i] as Uint8Array, files);
    });
    this.tail = this.tbs[this.tbs.length - 1];
    const place = new Map<string, [Entry, number]>();
    let expected = 0;
    for (const e of files.values()) {
      e.frags.sort((a, b) => a.start - b.start);
      e.ids.forEach((id, i) => place.set(id, [e, i]));
      expected += e.ids.length;
    }
    const fileMapMs = now() - t0;

    // Recreate PGDATA in MEMFS with every file at its final size, then fill it block by block.
    const entries = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    fs.mkdirTree(PGDATA);
    for (const e of entries) {
      if (fs.isDir(e.mode)) fs.mkdirTree(e.path);
      else {
        fs.writeFile(e.path, new Uint8Array(0));
        const node = fs.lookupPath(e.path).node;
        node.contents = new Uint8Array(e.size);
        node.usedBytes = e.size;
      }
      fs.chmod(e.path, e.mode);
      e.node = fs.lookupPath(e.path).node;
      this.byIno.set(e.node.id, e);
    }

    const tableIds = new Set(tbIds);
    let got = 0;
    let lower: string | undefined;
    let pending: Promise<void> = Promise.resolve();
    for (;;) {
      const range = lower === undefined ? IDBKeyRange.lowerBound('') : IDBKeyRange.lowerBound(lower, true);
      const s = db.transaction(STORE).objectStore(STORE);
      const [keys, vals] = await Promise.all([req(s.getAllKeys(range, BATCH)), req(s.getAll(range, BATCH))]);
      await pending;
      if (keys.length === 0) break;
      lower = keys[keys.length - 1] as string;
      pending = pool(keys, async (k, i) => {
        const id = k as string;
        if (tableIds.has(id)) return;
        const loc = place.get(id);
        if (!loc) throw new Error('block not in the file table');
        const [e, idx] = loc;
        const plain = await this.unseal(vals[i] as Bytes, aad(e.fileId, idx));
        const len = Math.min(this.bs, e.size - idx * this.bs);
        (e.node?.contents as Uint8Array).set(new Uint8Array(plain, 0, len), idx * this.bs);
        got++;
      });
      pending.catch(() => undefined);
      if (keys.length < BATCH) break;
    }
    await pending;
    if (got !== expected) throw new Error(`missing blocks: ${String(expected - got)}`);
    this.loading = false;
    this.openStat = {
      fresh: false,
      fileMapMs,
      totalMs: now() - t0,
      tableBlocks: n,
      blocks: got,
      files: files.size,
      salts: this.keys.size,
    };
  }

  override async closeFs(): Promise<void> {
    this.db?.close();
    await super.closeFs();
  }

  /** Distinct session salts that own at least one live record (gate G8). */
  static async liveSalts(name: string): Promise<{ salts: number; records: number }> {
    const db = await openDb(name);
    const vals = (await req(db.transaction(STORE).objectStore(STORE).getAll())) as Bytes[];
    db.close();
    return { salts: new Set(vals.map((v) => hex(v.subarray(0, 16)))).size, records: vals.length };
  }
}
