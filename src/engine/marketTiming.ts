import type { Kline } from '../types'
import { lastValid, sma } from './indicators'

/**
 * 大盘择时：指数 vs 20 日线，判断市场整体趋势
 * 指数在 MA20 上方 = 多头市场（可做）
 * 指数在 MA20 下方 = 空头市场（降仓/观望）
 */

export interface MarketTiming {
  code: string
  name: string
  price: number
  ma20: number
  trend: 'above' | 'below'
  changePct: number
}

export function computeMarketTiming(kline: Kline[]): MarketTiming | null {
  if (kline.length < 25) return null
  const close = kline.map((k) => k.close)
  const n = close.length
  const price = close[n - 1]
  const ma20 = lastValid(sma(close, 20))
  if (ma20 === null) return null
  const prevClose = close[n - 2]
  const changePct = prevClose > 0 ? (price / prevClose - 1) * 100 : 0

  return {
    code: '',
    name: '',
    price,
    ma20,
    trend: price > ma20 ? 'above' : 'below',
    changePct,
  }
}
