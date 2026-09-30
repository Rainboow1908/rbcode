/** 极简 IndexedDB 键值存储，用于持久化目录句柄等结构化克隆对象。 */

const DB_NAME = 'rbcode-fs'
const DB_VERSION = 1
const STORE = 'kv'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'))
  })
  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB operation failed'))
  })
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return withStore<T | undefined>('readonly', (s) => s.get(key))
}

export function idbSet(key: string, value: unknown): Promise<void> {
  return withStore<void>('readwrite', (s) => s.put(value, key))
}

export function idbDelete(key: string): Promise<void> {
  return withStore<void>('readwrite', (s) => s.delete(key))
}
