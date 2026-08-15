import type { Kline } from '../types'
import { lastValid, sma } from './indicators'

/** 判断是否一字涨停板（开盘=最高=最低=收盘 且涨停），买不进 */
export function isOneWordLimitUp(
  kline: Kline[],
  limitUpThreshold: number,
): boolean {
  const k = kline[kline.length - 1]
  if (!k) return false
  const prevClose = kline[kline.length - 2]?.close
  if (!prevClose || prevClose <= 0) return false
  const change = k.close / prevClose - 1
  // 一字板：全天 price 不动，open≈high≈low≈close
  const flat = Math.abs(k.open - k.close) < 0.01 && Math.abs(k.high - k.low) < 0.01
  return flat && change >= limitUpThreshold - 0.005
}

/**
 * 买卖点计算引擎（纯函数）
 * 基于技术面支撑/压力位，输出可操作的交易信号：
 *   - 买入区间（回踩支撑位）
 *   - 止盈目标（前期高点 / 布林上轨）
 *   - 止损价（跌破近期低点 / 20 日线）
 */

export interface TradingSignal {
  currentPrice: number // 尾盘实时价
  buyLow: number // 买入区间下沿
  buyHigh: number // 买入区间上沿
  takeProfit: number // 止盈目标价
  stopLoss: number // 止损价
  riskReward: number // 风险回报比
  reasons: string[] // 可解释理由
}

const round2 = (v: number) => Number(v.toFixed(2))

/** 今日推荐默认最低风险回报比，低于此值不进入可执行推荐。 */
export const DEFAULT_MIN_RISK_REWARD = 1.5

/**
 * 计算买卖点
 * @param kline 日 K 线（升序，最后一根为最新）
 * @param currentPrice 实时价，缺省用最后收盘价
 * @param shortMode 短线模式：用 MA5/近5日低点（回踩更敏感），默认用 MA20/近10日低点
 */
export function computeTradingSignal(
  kline: Kline[],
  currentPrice?: number,
  shortMode = false,
): TradingSignal | null {
  if (kline.length < 30) return null

  const close = kline.map((k) => k.close)
  const high = kline.map((k) => k.high)
  const low = kline.map((k) => k.low)
  const n = kline.length

  const price = currentPrice ?? close[n - 1]
  if (!Number.isFinite(price) || price <= 0) return null

  // 指标（短线用 MA5/近5日，长线用 MA20/近10日）
  const maPeriod = shortMode ? 5 : 20
  const lowPeriod = shortMode ? 5 : 10
  const ma = lastValid(sma(close, maPeriod)) ?? price
  const lowN = Math.min(...low.slice(-lowPeriod))
  const high20 = Math.max(...high.slice(-20))

  // 支撑位：均线与近期低点的较大者（更接近现价的支撑）
  const support = Math.max(ma, lowN)

  // 买入区间：现价到支撑之间
  const buyLow = round2(Math.min(support, price))
  const buyHigh = round2(Math.max(support, price))

  // 止盈目标：前期高点与 +5% 的较大者
  const takeProfit = round2(Math.max(high20, price * 1.05))

  // 止损价：跌破支撑位 3%，且不低于 -5%（超短线止损收紧）
  let stopLoss = Math.min(ma, lowN) * 0.97
  stopLoss = Math.max(stopLoss, price * 0.95)
  stopLoss = round2(stopLoss)

  // 风险回报比
  const upside = takeProfit - price
  const downside = price - stopLoss
  const riskReward = downside > 0 ? Number((upside / downside).toFixed(2)) : 0

  // 理由
  const reasons: string[] = []
  if (price > ma) {
    reasons.push(`现价高于 ${maPeriod} 日线 ${round2(ma)}，回踩均线是理想买点`)
  } else {
    reasons.push(`现价低于 ${maPeriod} 日线 ${round2(ma)}，可在现价附近分批布局`)
  }
  if (high20 >= price * 1.05) {
    reasons.push(`止盈看前期高点 ${round2(high20)}`)
  } else {
    reasons.push(`止盈目标 ${takeProfit}（+5% 目标，因前期高点 ${round2(high20)} 偏低）`)
  }
  reasons.push(`止损 ${stopLoss}（跌破近 ${lowPeriod} 日低点 ${round2(lowN)} 的 3%）`)

  return {
    currentPrice: round2(price),
    buyLow,
    buyHigh,
    takeProfit,
    stopLoss,
    riskReward,
    reasons,
  }
}
