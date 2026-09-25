import type { StockInfo } from '../types'

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v))

/**
 * 个股所属板块行情（行业/概念）：
 * 基于全市场快照，计算该股所属板块的平均涨幅、涨跌家数比、涨停数，
 * 以及该股在板块内的涨幅排名（判断是否龙头/领涨）。
 */

export interface StockSectorInfo {
  industry?: SectorBrief
  concept?: SectorBrief
}

export interface SectorBrief {
  name: string
  avgChangePct: number // 板块平均涨幅 %
  upRatio: number // 上涨家数占比 0~1
  limitUpCount: number // 涨停家数
  stockCount: number // 有效（有涨幅）股票数
  rank: number // 该股在板块内涨幅排名（1 = 领涨）
  /** 相对板块平均的表现：+2.5% 表示比板块均值高 2.5 个点 */
  vsAvg: number
}

const isLimitUp = (s: StockInfo): boolean => {
  const chg = s.changePct
  if (chg === undefined || chg === null) return false
  const wide = s.code.startsWith('30') || s.code.startsWith('688')
  return wide ? chg >= 19.8 : chg >= 9.8
}

/** 由全市场快照计算某只股票的板块归属行情 */
export function computeStockSectorInfo(
  market: StockInfo[],
  stockCode: string,
  industry?: string,
  concept?: string,
): StockSectorInfo {
  const result: StockSectorInfo = {}

  const buildBrief = (name: string, members: StockInfo[]): SectorBrief => {
    const valid = members.filter(
      (s) => s.changePct !== undefined && s.changePct !== null,
    )
    const stockCount = valid.length
    const avgChangePct =
      stockCount > 0
        ? Number((valid.reduce((sum, s) => sum + (s.changePct ?? 0), 0) / stockCount).toFixed(2))
        : 0
    const upCount = valid.filter((s) => (s.changePct ?? 0) > 0).length
    const limitUpCount = valid.filter((s) => isLimitUp(s)).length
    // 该股在板块内的涨幅排名（降序，越高排越前）
    const sorted = [...valid].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    const self = valid.find((s) => s.code === stockCode)
    const rank =
      self !== undefined ? sorted.findIndex((s) => s.code === stockCode) + 1 : 0
    const selfChg = self?.changePct
    const vsAvg = selfChg !== undefined ? Number((selfChg - avgChangePct).toFixed(2)) : 0
    return {
      name,
      avgChangePct,
      upRatio: stockCount > 0 ? Number((upCount / stockCount).toFixed(3)) : 0,
      limitUpCount,
      stockCount,
      rank,
      vsAvg,
    }
  }

  if (industry) {
    const members = market.filter((s) => s.industry === industry)
    if (members.length > 0) result.industry = buildBrief(industry, members)
  }
  if (concept) {
    // 概念字段是逗号分隔的多个题材，匹配含该概念的股票
    const members = market.filter((s) =>
      (s.concept ?? '').split(',').some((c) => c.trim() === concept),
    )
    if (members.length > 0) result.concept = buildBrief(concept, members)
  }

  return result
}

/** 板块判断条件（选股时参考的板块维度） */
export interface SectorJudgment {
  industry?: SectorCondition
  concept?: SectorCondition
}

export interface SectorCondition {
  name: string
  sectorRising: boolean // 板块是否在涨
  isLeader: boolean // 是否板块内领涨（前30%）
  sectorActive: boolean // 板块是否活跃（有涨停）
  outperforming: boolean // 是否跑赢板块
  score: number // -5 ~ +5 板块得分
  label: '板块助力' | '板块中性' | '板块拖累'
  color: 'good' | 'mid' | 'bad'
  signals: string[]
  risks: string[]
}

