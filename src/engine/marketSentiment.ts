import type { StockInfo } from '../types'

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
    advice = `情绪冰点（涨停仅 ${limitUp} 家）· 建议空仓观望，等情绪回暖`
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
