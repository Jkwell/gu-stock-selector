import type { StockInfo, Kline } from '../types'
import { lastValid, sma } from './indicators'

/**
 * 市场情绪引擎（纯函数）
 * 基于全市场涨跌幅统计，输出情绪温度与操作建议。
 * 用于择时：情绪冰点时不硬选，火热时大胆追强。
 */

export interface MarketSentiment {
  upCount: number // 上涨家数
  downCount: number // 下跌家数
  flatCount: number // 平盘家数
  limitUpCount: number // 涨停家数（主板>=9.8%，创业/科创>=19.8%）
  limitDownCount: number // 跌停家数
  avgChangePct: number // 平均涨跌幅
  temperature: number // 情绪温度 0-100
  level: 'hot' | 'neutral' | 'cold'
  advice: string
}

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v))

/** 判断是否涨停（按板块阈值） */
function isLimitUp(s: StockInfo): boolean {
  const chg = s.changePct
  if (chg === undefined || chg === null) return false
  const wide = s.code.startsWith('30') || s.code.startsWith('688')
  return wide ? chg >= 19.8 : chg >= 9.8
}

function isLimitDown(s: StockInfo): boolean {
  const chg = s.changePct
  if (chg === undefined || chg === null) return false
  const wide = s.code.startsWith('30') || s.code.startsWith('688')
  return wide ? chg <= -19.8 : chg <= -9.8
}

export function computeMarketSentiment(stocks: StockInfo[]): MarketSentiment {
  let up = 0
  let down = 0
  let flat = 0
  let limitUp = 0
  let limitDown = 0
  let sumChg = 0
  let validChg = 0

  for (const s of stocks) {
    if (s.changePct === undefined || s.changePct === null) continue
    if (s.changePct > 0) up++
    else if (s.changePct < 0) down++
    else flat++
    if (isLimitUp(s)) limitUp++
    if (isLimitDown(s)) limitDown++
    sumChg += s.changePct
    validChg++
  }

  const avgChangePct = validChg > 0 ? sumChg / validChg : 0
  const upDownRatio = down > 0 ? up / down : up > 0 ? 3 : 1
  const totalValid = validChg > 0 ? validChg : 1

  // ---- 温度计算（0-100，三因子加权） ----
  // 1. 涨停占比（0%=0分，1%=60分，2%+=100分；真实市场 5500 只里 1%≈55 家=火热）
  const limitUpScore = clamp((limitUp / totalValid / 0.02) * 100, 0, 100) * 0.5
  // 2. 涨跌比（<0.5 冰点=0，1=50，>2 火热=100）
  const ratioScore = clamp(((upDownRatio - 0.5) / 1.5) * 100, 0, 100) * 0.3
  // 3. 平均涨幅（-3%=0，0%=50，+3%=100）
  const avgScore = clamp(((avgChangePct + 3) / 6) * 100, 0, 100) * 0.2

  const temperature = Math.round(limitUpScore + ratioScore + avgScore)

  let level: MarketSentiment['level']
  let advice: string
  if (temperature >= 70) {
    level = 'hot'
    advice = `情绪火热（涨停 ${limitUp} 家）· 适合追强势龙头，注意别追太高`
  } else if (temperature >= 40) {
    level = 'neutral'
    advice = `情绪一般（涨停 ${limitUp} 家）· 谨慎参与，控制仓位`
  } else {
    level = 'cold'
    advice = `情绪偏弱（涨停仅 ${limitUp} 家）· 降低仓位，以跟踪和小仓试错为主`
  }

  return {
    upCount: up,
    downCount: down,
    flatCount: flat,
    limitUpCount: limitUp,
    limitDownCount: limitDown,
    avgChangePct: Number(avgChangePct.toFixed(2)),
    temperature,
    level,
    advice,
  }
}

/** 大盘趋势（基于上证指数K线） */
export interface IndexTrend {
  close: number // 最新收盘
  ma5: number // 5日均线
  ma20: number // 20日均线
  return5: number // 5日涨幅 %
  return20: number // 20日涨幅 %
  aboveMa5: boolean // 站上5日线（短期）
  aboveMa20: boolean // 站上20日线（中期）
  ma20Up: boolean // 20日线向上
  level: 'strong-up' | 'up' | 'weak-up' | 'flat' | 'down'
  desc: string
  position: string // 仓位建议
  canTrade: boolean
}

/**
 * 计算大盘趋势（上证指数），分级判断 + 仓位建议
 * 回测的"只在上升市交易"≈ 弱上升及以上
 */
export function computeIndexTrend(kline: Kline[], currentPrice?: number): IndexTrend | null {
  if (kline.length < 21) return null
  const close = kline.map((k) => k.close)
  // 用实时价更新最新一根（K线通常缺当天）
  if (currentPrice !== undefined && Number.isFinite(currentPrice) && currentPrice > 0) {
    const lastDate = kline[kline.length - 1]?.date
    const d = new Date()
    const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (lastDate === todayStr) close[close.length - 1] = currentPrice
    else close.push(currentPrice)
  }
  const n = close.length
  const last = close[n - 1]
  const ma20Arr = sma(close, 20)
  const ma20 = lastValid(ma20Arr)
  const ma5 = lastValid(sma(close, 5))
  const ma20prev = ma20Arr[n - 6] ?? null
  if (ma20 === null || ma5 === null) return null

  const return20 = close[n - 21] > 0 ? (last / close[n - 21] - 1) * 100 : 0
  const return5 = close[n - 6] > 0 ? (last / close[n - 6] - 1) * 100 : 0
  const aboveMa20 = last > ma20
  const aboveMa5 = last > ma5
  const ma20Up = ma20prev !== null && ma20 >= ma20prev

  let level: IndexTrend['level']
  let desc: string
  let position: string
  let canTrade: boolean

  if (aboveMa20 && ma20Up && return20 > 3) {
    level = 'strong-up'
    desc = '强势上升'
    position = '可满仓'
    canTrade = true
  } else if (aboveMa20 && ma20Up && return20 > 0) {
    level = 'up'
    desc = '上升趋势'
    position = '可做多'
    canTrade = true
  } else if (aboveMa5 && return20 > -2) {
    level = 'weak-up'
    desc = '弱反弹/震荡偏强'
    position = '半仓试'
    canTrade = true
  } else if (return20 > -3) {
    level = 'flat'
    desc = '震荡偏弱'
    position = '轻仓/观望'
    canTrade = false
  } else {
    level = 'down'
    desc = '下降趋势'
    position = '空仓'
    canTrade = false
  }

  return {
    close: Number(last.toFixed(2)),
    ma5: Number(ma5.toFixed(2)),
    ma20: Number(ma20.toFixed(2)),
    return5: Number(return5.toFixed(2)),
    return20: Number(return20.toFixed(2)),
    aboveMa5,
    aboveMa20,
    ma20Up,
    level,
    desc,
    position,
    canTrade,
  }
}
