/** The translation cache in IndexedDB: opened by the background script, and by the settings page to empty it. */

const DB_NAME = 'yuedu-translation-cache';
const STORE = 'translations';
const MAX_ENTRIES = 4000;
const KEEP_ENTRIES = 3000;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

const wrap = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

let opened: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'k' });
      store.createIndex('at', 'at');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((err) => {
    opened = undefined;
    throw err;
  });
  return opened;
}

export const idbCache = {
  async get(keys: string[]): Promise<Map<string, string>> {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const rows = await Promise.all(keys.map((k) => wrap(store.get(k) as IDBRequest<{ k: string; t: string; at: number } | undefined>)));
    const now = Date.now();
    return new Map(rows.flatMap((row) => (row && now - row.at < MAX_AGE_MS ? [[row.k, row.t] as [string, string]] : [])));
  },

  async put(entries: [string, string][]): Promise<void> {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const now = Date.now();
    for (const [k, t] of entries) store.put({ k, t, at: now });
    await done(tx);
    await prune();
  },

  async clear(): Promise<void> {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
  },

  async count(): Promise<number> {
    const db = await open();
    return wrap(db.transaction(STORE, 'readonly').objectStore(STORE).count());
  },
};

/** Old entries go first, once the cache is over its size. */
async function prune(): Promise<void> {
  const db = await open();
  if ((await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).count())) <= MAX_ENTRIES) return;
  const tx = db.transaction(STORE, 'readwrite');
  const index = tx.objectStore(STORE).index('at');
  let excess = (await wrap(index.count())) - KEEP_ENTRIES;
  await new Promise<void>((resolve, reject) => {
    const cursor = index.openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row || excess-- <= 0) return resolve();
      row.delete();
      row.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  await done(tx);
}
