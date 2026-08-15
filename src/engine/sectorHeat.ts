import type { StockInfo } from '../types'

/**
 * 板块热点引擎（纯函数）
 * 按行业聚合全市场涨跌幅，识别热点板块（风口上的龙头所在）。
 */

export interface SectorHeat {
  sector: string
  avgChangePct: number // 板块平均涨幅
  limitUpCount: number // 板块内涨停家数
  upRatio: number // 板块上涨家数占比（0-1）
  stockCount: number
  leaders: string[] // 板块内领涨股名称（Top 3）
}

function isLimitUp(s: StockInfo): boolean {
  const chg = s.changePct
  if (chg === undefined || chg === null) return false
  const wide = s.code.startsWith('30') || s.code.startsWith('688')
  return wide ? chg >= 19.8 : chg >= 9.8
}

/** 按指定 key 聚合板块热度（key 可以是行业或概念） */
function aggregateHeat(
  stocks: StockInfo[],
  keyFn: (s: StockInfo) => string,
  topN: number,
): SectorHeat[] {
  const groups = new Map<
    string,
    { sum: number; valid: number; limitUp: number; upCount: number; total: number; leaders: Array<{ name: string; chg: number }> }
  >()

  for (const s of stocks) {
    const sector = keyFn(s)
    if (!groups.has(sector)) {
      groups.set(sector, {
        sum: 0,
        valid: 0,
        limitUp: 0,
        upCount: 0,
        total: 0,
        leaders: [],
      })
    }
    const g = groups.get(sector)!
    g.total++
    if (s.changePct !== undefined && s.changePct !== null) {
      g.sum += s.changePct
      g.valid++
      if (s.changePct > 0) g.upCount++
      if (isLimitUp(s)) g.limitUp++
      g.leaders.push({ name: s.name, chg: s.changePct })
    }
  }

  const results: SectorHeat[] = [...groups.entries()].map(([sector, g]) => {
    const leaders = [...g.leaders]
      .sort((a, b) => b.chg - a.chg)
      .slice(0, 3)
      .map((l) => l.name)
    return {
      sector,
      avgChangePct: g.valid > 0 ? Number((g.sum / g.valid).toFixed(2)) : 0,
      limitUpCount: g.limitUp,
      upRatio: g.total > 0 ? Number((g.upCount / g.total).toFixed(2)) : 0,
      stockCount: g.total,
      leaders,
    }
  })

  results.sort((a, b) => {
    if (b.limitUpCount !== a.limitUpCount) return b.limitUpCount - a.limitUpCount
    if (b.avgChangePct !== a.avgChangePct) return b.avgChangePct - a.avgChangePct
    return b.upRatio - a.upRatio
  })

  return results.slice(0, topN)
}

/** 行业热点榜 */
export function computeSectorHeat(stocks: StockInfo[], topN = 10): SectorHeat[] {
  return aggregateHeat(stocks, (s) => s.industry ?? '其他', topN)
}

/** 概念题材热点榜（用 f128 概念字段） */
export function computeConceptHeat(stocks: StockInfo[], topN = 10): SectorHeat[] {
  return aggregateHeat(stocks, (s) => s.concept ?? '其他', topN)
}
