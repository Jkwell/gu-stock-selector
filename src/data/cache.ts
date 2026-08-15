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

// 盘中快照和 K 线会直接影响候选排序，不能沿用数小时级缓存。
const STOCK_LIST_TTL = 5 * 60 * 1000
const KLINE_TTL = 10 * 60 * 1000

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

/** 股票快照：盘中 5 分钟内有效 */
export const stockListCache = {
  get: (pool: 'all' | 'hs300' | 'zz500' = 'all') =>
    read<StockInfo[]>('stock_list', pool, STOCK_LIST_TTL),
  /** 跳过 TTL 读取（push2 限流降级用） */
  getStale: (pool: 'all' | 'hs300' | 'zz500' = 'all') =>
    readStale<StockInfo[]>('stock_list', pool),
  set: (data: StockInfo[], pool: 'all' | 'hs300' | 'zz500' = 'all') =>
    putRecord('stock_list', pool, data),
}

/** K 线：盘中 10 分钟内有效，避免尾盘评分使用上午数据 */
export const klineCache = {
  get: (code: string) => read<Kline[]>('kline', code, KLINE_TTL),
  set: (code: string, data: Kline[]) => putRecord('kline', code, data),
}

/** 财务数据：最新快照与历史时点使用不同缓存键，避免日期互相覆盖。 */
export const financialsCache = {
  get: (code: string, asOfDate?: string) =>
    read<Financials>('financials', `financials:${code}:${asOfDate ?? 'latest'}`, 24 * 3600 * 1000),
  set: (code: string, data: Financials) =>
    putRecord('financials', `financials:${code}:${data.asOfDate ?? 'latest'}`, data),
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
