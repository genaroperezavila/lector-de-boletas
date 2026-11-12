// GastosPro · by Genaro_Perez
// Almacenamiento local en el teléfono (IndexedDB): gastos, fotos, rendiciones, reglas y ajustes.
const NAME = 'gastospro2';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const g = db.createObjectStore('gastos', { keyPath: 'id' });
      g.createIndex('rendId', 'rendId');
      db.createObjectStore('photos', { keyPath: 'id' });
      db.createObjectStore('rends', { keyPath: 'id' });
      db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore ? (Array.isArray(store) ? store.map((s) => t.objectStore(s)) : t.objectStore(store)) : null))
      .then((v) => { out = v; }).catch(reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción abortada'));
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => done(s.get(key)));
export const all = (store) => tx(store, 'readonly', (s) => done(s.getAll()));
export const put = (store, val) => tx(store, 'readwrite', (s) => done(s.put(val)));
export const del = (store, key) => tx(store, 'readwrite', (s) => done(s.delete(key)));
export const byIndex = (store, index, key) => tx(store, 'readonly', (s) => done(s.index(index).getAll(key)));

export async function kvGet(k, def = null) { const r = await get('kv', k); return r ? r.v : def; }
export const kvSet = (k, v) => put('kv', { k, v });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function storageInfo() {
  let persisted = false, usage = 0, quota = 0;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* */ }
  try { const e = await navigator.storage?.estimate?.(); usage = e?.usage || 0; quota = e?.quota || 0; } catch { /* */ }
  return { persisted, usage, quota };
}
export async function askPersist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }
