import type { Financials, Kline, MoneyFlow, StockInfo } from '../types'

/**
 * IndexedDB 缓存层（手写 Promise 封装）
 * 表结构：
 *  - meta        { key, value }          通用键值（时间戳）
 *  - stock_list  { key, data }           全市场快照
 *  - kline       { key(code), updatedAt, data }
 *  - financials  { key(code), updatedAt, data }
 *  - moneyflow   { key(code), updatedAt, data }
 */

const DB_NAME = 'stock-selector-db'
const DB_VERSION = 1

const STORES = ['meta', 'stock_list', 'kline', 'financials', 'moneyflow'] as const

type StoreName = (typeof STORES)[number]

interface CacheRecord<T> {
  key: string
  updatedAt: number
  data: T
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'key' })
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error)
      }),
  )
}

async function getRecord<T>(store: StoreName, key: string): Promise<CacheRecord<T> | undefined> {
  try {
    return await tx<CacheRecord<T> | undefined>(store, 'readonly', (s) =>
      s.get(key),
    )
  } catch {
    return undefined
  }
}

async function putRecord<T>(store: StoreName, key: string, data: T): Promise<void> {
  const rec: CacheRecord<T> = { key, updatedAt: Date.now(), data }
  try {
    await tx(store, 'readwrite', (s) => s.put(rec))
  } catch {
    // 缓存失败不影响主流程
  }
}

/** 读取缓存，若超过 maxAgeMs 则视为过期返回 null */
async function read<T>(
  store: StoreName,
  key: string,
  maxAgeMs: number,
): Promise<T | null> {
  const rec = await getRecord<T>(store, key)
  if (!rec) return null
  if (Date.now() - rec.updatedAt > maxAgeMs) return null
  return rec.data
}

/** 读取缓存，不限 TTL（用于降级） */
async function readStale<T>(store: StoreName, key: string): Promise<T | null> {
  const rec = await getRecord<T>(store, key)
  if (!rec) return null
  return rec.data
}

// ---------- 具体数据类型的缓存接口 ----------

/** 全市场快照：当天有效 */
export const stockListCache = {
  get: () => read<StockInfo[]>('stock_list', 'all', 12 * 3600 * 1000),
  /** 跳过 TTL 读取（push2 限流降级用） */
  getStale: () => readStale<StockInfo[]>('stock_list', 'all'),
  set: (data: StockInfo[]) => putRecord('stock_list', 'all', data),
}

/** K 线：3 小时内有效（盘中数据会变化） */
export const klineCache = {
  get: (code: string) => read<Kline[]>('kline', code, 3 * 3600 * 1000),
  set: (code: string, data: Kline[]) => putRecord('kline', code, data),
}

/** 财务数据：每天有效（盘中不变） */
export const financialsCache = {
  get: (code: string) => read<Financials>('financials', code, 24 * 3600 * 1000),
  set: (code: string, data: Financials) => putRecord('financials', code, data),
}

/** 资金流：10 分钟内有效 */
export const moneyflowCache = {
  get: (code: string) => read<MoneyFlow>('moneyflow', code, 10 * 60 * 1000),
  set: (code: string, data: MoneyFlow) => putRecord('moneyflow', code, data),
}

/** 清空全部缓存 */
export async function clearCache(): Promise<void> {
  try {
    const db = await openDB()
    for (const store of STORES) {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction(store, 'readwrite')
        t.objectStore(store).clear()
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
      })
    }
  } catch {
    // ignore
  }
}
