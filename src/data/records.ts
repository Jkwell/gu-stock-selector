import type { DailyPick } from '../types'

/**
 * 推荐记录持久化（localStorage）
 * 每次今日推荐生成后存档，供复盘页检验胜率/收益。
 */

export interface PickRecord {
  date: string // 推荐日期 YYYY-MM-DD
  picks: Array<{
    code: string
    name: string
    price: number // 推荐时价（基准）
    buyLow: number
    buyHigh: number
    takeProfit: number
    stopLoss: number
    totalScore: number
  }>
}

const STORAGE_KEY = 'stock-selector-picks-history'
const MAX_DAYS = 30 // 保留最近 30 天

export function getPickRecords(): PickRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as PickRecord[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 保存一条推荐记录（同日期覆盖） */
export function savePickRecord(record: PickRecord): PickRecord[] {
  const list = getPickRecords()
  const idx = list.findIndex((r) => r.date === record.date)
  if (idx >= 0) list[idx] = record
  else list.unshift(record)
  // 按日期降序 + 保留 30 天
  const sorted = list.sort((a, b) => (a.date < b.date ? 1 : -1))
  const trimmed = sorted.slice(0, MAX_DAYS)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // ignore
  }
  return trimmed
}

/** 从今日推荐结果构造记录 */
export function recordFromPicks(date: string, picks: DailyPick[]): PickRecord {
  return {
    date,
    picks: picks.map((p) => ({
      code: p.code,
      name: p.name,
      price: p.price ?? 0,
      buyLow: p.buyLow,
      buyHigh: p.buyHigh,
      takeProfit: p.takeProfit,
      stopLoss: p.stopLoss,
      totalScore: p.totalScore,
    })),
  }
}
