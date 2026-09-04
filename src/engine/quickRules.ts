import type { Kline, MoneyFlow, StockInfo } from '../types'
import { lastValid, rsi, sma } from './indicators'

/** 资金集中度评分 */
export interface FundConcentration {
  level: 'high' | 'medium' | 'low'
  ratio: number // 超大单+大单 / 主力净流入
  superPct: number // 超大单占主力比例
  bigPct: number // 大单占主力比例
}

export function computeFundConcentration(mf: MoneyFlow | null): FundConcentration | null {
  if (!mf || mf.mainNetInflow === undefined || mf.mainNetInflow === null) return null
  const total = Math.abs(mf.mainNetInflow)
  if (total <= 0) return null
  const superVal = mf.superNetInflow ?? 0
  const bigVal = mf.bigNetInflow ?? 0
  const superAndBig = Math.abs(superVal) + Math.abs(bigVal)
  const ratio = superAndBig / total
  const superPct = Math.abs(superVal) / total
  const bigPct = Math.abs(bigVal) / total
  // level 由调用方根据候选池相对排名注入，这里只返回原始数据
  return { level: 'medium', ratio: Number(ratio.toFixed(2)), superPct: Number(superPct.toFixed(2)), bigPct: Number(bigPct.toFixed(2)) }
}

/**
 * 温和放量筛选规则（精简版：技术面交给打分，这里只管风险/流动性）
 * 1. 价格：3 ~ 300 元
 * 2. 换手率：1% ~ 30%（防死票和过热）
 * 3. 最低成交额：≥ 3000 万（保证流动性，能买进卖出）
 * 4. 剔除：ST、退市、科创板、北交所
 */

export interface QuickRules {
  minPrice: number
  maxPrice: number
  minTurnover: number // 换手率下限 %
  maxTurnover: number // 换手率上限 %
  minAmount: number // 最低成交额（元）
}

export const DEFAULT_QUICK_RULES: QuickRules = {
  minPrice: 3,
  maxPrice: 300,
  minTurnover: 1,
  maxTurnover: 30,
  minAmount: 3e7, // 3000 万
}

/** 快照字段粗筛：价格、换手、成交额（无需 K 线）。 */
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
    // 换手率区间（防死票和过热）
    if (s.turnoverRate === undefined || s.turnoverRate < rules.minTurnover || s.turnoverRate > rules.maxTurnover) return false
    // 最低成交额（保证流动性）
    if (s.amount === undefined || s.amount < rules.minAmount) return false
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

/**
 * 上升趋势硬性过滤（博主规则②：只做上升趋势，拒绝抄底）
 * 判断标准（全部满足才算上升趋势）：
 * 1. MA20 > MA60（中期均线多头排列）
 * 2. 收盘价 > MA20（价格站在均线上方，非低位横盘）
 * 3. MA20 拐头向上（近 5 日 MA20 抬高）
 * 4. MA60 走平或向上（近 5 日 MA60 跌幅不超过 0.5%，排除长期仍明显下行）
 * 5. 收盘价 > MA60（价格站在长期均线上方，排除中期反弹、长期仍弱）
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
  const m60prev = ma60Arr[n - 6] // 5 交易日前
  if (m20 === null || m60 === null || m20prev === null || m60prev === null) return false

  // MA60 允许小幅走平（近 5 日跌幅不超过 0.5%），但不允许明显下行
  const ma60FlatTolerance = 0.005
  const ma60NotDropping = m60 >= m60prev * (1 - ma60FlatTolerance)

  // 均线多头 + 价格在均线上方 + MA20 向上 + MA60 走平或向上
  return (
    m20 > m60 &&
    close[n - 1] > m20 &&
    m20 > m20prev &&
    close[n - 1] > m60 &&
    ma60NotDropping
  )
}

/** 温和放量评分（替代硬过滤） */
export interface VolumeScoreResult {
  volumeScore: number       // 量能得分 0~35
  trendScore: number        // 趋势得分 0~30
  moneyScore: number        // 资金得分 0~20
  momentumScore: number     // 动量得分 0~10
  rsiScore: number          // RSI得分 0~5
  patternScore: number      // K线形态质量分 -2~+2
  totalScore: number        // 总分 0~100
  details: string[]         // 得分明细
}

/**
 * 温和放量多因子评分（与模板因子权重对齐）
 * 量能 35 + 趋势 30 + 资金 20 + 动量 10 + RSI 5 = 100
 * 总分 >= 40 才入选
 */
