// Browser cache in IndexedDB, so a reload doesn't refetch 7,000 observations.
// If IndexedDB is unavailable (private window, blocked storage) everything still works for the
// session from memory. Commons itself stays the source of truth for what's already uploaded.
//
// Stores:
//   records  photo records (keyPath "key" = "<obsId>-<photoId>")
//   status   per-photo progress { key, state, sha1, commonsTitle, at }
//            state: "deduped" (checked, not on Commons) | "duplicate" | later "uploaded" | "sdc_done"
//   taxa     iNaturalist taxon id → Wikidata QID or null
//   meta     misc values (selection, last fetch time)

const DB_NAME = 'inat2commons';
const DB_VERSION = 1;
const KEYED = new Set(['records', 'status']);
const STORES = ['records', 'status', 'taxa', 'meta'];

const memory = Object.fromEntries(STORES.map((s) => [s, new Map()]));
let dbPromise;

const OPEN_TIMEOUT_MS = 3000;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    // Some browsers (private modes, embedded views) never answer; fall back to memory.
    setTimeout(() => resolve(null), OPEN_TIMEOUT_MS);
    let req;
    try {
      if (!globalThis.indexedDB) return resolve(null);
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, KEYED.has(s) ? { keyPath: 'key' } : undefined);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store) {
  const db = await openDb();
  if (!db) return [...memory[store].values()];
  try {
    return await request(db.transaction(store).objectStore(store).getAll());
  } catch {
    return [...memory[store].values()];
  }
}

export async function get(store, key) {
  const db = await openDb();
  if (!db) return memory[store].get(key);
  try {
    return await request(db.transaction(store).objectStore(store).get(key));
  } catch {
    return memory[store].get(key);
  }
}

/** For keyed stores pass values only; for the others pass [key, value] pairs. */
export async function putMany(store, items) {
  for (const item of items) {
    if (KEYED.has(store)) memory[store].set(item.key, item);
    else memory[store].set(item[0], item[1]);
  }
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const item of items) {
      if (KEYED.has(store)) os.put(item);
      else os.put(item[1], item[0]);
    }
    await done(tx);
  } catch {
    // Storage full or blocked: the in-memory copy above keeps the session working.
  }
}

export async function put(store, value, key) {
  return putMany(store, [KEYED.has(store) ? value : [key, value]]);
}

export async function getMany(store, keys) {
  const out = new Map();
  for (const k of keys) {
    const v = await get(store, k);
    if (v !== undefined) out.set(k, v);
  }
  return out;
}

export async function clear(store) {
  memory[store].clear();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    await done(tx);
  } catch {
    // ignore
  }
}