/** 由板块行情数据判断板块条件是否有利于选股 */
export function judgeSector(sectorInfo: StockSectorInfo): SectorJudgment {
  const result: SectorJudgment = {}

  const judge = (brief: SectorBrief): SectorCondition => {
    let score = 0
    const signals: string[] = []
    const risks: string[] = []

    // 1. 板块是否上涨
    if (brief.avgChangePct > 0) {
      score += 2
      signals.push(`板块上涨${brief.avgChangePct}%`)
    } else if (brief.avgChangePct < -1) {
      score -= 2
      risks.push(`板块下跌${Math.abs(brief.avgChangePct)}%`)
    } else {
      risks.push('板块平盘')
    }

    // 2. 是否领涨（前30%）
    const leaderThreshold = Math.max(1, Math.ceil(brief.stockCount * 0.3))
    const isLeader = brief.rank > 0 && brief.rank <= leaderThreshold
    if (isLeader) {
      score += 2
      signals.push(`板块第${brief.rank}名(领涨)`)
    } else if (brief.rank > 0) {
      score -= 1
      risks.push(`板块第${brief.rank}名(非龙头)`)
    }

    // 3. 板块活跃度（涨停数）
    if (brief.limitUpCount > 0) {
      score += 1
      signals.push(`板块${brief.limitUpCount}家涨停`)
    }

    // 4. 跑赢板块
    if (brief.vsAvg > 1) {
      score += 1
      signals.push(`跑赢板块+${brief.vsAvg}pt`)
    } else if (brief.vsAvg < -2) {
      score -= 1
      risks.push(`跑输板块${Math.abs(brief.vsAvg)}pt`)
    }

    // 5. 板块上涨广度
    if (brief.upRatio >= 0.6) {
      score += 1
      signals.push(`上涨占比${(brief.upRatio * 100).toFixed(0)}%`)
    } else if (brief.upRatio < 0.3) {
      score -= 1
      risks.push(`上涨占比仅${(brief.upRatio * 100).toFixed(0)}%`)
    }

    let label: SectorCondition['label']
    let color: SectorCondition['color']
    if (score >= 4) {
      label = '板块助力'
      color = 'good'
    } else if (score >= 1) {
      label = '板块中性'
      color = 'mid'
    } else {
      label = '板块拖累'
      color = 'bad'
    }

    return { name: brief.name, sectorRising: brief.avgChangePct > 0, isLeader, sectorActive: brief.limitUpCount > 0, outperforming: brief.vsAvg > 0, score, label, color, signals, risks }
  }

  if (sectorInfo.industry) result.industry = judge(sectorInfo.industry)
  if (sectorInfo.concept) result.concept = judge(sectorInfo.concept)

  return result
}

/** 板块轮动热度（全市场所有板块排名） */
export interface SectorHeat {
  name: string
  avgChangePct: number
  upRatio: number
  limitUpCount: number
  stockCount: number
  heatScore: number // 0-100
  rank: number
  leader: string // 领涨股名称
}

/**
 * 计算全市场板块轮动热度
 * 用于发现资金在往哪个板块集中
 */
export function computeSectorHeat(market: StockInfo[], topN = 10): SectorHeat[] {
  const groups = new Map<string, { sum: number; valid: number; upCount: number; total: number; limitUp: number; leaders: Array<{ name: string; chg: number }> }>()

  for (const s of market) {
    const industry = s.industry ?? '未知'
    if (!groups.has(industry)) {
      groups.set(industry, { sum: 0, valid: 0, upCount: 0, total: 0, limitUp: 0, leaders: [] })
    }
    const g = groups.get(industry)!
    g.total++
    if (s.changePct !== undefined && s.changePct !== null) {
      g.sum += s.changePct
      g.valid++
      if (s.changePct > 0) g.upCount++
      const isWide = s.code.startsWith('30') || s.code.startsWith('688')
      if (s.changePct >= (isWide ? 19.8 : 9.8)) g.limitUp++
      g.leaders.push({ name: s.name, chg: s.changePct })
    }
  }

  const heats: SectorHeat[] = []
  for (const [name, g] of groups.entries()) {
    if (g.valid < 3) continue // 样本太少跳过
    const avgChangePct = Number((g.sum / g.valid).toFixed(2))
    const upRatio = Number((g.upCount / g.valid).toFixed(3))
    const leader = [...g.leaders].sort((a, b) => b.chg - a.chg)[0]

    // 热度分 = 涨幅40 + 上涨广度30 + 涨停20 + 领涨股涨幅10
    const heatScore = clamp(
      Math.max(0, avgChangePct) * 8 + // 涨幅（每1%得8分）
        upRatio * 30 + // 上涨占比
        Math.min(g.limitUp, 5) * 4 + // 涨停家数（最多5家）
        Math.max(0, leader?.chg ?? 0) * 2, // 领涨股涨幅
      0,
      100,
    )

    heats.push({
      name,
      avgChangePct,
      upRatio,
      limitUpCount: g.limitUp,
      stockCount: g.valid,
      heatScore: Math.round(heatScore),
      rank: 0,
      leader: leader?.name ?? '-',
    })
  }

  // 排序并加排名
  heats.sort((a, b) => b.heatScore - a.heatScore)
  heats.forEach((h, i) => { h.rank = i + 1 })

  return heats.slice(0, topN)
}
