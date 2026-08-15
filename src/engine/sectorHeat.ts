import type { StockInfo } from '../types'

/**
 * 板块热点引擎（纯函数）
 * 按行业聚合全市场涨跌幅，识别热点板块（风口上的龙头所在）。
 */

export interface SectorHeat {
  sector: string
  avgChangePct: number // 板块平均涨幅
  limitUpCount: number // 板块内涨停家数
  limitUpRatio: number // 涨停家数占有效股票数比例（0-1）
  upRatio: number // 板块上涨家数占比（0-1）
  heatScore: number // 规模归一化后的综合热度（0-100）
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
    const avgChangePct = g.valid > 0 ? Number((g.sum / g.valid).toFixed(2)) : 0
    const limitUpRatio = g.valid > 0 ? g.limitUp / g.valid : 0
    const upRatio = g.valid > 0 ? g.upCount / g.valid : 0
    // 固定涨停家数会偏爱大板块，这里改用比例并对小样本做轻微收缩。
    const avgScore = Math.min(100, Math.max(0, ((avgChangePct + 3) / 6) * 100))
    const rawHeat = avgScore * 0.4 + upRatio * 100 * 0.3 + limitUpRatio * 100 * 0.3
    const confidence = 0.8 + 0.2 * Math.min(1, Math.sqrt(g.valid / 5))
    const heatScore = Number((rawHeat * confidence).toFixed(1))
    return {
      sector,
      avgChangePct,
      limitUpCount: g.limitUp,
      limitUpRatio: Number(limitUpRatio.toFixed(3)),
      upRatio: Number(upRatio.toFixed(3)),
      heatScore,
      stockCount: g.total,
      leaders,
    }
  })

  results.sort((a, b) => {
    if (b.heatScore !== a.heatScore) return b.heatScore - a.heatScore
    if (b.limitUpRatio !== a.limitUpRatio) return b.limitUpRatio - a.limitUpRatio
    return b.avgChangePct - a.avgChangePct
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
