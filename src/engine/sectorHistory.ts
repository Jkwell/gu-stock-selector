import type { SectorHeat } from './sectorHeat'

/**
 * 板块热度历史存储
 * 用于计算连续热门天数和资金趋势
 */

const STORAGE_KEY = 'sector-heat-history'
const MAX_HISTORY_DAYS = 10

interface SectorHeatSnapshot {
  date: string // YYYY-MM-DD
  sectors: Array<{ sector: string; avgChangePct: number }>
}

/** 读取历史热度 */
export function getSectorHeatHistory(): SectorHeatSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as SectorHeatSnapshot[]
  } catch {
    return []
  }
}

/** 保存今日热度 */
export function saveSectorHeatHistory(sectors: SectorHeat[]): void {
  const today = new Date().toISOString().slice(0, 10)
  const history = getSectorHeatHistory().filter((s) => s.date !== today)
  history.push({
    date: today,
    sectors: sectors.slice(0, 10).map((s) => ({ sector: s.sector, avgChangePct: s.avgChangePct })),
  })
  // 只保留最近 N 天
  const trimmed = history.slice(-MAX_HISTORY_DAYS)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // ignore
  }
}

/** 计算某个板块的连续热门天数 */
export function computeConsecutiveDays(sectorName: string): number {
  try {
    const history = getSectorHeatHistory()
    let days = 0
    // 从最近一天往前数
    for (let i = history.length - 1; i >= 0; i--) {
      const inTop10 = history[i].sectors.some((s) => s.sector === sectorName)
      if (inTop10) days++
      else break
    }
    return days
  } catch {
    return 0
  }
}

/** 计算板块资金趋势（基于历史涨幅加速度） */
export function computeSectorTrend(sectorName: string): 'accelerating' | 'stable' | 'decelerating' {
  try {
    const history = getSectorHeatHistory()
    if (history.length < 2) return 'stable'

    // 找最近3天该板块的平均涨幅
    const recent: number[] = []
    for (let i = history.length - 1; i >= 0 && recent.length < 3; i--) {
      const s = history[i].sectors.find((x) => x.sector === sectorName)
      if (s) recent.push(s.avgChangePct)
    }

    if (recent.length < 2) return 'stable'

    // 比较最近1天 vs 前几天的平均
    const latest = recent[0]
    const avgPrev = recent.slice(1).reduce((a, b) => a + b, 0) / (recent.length - 1)

    if (latest > avgPrev + 0.5) return 'accelerating'
    if (latest < avgPrev - 0.5) return 'decelerating'
    return 'stable'
  } catch {
    return 'stable'
  }
}
