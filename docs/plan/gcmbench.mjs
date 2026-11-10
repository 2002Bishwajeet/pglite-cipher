import { webcrypto as c } from 'node:crypto';
const key = await c.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
async function run(totalMB, unit, conc) {
  const n = Math.ceil(totalMB * 1024 * 1024 / unit);
  const pt = c.getRandomValues(new Uint8Array(Math.min(unit, 65536)));
  const block = new Uint8Array(unit); for (let o = 0; o < unit; o += pt.length) block.set(pt.subarray(0, Math.min(pt.length, unit - o)), o);
  const aad = new Uint8Array(24);
  let t = performance.now();
  const cts = new Array(n);
  for (let i = 0; i < n; i += conc) {
    await Promise.all(Array.from({ length: Math.min(conc, n - i) }, async (_, j) => {
      const iv = c.getRandomValues(new Uint8Array(12));
      cts[i + j] = [iv, await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, block)];
    }));
  }
  const enc = performance.now() - t; t = performance.now();
  for (let i = 0; i < n; i += conc) {
    await Promise.all(cts.slice(i, i + conc).map(([iv, ct]) => c.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct)));
  }
  const dec = performance.now() - t;
  console.log(`${totalMB}MB unit=${unit / 1024}KB n=${n} conc=${conc}: enc ${enc.toFixed(0)}ms (${(totalMB / enc * 1000).toFixed(0)} MB/s, ${(enc / n * 1000).toFixed(1)}us/op) dec ${dec.toFixed(0)}ms (${(totalMB / dec * 1000).toFixed(0)} MB/s, ${(dec / n * 1000).toFixed(1)}us/op)`);
}
for (const unit of [8192, 32768, 65536]) { await run(10, unit, 64); await run(100, unit, 64); }
await run(100, 8192, 1);
