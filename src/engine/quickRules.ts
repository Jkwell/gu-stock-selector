import type { Kline, StockInfo } from '../types'
import { lastValid, sma } from './indicators'

/**
 * 温和放量筛选规则（东财条件选股规则）
 * 1. 价格：3 ~ 300 元，PE：0 ~ 300
 * 2. 换手率：1% ~ 20%，涨跌幅：-4% ~ 6%
 * 3. 剔除：ST、退市、科创板、北交所
 * 4. K 线精筛：量比 1.2 ~ 5，并确认上升趋势
 */

export interface QuickRules {
  minPrice: number
  maxPrice: number
  minPe: number
  maxPe: number
  minRatio: number // 量比下限
  maxRatio: number // 量比上限
  minTurnover: number // 换手率下限 %
  maxTurnover: number // 换手率上限 %
  minChange: number // 涨跌幅下限 %
  maxChange: number // 涨跌幅上限 %
}

export const DEFAULT_QUICK_RULES: QuickRules = {
  minPrice: 3,
  maxPrice: 300,
  minPe: 0,
  maxPe: 300,
  minRatio: 1.2,
  maxRatio: 5,
  minTurnover: 1,
  maxTurnover: 20,
  minChange: -4,
  maxChange: 6,
}

/** 快照字段粗筛：价格、估值、换手和涨跌幅（无需 K 线）。 */
export function filterByQuickRules(
  stocks: StockInfo[],
  rules: QuickRules = DEFAULT_QUICK_RULES,
): StockInfo[] {
  return stocks.filter((s) => {
    // 剔除 ST / 退市 / 科创板 / 北交所
    if (/ST|退|^N/.test(s.name)) return false
    if (s.code.startsWith('688')) return false
    if (s.market === 'bj' || s.code.startsWith('8') || s.code.startsWith('4') || s.code.startsWith('92')) return false
    if (s.price === undefined || s.price < rules.minPrice || s.price > rules.maxPrice) return false
    if (s.pe === undefined || s.pe <= rules.minPe || s.pe > rules.maxPe) return false
    // 换手率区间
    if (s.turnoverRate === undefined || s.turnoverRate < rules.minTurnover || s.turnoverRate > rules.maxTurnover) return false
    // 涨跌幅区间
    if (s.changePct === undefined || s.changePct < rules.minChange || s.changePct > rules.maxChange) return false
    return true
  })
}

/** 量比：当日成交量 / 过去 5 日均量（K 线近似） */
export function calcVolumeRatio(kline: Kline[]): number | null {
  if (kline.length < 6) return null
  const vols = kline.map((k) => k.volume)
  const today = vols[vols.length - 1]
  const avg5 = sma(vols, 5)[vols.length - 2] // 前5日均量（不含当日）
  if (!avg5 || avg5 <= 0) return null
  return today / avg5
}

/** 量比区间过滤（K 线精筛） */
export function filterByVolumeRatio(
  kline: Kline[],
  rules: QuickRules = DEFAULT_QUICK_RULES,
): boolean {
  const ratio = calcVolumeRatio(kline)
  if (ratio === null) return false
  return ratio >= rules.minRatio && ratio <= rules.maxRatio
}

/**
 * 上升趋势硬性过滤（博主规则②：只做上升趋势，拒绝抄底）
 * 判断标准（全部满足才算上升趋势）：
 * 1. MA20 > MA60（中期均线多头排列）
 * 2. 收盘价 > MA20（价格站在均线上方，非低位横盘）
 * 3. MA20 拐头向上（近 5 日 MA20 抬高）
 */
export function isUptrend(kline: Kline[]): boolean {
  if (kline.length < 60) return false
  const close = kline.map((k) => k.close)
  const n = close.length
  const ma20Arr = sma(close, 20)
  const ma60Arr = sma(close, 60)

  const m20 = lastValid(ma20Arr)
  const m60 = lastValid(ma60Arr)
  const m20prev = ma20Arr[n - 6] // 5 交易日前
  if (m20 === null || m60 === null || m20prev === null) return false

  // 均线多头 + 价格在均线上方 + MA20 向上
  return m20 > m60 && close[n - 1] > m20 && m20 > m20prev
}
