// Paging and bounded concurrency, shared by the load, verify and rotation.

/** Records per backend read, and per commit of a rotation. */
export const PAGE = 512;
/** WebCrypto calls in flight. */
const CONCURRENCY = 64;

/** Runs `fn` over `items` with at most `CONCURRENCY` calls in flight. */
export async function pool<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}
