// Side record of a killed worker's progress: an IndexedDB database written before and after each row, read by the page after the kill.
export const progressName = (name: string) => `${name}-progress`;

export async function readProgress(name: string): Promise<{ started: number; acked: number }> {
  const db = await openProgress(name);
  try {
    const tx = db.transaction('p', 'readonly');
    const get = (key: string) => request<unknown>(tx.objectStore('p').get(key));
    const [started, acked] = await Promise.all([get('started'), get('acked')]);
    return { started: typeof started === 'number' ? started : 0, acked: typeof acked === 'number' ? acked : 0 };
  } finally {
    db.close();
  }
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => {
      resolve(r.result);
    };
    r.onerror = () => {
      reject(r.error ?? new Error('IndexedDB request failed'));
    };
  });
}

export function openProgress(name: string): Promise<IDBDatabase> {
  const open = indexedDB.open(progressName(name));
  open.onupgradeneeded = () => {
    open.result.createObjectStore('p');
  };
  return request(open);
}

export async function record(db: IDBDatabase, key: 'started' | 'acked', id: number): Promise<void> {
  const tx = db.transaction('p', 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
  tx.objectStore('p').put(id, key);
  await done;
}
