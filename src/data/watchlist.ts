import type { StockInfo } from '../types'
import { marketOfCode } from './api'

/**
 * 监控列表存储（localStorage，轻量、刷新不丢）
 * 监控项含买卖点（推荐票自动带，手动添加可选填）
 */

export interface WatchItem {
  code: string
  name: string
  market: StockInfo['market']
  buyLow?: number // 买入区间下沿
  buyHigh?: number // 买入区间上沿
  takeProfit?: number // 止盈价
  stopLoss?: number // 止损价
  totalScore?: number
  addedAt: string
}

const STORAGE_KEY = 'stock-selector-watchlist'

export function getWatchlist(): WatchItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as WatchItem[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function save(list: WatchItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // ignore
  }
}

/** 添加或更新（同 code 覆盖） */
export function addToWatchlist(item: WatchItem): WatchItem[] {
  const list = getWatchlist()
  const idx = list.findIndex((w) => w.code === item.code)
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...item, addedAt: list[idx].addedAt }
  } else {
    list.push(item)
  }
  save(list)
  return list
}

export function removeFromWatchlist(code: string): WatchItem[] {
  const list = getWatchlist().filter((w) => w.code !== code)
  save(list)
  return list
}

export function clearWatchlist(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** 由 StockInfo/推荐结果构造监控项 */
export function watchItemFrom(
  code: string,
  name: string,
  opts?: Partial<Pick<WatchItem, 'buyLow' | 'buyHigh' | 'takeProfit' | 'stopLoss' | 'totalScore'>>,
): WatchItem {
  return {
    code,
    name,
    market: marketOfCode(code),
    buyLow: opts?.buyLow,
    buyHigh: opts?.buyHigh,
    takeProfit: opts?.takeProfit,
    stopLoss: opts?.stopLoss,
    totalScore: opts?.totalScore,
    addedAt: new Date().toISOString(),
  }
}