export function scoreGentleVolume(
  kline: Kline[],
  moneyFlowInflow: number | null,
  requireUptrend: boolean = true,
  floatMv: number = 5e9,
  moneyFlowHistory?: number[],
): VolumeScoreResult {
  const details: string[] = []
  const n = kline.length
  const close = kline.map((k) => k.close)

  // ========== 1. 量能评分（35分）==========
  let volumeScore = 0
  const volRatio = calcVolumeRatio(kline) ?? 0

  if (volRatio >= 1.3 && volRatio <= 2.0) {
    volumeScore = 35  // 最佳温和放量
    details.push('温和放量(' + volRatio.toFixed(2) + 'x) +35')
  } else if (volRatio >= 1.2 && volRatio < 1.3) {
    volumeScore = 28
    details.push('接近温和放量(' + volRatio.toFixed(2) + 'x) +28')
  } else if (volRatio > 2.0 && volRatio <= 3.0) {
    volumeScore = 22  // 放量偏大
    details.push('放量偏大(' + volRatio.toFixed(2) + 'x) +22')
  } else if (volRatio >= 0.8 && volRatio < 1.2) {
    volumeScore = 13  // 缩量
    details.push('缩量(' + volRatio.toFixed(2) + 'x) +13')
  } else if (volRatio > 3.0 && volRatio <= 5.0) {
    volumeScore = 9   // 放大量
    details.push('放大量(' + volRatio.toFixed(2) + 'x) +9')
  } else if (volRatio >= 0.5 && volRatio < 0.8) {
    volumeScore = 4   // 明显缩量
    details.push('明显缩量(' + volRatio.toFixed(2) + 'x) +4')
  } else {
    volumeScore = 0
    details.push('量能异常(' + volRatio.toFixed(2) + 'x) +0')
  }

  // ========== 2. 趋势评分（30分）==========
  let trendScore = 0
  const isUp = isUptrend(kline)

  if (isUp) {
    trendScore = 30
    details.push('上升趋势 +30')
  } else if (n >= 60) {
    const ma20 = sma(close, 20)
    const ma60 = sma(close, 60)
    const m20 = lastValid(ma20) ?? close[n - 1]
    const m60 = lastValid(ma60) ?? m20

    // MA20 > MA60（中期多头）
    if (m20 > m60) {
      trendScore += 12
      details.push('MA20>MA60 +12')
    }
    // 收盘 > MA60
    if (close[n - 1] > m60) {
      trendScore += 10
      details.push('站上MA60 +10')
    }
    // 收盘 > MA20
    if (close[n - 1] > m20) {
      trendScore += 8
      details.push('站上MA20 +8')
    }
  } else {
    details.push('数据不足，趋势0分')
  }

  if (!requireUptrend && trendScore < 12) {
    trendScore = Math.max(trendScore, 12)
    details.push('不要求上升趋势，保底+12')
  }

  // ========== 3. 资金评分（20分，多周期确认防骗线）==========
  let moneyScore = 0
  const effMv = floatMv > 0 ? floatMv : 5e9
  const inflowPct = moneyFlowInflow !== null ? (moneyFlowInflow / effMv) * 100 : null
  // 近5日历史资金（用于多周期确认）
  const hist = moneyFlowHistory && moneyFlowHistory.length > 0 ? moneyFlowHistory : null
  const hist3 = hist && hist.length >= 3 ? hist.slice(-3).reduce((a, b) => a + b, 0) : null
  const hist5 = hist && hist.length >= 5 ? hist.slice(-5).reduce((a, b) => a + b, 0) : null
  // 各周期净流入率（净流入 / 流通市值）
  const pct3 = hist3 !== null && effMv > 0 ? (hist3 / effMv) * 100 : null
  const pct5 = hist5 !== null && effMv > 0 ? (hist5 / effMv) * 100 : null

  // 当日资金分（基准 12 分）
  let dayScore = 0
  if (inflowPct !== null && inflowPct > 0.15) dayScore = 12
  else if (inflowPct !== null && inflowPct > 0.05) dayScore = 10
  else if (inflowPct !== null && inflowPct > 0) dayScore = 8
  else if (inflowPct !== null && inflowPct > -0.05) dayScore = 5
  else if (inflowPct !== null && inflowPct > -0.15) dayScore = 2
  else if (inflowPct !== null) dayScore = 0
  else dayScore = 4

  // 多周期确认（近3日/5日持续流入加分，一日游扣分）
  let multiScore = 0
  if (pct3 !== null && pct5 !== null) {
    const positiveDays = hist!.filter((v) => v > 0).length
    const todayFlow = inflowPct !== null && inflowPct > 0
    const recent3Up = hist3 !== null && hist3 > 0
    const recent5Up = hist5 !== null && hist5 > 0
    if (todayFlow && recent3Up && recent5Up) {
      multiScore = 8 // 持续流入（最佳）
      details.push('3日/5日持续流入 +8')
    } else if (recent3Up && recent5Up) {
      multiScore = 6 // 虽当日小幅波动但中期持续流入
      details.push('中期持续流入 +6')
    } else if (todayFlow && !recent3Up) {
      multiScore = -3 // 当日流入但3日累计流出 = 一日游
      details.push('单日流入但3日流出 -3')
    } else if (!todayFlow && recent5Up) {
      multiScore = 3 // 当日小幅流出但5日整体流入
      details.push('5日仍流入 +3')
    } else {
      multiScore = 0
    }
    if (positiveDays >= 4) {
      multiScore += 2 // 近5日多数天流入，真实吸筹
      details.push('5日中' + positiveDays + '日流入 +2')
    }
  } else if (pct3 !== null) {
    if (hist3 !== null && hist3 > 0) multiScore = 4
    else multiScore = -2
  }

  moneyScore = Math.max(0, Math.min(20, dayScore + multiScore))
  if (inflowPct !== null) details.push('当日资金' + (inflowPct >= 0 ? '+' : '') + inflowPct.toFixed(3) + '%')

  // ========== 4. 动量评分（10分，近20日涨幅，先加分后扣分防追高）==========
  let momentumScore = 0
  const ret20 = n > 21 && close[n - 21] > 0 ? close[n - 1] / close[n - 21] - 1 : null
  if (ret20 !== null) {
    if (ret20 >= 0.05 && ret20 <= 0.15) {
      momentumScore = 10 // 健康上涨
      details.push('1月动量健康(+' + (ret20 * 100).toFixed(1) + '%) +10')
    } else if (ret20 > 0.15 && ret20 <= 0.25) {
      momentumScore = 7 // 偏热
      details.push('1月动量偏热(+' + (ret20 * 100).toFixed(1) + '%) +7')
    } else if (ret20 > 0.25 && ret20 <= 0.4) {
      momentumScore = 4 // 过热
      details.push('1月动量过热(+' + (ret20 * 100).toFixed(1) + '%) +4')
    } else if (ret20 > 0.4) {
      momentumScore = 0 // 追高风险极大，禁止加分
      details.push('1月涨幅过大(+' + (ret20 * 100).toFixed(1) + '%) +0')
    } else if (ret20 >= -0.05) {
      momentumScore = 2 // 基本走平
      details.push('1月动量平(+' + (ret20 * 100).toFixed(1) + '%) +2')
    } else {
      momentumScore = 0 // 下跌
      details.push('1月动量弱(' + (ret20 * 100).toFixed(1) + '%) +0')
    }
  } else {
    details.push('动量数据不足')
  }

  // ========== 5. RSI 评分（5分）==========
  let rsiScore = 0
  const rsiArr = rsi(close, 14)
  const rsiVal = lastValid(rsiArr)
  if (rsiVal !== null) {
    if (rsiVal >= 45 && rsiVal <= 65) {
      rsiScore = 5
      details.push('RSI健康(' + rsiVal.toFixed(0) + ') +5')
    } else if (rsiVal >= 40 && rsiVal < 45) {
      rsiScore = 3
      details.push('RSI(' + rsiVal.toFixed(0) + ') +3')
    } else if (rsiVal >= 30 && rsiVal < 40) {
      rsiScore = 1
      details.push('RSI偏弱(' + rsiVal.toFixed(0) + ') +1')
    } else if (rsiVal >= 70 && rsiVal < 80) {
      rsiScore = 2
      details.push('RSI超买(' + rsiVal.toFixed(0) + ') +2')
    } else {
      rsiScore = 0
      details.push('RSI极端(' + (rsiVal ?? 0).toFixed(0) + ') +0')
    }
  } else {
    details.push('RSI数据不足')
  }

  // ========== 6. K线形态质量分（-2~+2）==========
  let patternScore = 0
  const patterns = detectPatterns(kline)
  for (const p of patterns) {
    if (p.signal === 'bullish' && p.reliability === 'high') patternScore += 2
    else if (p.signal === 'bullish') patternScore += 1
    else if (p.signal === 'bearish' && p.reliability === 'high') patternScore -= 2
    else if (p.signal === 'bearish') patternScore -= 1
  }
  patternScore = Math.max(-2, Math.min(2, patternScore))
  if (patternScore !== 0) {
    details.push('K线形态 ' + (patternScore > 0 ? '+' : '') + patternScore)
  }

  // ========== 7. 过热硬性扣分（独立于动量分，防追高）==========
  let totalScore = volumeScore + trendScore + moneyScore + momentumScore + rsiScore + patternScore
  const ret3 = n > 4 && close[n - 4] > 0 ? close[n - 1] / close[n - 4] - 1 : null
  const ret5 = n > 6 && close[n - 6] > 0 ? close[n - 1] / close[n - 6] - 1 : null
  // 距离MA5（乖离率）
  const ma5Val = lastValid(sma(close, 5))
  const deviation = ma5Val !== null && ma5Val > 0 ? close[n - 1] / ma5Val - 1 : null

  if (ret3 !== null && ret3 > 0.15) {
    totalScore *= 0.85
    details.push('近3日涨幅' + (ret3 * 100).toFixed(1) + '% 过热 ×0.85')
  } else if (ret3 !== null && ret3 > 0.1) {
    totalScore *= 0.92
    details.push('近3日涨幅' + (ret3 * 100).toFixed(1) + '% 偏热 ×0.92')
  }
  if (ret5 !== null && ret5 > 0.25) {
    totalScore *= 0.7
    details.push('近5日涨幅' + (ret5 * 100).toFixed(1) + '% 明显过热 ×0.7')
  }
  if (deviation !== null && deviation > 0.12) {
    totalScore *= 0.85
    details.push('乖离MA5 ' + (deviation * 100).toFixed(1) + '% 过大 ×0.85')
  }

  totalScore = Math.round(totalScore)

  return { volumeScore, trendScore, moneyScore, momentumScore, rsiScore, patternScore, totalScore, details }
}

