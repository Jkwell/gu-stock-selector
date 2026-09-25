import type { DailyPick } from '../types'

/**
 * 推荐记录持久化（localStorage）
 * 每次今日推荐生成后存档，供复盘页检验胜率/收益。
 */

export interface PickRecord {
  date: string // 推荐日期 YYYY-MM-DD
  /** 本次推荐使用的策略模板（旧记录无此字段，归为 legacy） */
  strategy?: { key: string; name: string }
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

/** 本地时区日期 'YYYY-MM-DD'（避免 toISOString 的 UTC 偏移，北京 0-8 点会记成前一天） */
export function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

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
export function recordFromPicks(
  date: string,
  picks: DailyPick[],
  strategy?: { key: string; name: string },
): PickRecord {
  return {
    date,
    strategy,
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
