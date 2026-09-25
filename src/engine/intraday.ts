import type { MinutePoint } from '../data/api'

/**
 * 分时分析：判断"回踩均价线不破"（用户核心买点信号）
 * 逻辑：
 *  1. 现价站上分时均价线（处于上升/强势）
 *  2. 近期回踩触及均价线附近，但未有效跌破（不破）
 *  3. 分时趋势向上
 */
export interface IntradayAnalysis {
  price: number // 现价
  avgPrice: number // 分时均价线
  aboveAvg: boolean // 现价在均价线上方
  pullbackHeld: boolean // 回踩均价线不破
  intradayTrend: 'up' | 'down' | 'flat' // 分时趋势
  verdict: string // 结论
  canBuy: boolean // 是否可买
  detail: string // 说明
}

export function analyzeIntraday(points: MinutePoint[]): IntradayAnalysis | null {
  if (points.length < 10) return null

  const last = points[points.length - 1]
  const price = last.price
  const avgPrice = last.avgPrice
  if (!Number.isFinite(price) || !Number.isFinite(avgPrice) || avgPrice <= 0) return null

  const aboveAvg = price >= avgPrice

  // 近 30 分钟：是否触及均价线但未有效跌破
  const recent = points.slice(-30)
  let touchedAvg = false
  let brokeDown = false
  for (const p of recent) {
    if (!Number.isFinite(p.avgPrice) || p.avgPrice <= 0) continue
    if (p.price <= p.avgPrice * 1.003) touchedAvg = true // 触及均价线
    if (p.price < p.avgPrice * 0.993) brokeDown = true // 有效跌破（-0.7%）
  }
  const pullbackHeld = touchedAvg && !brokeDown && aboveAvg

  // 分时趋势：近 30 分钟价格变化
  const startPrice = recent[0]?.price ?? price
  const chg = startPrice > 0 ? price / startPrice - 1 : 0
  const intradayTrend: IntradayAnalysis['intradayTrend'] =
    chg > 0.003 ? 'up' : chg < -0.003 ? 'down' : 'flat'

  let verdict: string
  let canBuy = false
  let detail = ''

  if (pullbackHeld) {
    verdict = '✅ 回踩均价线不破'
    canBuy = true
    detail = '现价站上均价线，回踩不破，符合买点'
  } else if (aboveAvg && !touchedAvg) {
    verdict = '⏳ 强势未回踩'
    canBuy = false
    detail = '现价在均价线上方且未回踩，可等回踩均价线再买'
  } else if (aboveAvg && brokeDown) {
    verdict = '⚠️ 跌破后收回'
    canBuy = false
    detail = '盘中曾跌破均价线，虽收回但需谨慎'
  } else {
    verdict = '❌ 跌破均价线'
    canBuy = false
    detail = '现价在均价线下方，走弱，不买'
  }

  return {
    price: Number(price.toFixed(2)),
    avgPrice: Number(avgPrice.toFixed(2)),
    aboveAvg,
    pullbackHeld,
    intradayTrend,
    verdict,
    canBuy,
    detail,
  }
}
