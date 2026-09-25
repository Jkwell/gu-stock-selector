import type { SectorHeat } from './sectorHeat'

/**
 * 板块热度持续性追踪（纯函数）
 * 跨交易日记录每个板块的热度，计算"持续上榜天数"：
 *   - 昨天也在榜 → 持续天数 +1
 *   - 同一天内多次刷新 → 持续天数保持不变
 *   - 今天新上榜 → 首日
 * 用于区分"第一天启动的单日脉冲"和"已持续多日的主线板块"。
 */

export interface HeatEntry {
  days: number // 持续上榜天数
  avgChangePct: number
  upRatio: number
  heatScore: number
  limitUpCount: number
}

export interface HeatSnapshot {
  date: string // YYYY-MM-DD
  sectors: Record<string, HeatEntry>
}

export function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 计算今日持续性快照。
 * @param todaySectors 今日板块热度榜（如 computeSectorHeat 输出 Top 12）
 * @param prev 上次保存的快照（null 表示首次）
 * @param today 今日日期 key
 */
export function computePersistence(
  todaySectors: SectorHeat[],
  prev: HeatSnapshot | null,
  today: string,
): HeatSnapshot {
  const sameDay = prev !== null && prev.date === today
  const sectors: Record<string, HeatEntry> = {}
  for (const h of todaySectors) {
    const prevEntry = prev?.sectors[h.sector]
    const days = prevEntry ? (sameDay ? prevEntry.days : prevEntry.days + 1) : 1
    sectors[h.sector] = {
      days,
      avgChangePct: h.avgChangePct,
      upRatio: h.upRatio,
      heatScore: h.heatScore,
      limitUpCount: h.limitUpCount,
    }
  }
  return { date: today, sectors }
}

const STORAGE_KEY = 'sector-heat-history'

/** 从 localStorage 读取快照（浏览器环境，失败返回 null） */
export function loadSnapshot(key: string = STORAGE_KEY): HeatSnapshot | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const snap = JSON.parse(raw) as HeatSnapshot
    if (!snap || typeof snap.date !== 'string' || !snap.sectors) return null
    return snap
  } catch {
    return null
  }
}

/** 保存快照到 localStorage（浏览器环境，失败静默） */
export function saveSnapshot(snap: HeatSnapshot, key: string = STORAGE_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(snap))
  } catch {
    // 隐私模式/存储满等场景静默降级
  }
}
