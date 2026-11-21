/**
 * אחסון מקומי בדפדפן (IndexedDB) – הנתונים לא יוצאים מהמחשב.
 *  kv:          'db' = קובץ המסד (bytes)
 *  attachments: מסמכי ספקים מצורפים, לפי hash
 *  outputs:     ה"מקור" שהופק (HTML), לארכיון
 *  snapshots:   גיבוי יומי אוטומטי בתוך הדפדפן (14 אחרונים)
 */
declare const __DEMO__: boolean;   // נקבע בבנייה (build-web.mjs): גרסת הדמו שומרת במסד נפרד
export const DB_NAME = __DEMO__ ? 'pinkas-demo' : 'pinkas';
const STORES = ['kv', 'attachments', 'outputs', 'snapshots'] as const;
type StoreName = (typeof STORES)[number];

let dbp: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return idb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  }));
}

export const store = {
  get: <T = unknown>(s: StoreName, key: string) => tx<T>(s, 'readonly', (o) => o.get(key) as IDBRequest<T>),
  put: (s: StoreName, key: string, value: unknown) => tx<IDBValidKey>(s, 'readwrite', (o) => o.put(value, key)),
  del: (s: StoreName, key: string) => tx<undefined>(s, 'readwrite', (o) => o.delete(key)),
  keys: (s: StoreName) => tx<IDBValidKey[]>(s, 'readonly', (o) => o.getAllKeys()).then((k) => k.map(String)),
};