/** K线形态检测（简化版） */
interface Pattern {
  name: string
  signal: 'bullish' | 'bearish' | 'neutral'
  reliability: 'high' | 'medium' | 'low'
}

function detectPatterns(kline: Kline[]): Pattern[] {
  if (kline.length < 10) return []
  const patterns: Pattern[] = []
  const n = kline.length
  const close = kline.map((k) => k.close)
  const open = kline.map((k) => k.open)
  const high = kline.map((k) => k.high)
  const low = kline.map((k) => k.low)

  const c = close[n - 1]
  const o = open[n - 1]
  const h = high[n - 1]
  const l = low[n - 1]
  const body = Math.abs(c - o)
  const range = h - l
  const upperShadow = h - Math.max(c, o)
  const lowerShadow = Math.min(c, o) - l

  // 锤子线：长下影 + 小实体 + 短上影（底部反转）
  if (range > 0 && lowerShadow >= body * 2 && upperShadow <= body * 0.5) {
    const atBottom = c <= Math.min(...close.slice(-10)) * 1.05
    patterns.push({ name: '锤子线', signal: atBottom ? 'bullish' : 'neutral', reliability: atBottom ? 'high' : 'medium' })
  }

  // 吞没形态
  if (n >= 2) {
    const prevClose = close[n - 2]
    const prevOpen = open[n - 2]
    if (prevClose < prevOpen && c > o && o <= prevClose && c >= prevOpen) {
      patterns.push({ name: '看涨吞没', signal: 'bullish', reliability: 'high' })
    }
    if (prevClose > prevOpen && c < o && o >= prevClose && c <= prevOpen) {
      patterns.push({ name: '看跌吞没', signal: 'bearish', reliability: 'high' })
    }
  }

  // 早晨之星
  if (n >= 3) {
    const c1 = close[n - 3]
    const o1 = open[n - 3]
    const c2 = close[n - 2]
    const o2 = open[n - 2]
    const body1 = Math.abs(c1 - o1)
    const body2 = Math.abs(c2 - o2)
    if (c1 < o1 && body1 > 0 && body2 <= body1 * 0.3 && c > o && c > c1) {
      patterns.push({ name: '早晨之星', signal: 'bullish', reliability: 'high' })
    }
  }

  // 三只乌鸦 / 红三兵
  if (n >= 3) {
    if (close[n - 1] < open[n - 1] && close[n - 2] < open[n - 2] && close[n - 3] < open[n - 3]) {
      patterns.push({ name: '三只乌鸦', signal: 'bearish', reliability: 'medium' })
    }
    if (close[n - 1] > open[n - 1] && close[n - 2] > open[n - 2] && close[n - 3] > open[n - 3]) {
      patterns.push({ name: '红三兵', signal: 'bullish', reliability: 'medium' })
    }
  }

  return patterns
}
