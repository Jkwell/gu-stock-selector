import type { Kline, MoneyFlow, StockInfo } from '../types'
import { lastValid, sma } from './indicators'

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
    // 最低成交额（保证流动性，但缺失时不强制过滤，避免整批被误杀）
    if (s.amount !== undefined && s.amount < rules.minAmount) return false
    // 剔除涨停票（涨幅>9.8%或换手率<0.3%的一字板）——买不进
    if (s.changePct !== undefined && s.changePct >= 9.8) return false
    if (s.turnoverRate !== undefined && s.turnoverRate < 0.3 && s.changePct !== undefined && s.changePct > 5) return false
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
  volumeScore: number       // 量能形态 0~25
  trendScore: number        // 短期趋势 0~15
  moneyScore: number        // 资金流向 0~25
  momentumScore: number     // 已废弃
  rsiScore: number          // 已废弃
  ma20DipScore: number      // 买点契合度 0~15
  patternScore: number      // K线形态 -5~+10
  totalScore: number        // 总分 0~100
  details: string[]         // 得分明细
}

/**
 * 温和放量多因子评分（优化版）
 * 量能 30 + 资金 20 + 趋势 15 + K线 10 + 买点 15 + 板块 10 = 100
 * 核心：缩量蓄势后首次温和放量（启动初期，还能买进）
 * 总分 >= 35 才入选
 */
export function scoreGentleVolume(
  kline: Kline[],
  moneyFlowInflow: number | null,
  _requireUptrend: boolean = true,
  floatMv: number = 5e9,
  moneyFlowHistory?: number[],
  sectorStrength?: number,
  currentPrice?: number,
): VolumeScoreResult {
  const details: string[] = []
  const n = kline.length
  const close = kline.map((k) => k.close)
  const last = close[n - 1]
  const price = currentPrice ?? last
  const volumes = kline.map((k) => k.volume)

  // K线级别涨停检测（不依赖快照数据）
  const todayGain = n >= 2 && close[n - 2] > 0 ? last / close[n - 2] - 1 : 0
  const isLimitUpToday = todayGain > 0.095

  // ========== 1. 量能形态评分（30分）==========
  // 核心特征：缩量蓄势 + 首次温和放量 + 量价齐升
  let volumeScore = 0
  const volRatio = calcVolumeRatio(kline) ?? 0

  // 缩量蓄势检测：放量前（近3日之前）是否存在缩量整理
  const vol20 = lastValid(sma(volumes, 20)) ?? 0
  const prev3Avg = n >= 5
    ? (volumes[n - 2] + volumes[n - 3] + volumes[n - 4]) / 3
    : 0
  // 蓄势：前3日均量低于20日均量（缩量整理）
  const hasShrinkBase = vol20 > 0 && prev3Avg < vol20 * 1.0
  // 首次放量：今日量 > 前3日均量 × 1.3，且前3日相对平量/缩量
  const isFirstSurge = prev3Avg > 0 && volumes[n - 1] > prev3Avg * 1.3
  // 量价齐升：今日收阳且收盘高于昨日
  const isUpDay = kline[n - 1].close > kline[n - 1].open
  const priceRising = close[n - 1] > close[n - 2]

  if (volRatio >= 1.3 && volRatio <= 2.5) {
    // 温和放量（最佳区间）
    let base = 22
    const bonuses: string[] = []
    if (hasShrinkBase) { base += 4; bonuses.push('缩量蓄势') }
    if (isFirstSurge) { base += 4; bonuses.push('首次放量') }
    volumeScore = Math.min(30, base)
    details.push('温和放量(' + volRatio.toFixed(2) + 'x)' + (bonuses.length ? '·' + bonuses.join('·') : '') + ' +' + volumeScore)
  } else if (volRatio > 2.5 && volRatio <= 4.0) {
    // 放量偏大
    let base = 16
    const bonuses: string[] = []
    if (hasShrinkBase) { base += 3; bonuses.push('缩量蓄势') }
    if (isFirstSurge) { base += 3; bonuses.push('首次放量') }
    volumeScore = Math.min(24, base)
    details.push('放量(' + volRatio.toFixed(2) + 'x)' + (bonuses.length ? '·' + bonuses.join('·') : '') + ' +' + volumeScore)
  } else if (volRatio >= 1.0 && volRatio < 1.3) {
    volumeScore = 12
    details.push('平量(' + volRatio.toFixed(2) + 'x) +12')
  } else if (volRatio >= 0.7 && volRatio < 1.0) {
    // 缩量：如果是缩量回调（价格微跌），是蓄势信号
    if (!priceRising && hasShrinkBase) {
      volumeScore = 14
      details.push('缩量回调(蓄势) +14')
    } else {
      volumeScore = 6
      details.push('缩量(' + volRatio.toFixed(2) + 'x) +6')
    }
  } else if (volRatio > 4.0) {
    volumeScore = 3
    details.push('爆量(' + volRatio.toFixed(2) + 'x) +3（警惕出货）')
  } else {
    volumeScore = 0
    details.push('极度缩量(' + volRatio.toFixed(2) + 'x) +0')
  }

  // 量价配合扣分：放量收阴/滞涨 = 出货嫌疑
  if (volRatio >= 1.5 && !isUpDay) {
    volumeScore = Math.max(0, volumeScore - 6)
    details.push('放量收阴 -6（警惕出货）')
  }

  // ========== 2. 资金流向评分（20分）==========
  let moneyScore = 0
  const effMv = floatMv > 0 ? floatMv : 5e9
  const inflowPct = moneyFlowInflow !== null ? (moneyFlowInflow / effMv) * 100 : null
  const hist = moneyFlowHistory && moneyFlowHistory.length > 0 ? moneyFlowHistory : null
  const hist3 = hist && hist.length >= 3 ? hist.slice(-3).reduce((a, b) => a + b, 0) : null
  const hist5 = hist && hist.length >= 5 ? hist.slice(-5).reduce((a, b) => a + b, 0) : null
  const pct3 = hist3 !== null && effMv > 0 ? (hist3 / effMv) * 100 : null
  const pct5 = hist5 !== null && effMv > 0 ? (hist5 / effMv) * 100 : null

  // 当日资金（10分）
  if (inflowPct !== null && inflowPct > 0.1) moneyScore += 10
  else if (inflowPct !== null && inflowPct > 0.03) moneyScore += 8
  else if (inflowPct !== null && inflowPct > 0) moneyScore += 5
  else if (inflowPct !== null && inflowPct > -0.05) moneyScore += 3
  else if (inflowPct !== null) moneyScore += 0
  else moneyScore += 4

  // 多周期确认（10分）
  if (pct3 !== null && pct5 !== null) {
    const todayFlow = inflowPct !== null && inflowPct > 0
    const recent3Up = hist3 !== null && hist3 > 0
    const recent5Up = hist5 !== null && hist5 > 0
    if (todayFlow && recent3Up && recent5Up) {
      moneyScore += 10
      details.push('3日/5日持续流入 +10')
    } else if (recent3Up && recent5Up) {
      moneyScore += 7
      details.push('中期持续流入 +7')
    } else if (todayFlow && !recent3Up) {
      moneyScore += 2
      details.push('单日流入中期流出 +2')
    } else if (recent5Up) {
      moneyScore += 4
      details.push('5日仍流入 +4')
    }
  } else if (pct3 !== null && hist3 !== null && hist3 > 0) {
    moneyScore += 5
    details.push('3日流入 +5')
  }
  moneyScore = Math.min(20, moneyScore)
  if (inflowPct !== null) details.push('当日资金' + (inflowPct >= 0 ? '+' : '') + inflowPct.toFixed(3) + '%')

  // ========== 3. 短期趋势评分（15分）==========
  let trendScore = 0
  const ma5 = lastValid(sma(close, 5))
  const ma20 = lastValid(sma(close, 20))

  if (ma5 !== null && last > ma5) {
    trendScore += 6
    details.push('站上MA5 +6')
  }
  if (ma20 !== null && last > ma20) {
    trendScore += 5
    details.push('站上MA20 +5')
  }
  if (ma5 !== null && ma20 !== null && ma5 > ma20) {
    trendScore += 4
    details.push('MA5>MA20 +4')
  }

  // ========== 4. K线形态评分（10分）==========
  let patternScore = 0
  const patterns = detectPatterns(kline)
  for (const p of patterns) {
    if (p.signal === 'bullish' && p.reliability === 'high') {
      patternScore += 5
      details.push(p.name + '(强看涨) +5')
    } else if (p.signal === 'bullish') {
      patternScore += 3
      details.push(p.name + '(看涨) +3')
    } else if (p.signal === 'bearish' && p.reliability === 'high') {
      patternScore -= 4
      details.push(p.name + '(强看跌) -4')
    } else if (p.signal === 'bearish') {
      patternScore -= 2
      details.push(p.name + '(看跌) -2')
    }
  }
  patternScore = Math.max(-5, Math.min(10, patternScore))

  // ========== 5. 买点契合度评分（15分）==========
  const lowN = Math.min(...kline.map((k) => k.low).slice(-10))
  const support = Math.max(ma5 ?? last, lowN)
  const buyLow = support * 0.97
  const buyHigh = support * 1.03
  let entryScore = 0
  if (price >= buyLow && price <= buyHigh) {
    const distFromLow = (price - buyLow) / (buyHigh - buyLow)
    entryScore = Math.round(15 - distFromLow * 6) // 低点=15, 中点=12, 高点=9
    details.push('买点区间' + buyLow.toFixed(1) + '~' + buyHigh.toFixed(1) + '（距低' + (distFromLow * 100).toFixed(0) + '%） +' + entryScore)
  } else if (price > buyHigh && price <= buyHigh * 1.05) {
    entryScore = 6
    details.push('略高于买点 +6')
  } else if (price < buyLow && price >= buyLow * 0.95) {
    entryScore = 8
    details.push('略低于买点 +8（低吸机会）')
  } else if (price > buyHigh * 1.05) {
    entryScore = 0
    details.push('远高于买点 +0（追高）')
  } else {
    entryScore = 3
    details.push('远低于买点 +3')
  }

  // ========== 6. 板块强度评分（10分）==========
  let sectorScore = 0
  if (sectorStrength !== undefined && sectorStrength > 0) {
    sectorScore = Math.round(sectorStrength * 10)
    if (sectorScore >= 7) {
      details.push('板块强势(' + (sectorStrength * 100).toFixed(0) + '%) +' + sectorScore)
    } else if (sectorScore >= 4) {
      details.push('板块偏强(' + (sectorStrength * 100).toFixed(0) + '%) +' + sectorScore)
    } else {
      details.push('板块一般(' + (sectorStrength * 100).toFixed(0) + '%) +' + sectorScore)
    }
  }

  // ========== 涨停检测 + 过热惩罚 ==========
  let totalScore = volumeScore + moneyScore + trendScore + patternScore + entryScore + sectorScore
  const ret3 = n > 4 && close[n - 4] > 0 ? last / close[n - 4] - 1 : null
  const ret5 = n > 6 && close[n - 6] > 0 ? last / close[n - 6] - 1 : null

  // 今日涨停直接判死刑（买不进）
  if (isLimitUpToday) {
    totalScore = Math.round(totalScore * 0.3)
    details.push('今日涨停 ×0.3（买不进！）')
  } else {
    // 检测近5日内是否有涨停，以及最近几天是否回调
    let limitUpDay = -1
    for (let i = Math.max(0, n - 5); i < n; i++) {
      if (i > 0 && close[i - 1] > 0) {
        const dayGain = close[i] / close[i - 1] - 1
        if (dayGain > 0.098) {
          limitUpDay = i
          break
        }
      }
    }

    if (limitUpDay >= 0) {
      const daysSinceLimitUp = n - 1 - limitUpDay
      if (daysSinceLimitUp <= 2) {
        // 涨停后1~2天，缩量回调 → 加分（低吸机会）
        totalScore += 8
        details.push('涨停后' + daysSinceLimitUp + '天回调 +8（低吸机会）')
      } else {
        // 涨停后3~5天 → 正常
        details.push('近日有涨停（+' + daysSinceLimitUp + '天前）')
      }
    }

    let penalty = 1.0
    if (ret5 !== null && ret5 > 0.35) {
      penalty = 0.8
      details.push('近5日涨' + (ret5 * 100).toFixed(1) + '% 过热 ×0.8')
    }
    if (ret3 !== null && ret3 > 0.25) {
      penalty = Math.min(penalty, 0.85)
      details.push('近3日涨' + (ret3 * 100).toFixed(1) + '% 过热 ×0.85')
    }
    totalScore = Math.round(totalScore * penalty)
  }

  return { volumeScore, trendScore, moneyScore, momentumScore: 0, rsiScore: 0, ma20DipScore: entryScore, patternScore, totalScore, details }
}

/**
 * 龙头模式评分：重仓强势度，适合选出已确认龙头、板块领涨股
 * 放量 30 + 趋势 25 + 动量 20 + 资金 15 + 板块 10 = 100
 * 总分 >= 35 才入选
 */
export interface LeaderScoreResult {
  volumeScore: number       // 放量强度 0~30
  trendScore: number        // 趋势强度 0~25
  momentumScore: number     // 动量 0~20
  moneyScore: number        // 资金 0~15
  sectorScore: number       // 板块强度 0~10
  totalScore: number        // 总分 0~100
  details: string[]         // 得分明细
}

export function scoreLeaderStock(
  kline: Kline[],
  moneyFlowInflow: number | null,
  floatMv: number = 5e9,
  moneyFlowHistory?: number[],
  sectorStrength?: number, // 0~1，板块内相对排名强度
): LeaderScoreResult {
  const details: string[] = []
  const n = kline.length
  const close = kline.map((k) => k.close)

  // ========== 1. 放量强度评分（30分，龙头不怕放量大）==========
  let volumeScore = 0
  const volRatio = calcVolumeRatio(kline) ?? 0

  if (volRatio >= 2.5) {
    volumeScore = 30  // 强势放量（龙头特征）
    details.push('强势放量(' + volRatio.toFixed(2) + 'x) +30')
  } else if (volRatio >= 2.0) {
    volumeScore = 26
    details.push('放量突破(' + volRatio.toFixed(2) + 'x) +26')
  } else if (volRatio >= 1.5) {
    volumeScore = 22
    details.push('温和放量(' + volRatio.toFixed(2) + 'x) +22')
  } else if (volRatio >= 1.2) {
    volumeScore = 16
    details.push('接近放量(' + volRatio.toFixed(2) + 'x) +16')
  } else if (volRatio >= 0.8) {
    volumeScore = 10
    details.push('平量(' + volRatio.toFixed(2) + 'x) +10')
  } else if (volRatio >= 0.5) {
    volumeScore = 5
    details.push('缩量(' + volRatio.toFixed(2) + 'x) +5')
  } else {
    volumeScore = 0
    details.push('极度缩量(' + volRatio.toFixed(2) + 'x) +0')
  }

  // ========== 2. 趋势强度评分（25分，多均线多头排列）==========
  let trendScore = 0
  const ma5 = lastValid(sma(close, 5))
  const ma20 = lastValid(sma(close, 20))
  const ma60 = lastValid(sma(close, 60))
  const last = close[n - 1]

  if (ma5 !== null && last > ma5) {
    trendScore += 6
    details.push('站上MA5 +6')
  }
  if (ma20 !== null && last > ma20) {
    trendScore += 6
    details.push('站上MA20 +6')
  }
  if (ma60 !== null && last > ma60) {
    trendScore += 6
    details.push('站上MA60 +6')
  }
  // 多头排列 bonus
  if (ma5 !== null && ma20 !== null && ma60 !== null) {
    if (ma5 > ma20 && ma20 > ma60) {
      trendScore += 7
      details.push('均线多头排列 +7')
    } else if (ma5 > ma20 || ma20 > ma60) {
      trendScore += 3
      details.push('均线偏多 +3')
    }
  }

  // ========== 3. 动量评分（20分，龙头需要强势但不追高）==========
  let momentumScore = 0
  const ret5 = n > 6 && close[n - 6] > 0 ? last / close[n - 6] - 1 : null
  const ret20 = n > 21 && close[n - 21] > 0 ? last / close[n - 21] - 1 : null

  // 5日动量（8分）
  if (ret5 !== null) {
    if (ret5 >= 0.05 && ret5 <= 0.15) {
      momentumScore += 8
      details.push('5日强势(+' + (ret5 * 100).toFixed(1) + '%) +8')
    } else if (ret5 > 0.15 && ret5 <= 0.25) {
      momentumScore += 5
      details.push('5日偏热(+' + (ret5 * 100).toFixed(1) + '%) +5')
    } else if (ret5 > 0.25) {
      momentumScore += 2
      details.push('5日过热(+' + (ret5 * 100).toFixed(1) + '%) +2')
    } else if (ret5 >= 0) {
      momentumScore += 4
      details.push('5日小涨(+' + (ret5 * 100).toFixed(1) + '%) +4')
    }
  }

  // 20日动量（12分）
  if (ret20 !== null) {
    if (ret20 >= 0.1 && ret20 <= 0.25) {
      momentumScore += 12
      details.push('20日健康上涨(+' + (ret20 * 100).toFixed(1) + '%) +12')
    } else if (ret20 > 0.25 && ret20 <= 0.4) {
      momentumScore += 7
      details.push('20日涨幅偏大(+' + (ret20 * 100).toFixed(1) + '%) +7')
    } else if (ret20 > 0.4) {
      momentumScore += 2
      details.push('20日涨幅过大(+' + (ret20 * 100).toFixed(1) + '%) +2')
    } else if (ret20 >= 0.05) {
      momentumScore += 8
      details.push('20日小涨(+' + (ret20 * 100).toFixed(1) + '%) +8')
    }
  }

  // ========== 4. 资金评分（15分）==========
  let moneyScore = 0
  const effMv = floatMv > 0 ? floatMv : 5e9
  const inflowPct = moneyFlowInflow !== null ? (moneyFlowInflow / effMv) * 100 : null
  const hist = moneyFlowHistory && moneyFlowHistory.length > 0 ? moneyFlowHistory : null
  const hist3 = hist && hist.length >= 3 ? hist.slice(-3).reduce((a, b) => a + b, 0) : null
  const hist5 = hist && hist.length >= 5 ? hist.slice(-5).reduce((a, b) => a + b, 0) : null
  const pct3 = hist3 !== null && effMv > 0 ? (hist3 / effMv) * 100 : null
  const pct5 = hist5 !== null && effMv > 0 ? (hist5 / effMv) * 100 : null

  // 当日资金（基准 9 分）
  if (inflowPct !== null && inflowPct > 0.15) moneyScore += 9
  else if (inflowPct !== null && inflowPct > 0.05) moneyScore += 7
  else if (inflowPct !== null && inflowPct > 0) moneyScore += 5
  else if (inflowPct !== null && inflowPct > -0.05) moneyScore += 3
  else if (inflowPct !== null) moneyScore += 1
  else moneyScore += 3

  // 多周期确认（6 分）
  if (pct3 !== null && pct5 !== null) {
    const todayFlow = inflowPct !== null && inflowPct > 0
    const recent3Up = hist3 !== null && hist3 > 0
    const recent5Up = hist5 !== null && hist5 > 0
    if (todayFlow && recent3Up && recent5Up) {
      moneyScore += 6
      details.push('3日/5日持续流入 +6')
    } else if (recent3Up && recent5Up) {
      moneyScore += 4
      details.push('中期持续流入 +4')
    } else if (todayFlow && !recent3Up) {
      moneyScore += 1
      details.push('单日流入 +1')
    } else if (recent5Up) {
      moneyScore += 2
      details.push('5日仍流入 +2')
    }
  }

  // ========== 5. 板块强度评分（10分）==========
  let sectorScore = 0
  if (sectorStrength !== undefined && sectorStrength > 0) {
    sectorScore = Math.round(sectorStrength * 10)
    if (sectorScore >= 7) {
      details.push('板块强势(' + (sectorStrength * 100).toFixed(0) + '%) +' + sectorScore)
    } else if (sectorScore >= 4) {
      details.push('板块偏强(' + (sectorStrength * 100).toFixed(0) + '%) +' + sectorScore)
    } else {
      details.push('板块一般(' + (sectorStrength * 100).toFixed(0) + '%) +' + sectorScore)
    }
  }

  // ========== 涨停异动加分 + 过热惩罚 ==========
  let totalScore = volumeScore + trendScore + momentumScore + moneyScore + sectorScore

  // 检测近5日内是否有涨停
  let limitUpDay = -1
  for (let i = Math.max(0, n - 5); i < n; i++) {
    if (i > 0 && close[i - 1] > 0) {
      const dayGain = close[i] / close[i - 1] - 1
      if (dayGain > 0.098) {
        limitUpDay = i
        break
      }
    }
  }

  let penalty = 1.0
  if (limitUpDay >= 0) {
    const daysSinceLimitUp = n - 1 - limitUpDay
    if (daysSinceLimitUp === 0) {
      penalty = 0.6
      details.push('今日涨停 ×0.6（买不进）')
    } else if (daysSinceLimitUp <= 2) {
      totalScore += 8
      details.push('涨停后' + daysSinceLimitUp + '天回调 +8（低吸机会）')
    } else {
      details.push('近日有涨停（+' + daysSinceLimitUp + '天前）')
    }
  }
  // 5日涨幅 > 40% 才认为过热
  if (ret5 !== null && ret5 > 0.4) {
    penalty = Math.min(penalty, 0.8)
    details.push('5日涨' + (ret5 * 100).toFixed(1) + '% 过热 ×0.8')
  }
  // 20日涨幅 > 60% 才认为过热
  if (ret20 !== null && ret20 > 0.6) {
    penalty = Math.min(penalty, 0.75)
    details.push('20日涨' + (ret20 * 100).toFixed(1) + '% 过热 ×0.75')
  }

  totalScore = Math.round(totalScore * penalty)

  return { volumeScore, trendScore, momentumScore, moneyScore, sectorScore, totalScore, details }
}

/** K线形态检测（简化版） */
interface Pattern {
  name: string
  signal: 'bullish' | 'bearish' | 'neutral'
  reliability: 'high' | 'medium' | 'low'
}

/**
 * 短线模式评分：聚焦真正影响隔夜涨跌的因子
 * 量能 25 + 资金 25 + 趋势 15 + 板块 14 + K线形态 10 + 买点契合 10 + 风险过滤 5 = 104
 * 总分 >= 40 才入选
 */
export interface ShortTermScoreResult {
  volumeScore: number       // 量能形态 0~25
  moneyScore: number        // 资金流向 0~25
  trendScore: number        // 短期趋势 0~15
  sectorScore: number       // 板块强度 0~14
  patternScore: number      // K线形态 0~10
  entryScore: number        // 买点契合度 0~10
  riskScore: number         // 风险过滤 0~5
  totalScore: number        // 总分 0~104
  details: string[]         // 得分明细
}

export function scoreShortTerm(
  kline: Kline[],
  moneyFlowInflow: number | null,
  floatMv: number = 5e9,
  moneyFlowHistory?: number[],
  sectorStrength?: number,
  marketTemperature?: number,
  currentPrice?: number,
): ShortTermScoreResult {
  const details: string[] = []
  const n = kline.length
  const close = kline.map((k) => k.close)
  const last = close[n - 1]
  const price = currentPrice ?? last

  // ========== 1. 量能形态评分（28分）==========
  let volumeScore = 0
  const volRatio = calcVolumeRatio(kline) ?? 0
  const volIncreasing = n >= 4 &&
    kline[n-1].volume > kline[n-2].volume &&
    kline[n-2].volume > kline[n-3].volume

  if (volRatio >= 1.3 && volRatio <= 2.5) {
    volumeScore = volIncreasing ? 25 : 20
    details.push('温和放量(' + volRatio.toFixed(2) + 'x)' + (volIncreasing ? '递增+25' : '+20'))
  } else if (volRatio > 2.5 && volRatio <= 4.0) {
    volumeScore = volIncreasing ? 18 : 14
    details.push('放量(' + volRatio.toFixed(2) + 'x)' + (volIncreasing ? '递增+18' : '+14'))
  } else if (volRatio >= 1.0 && volRatio < 1.3) {
    volumeScore = 12
    details.push('平量(' + volRatio.toFixed(2) + 'x) +12')
  } else if (volRatio >= 0.7 && volRatio < 1.0) {
    volumeScore = 6
    details.push('缩量(' + volRatio.toFixed(2) + 'x) +6')
  } else if (volRatio > 4.0) {
    volumeScore = 3
    details.push('爆量(' + volRatio.toFixed(2) + 'x) +3（警惕出货）')
  } else {
    volumeScore = 0
    details.push('极度缩量(' + volRatio.toFixed(2) + 'x) +0')
  }

  // ========== 2. 资金流向评分（28分）==========
  let moneyScore = 0
  const effMv = floatMv > 0 ? floatMv : 5e9
  const inflowPct = moneyFlowInflow !== null ? (moneyFlowInflow / effMv) * 100 : null
  const hist = moneyFlowHistory && moneyFlowHistory.length > 0 ? moneyFlowHistory : null
  const hist3 = hist && hist.length >= 3 ? hist.slice(-3).reduce((a, b) => a + b, 0) : null
  const hist5 = hist && hist.length >= 5 ? hist.slice(-5).reduce((a, b) => a + b, 0) : null
  const pct3 = hist3 !== null && effMv > 0 ? (hist3 / effMv) * 100 : null
  const pct5 = hist5 !== null && effMv > 0 ? (hist5 / effMv) * 100 : null

  if (inflowPct !== null && inflowPct > 0.15) moneyScore += 12
  else if (inflowPct !== null && inflowPct > 0.05) moneyScore += 10
  else if (inflowPct !== null && inflowPct > 0) moneyScore += 6
  else if (inflowPct !== null && inflowPct > -0.05) moneyScore += 3
  else if (inflowPct !== null) moneyScore += 0
  else moneyScore += 4

  if (pct3 !== null && pct5 !== null) {
    const todayFlow = inflowPct !== null && inflowPct > 0
    const recent3Up = hist3 !== null && hist3 > 0
    const recent5Up = hist5 !== null && hist5 > 0
    if (todayFlow && recent3Up && recent5Up) {
      moneyScore += 13
      details.push('3日/5日持续流入 +13')
    } else if (recent3Up && recent5Up) {
      moneyScore += 8
      details.push('中期持续流入 +8')
    } else if (todayFlow && !recent3Up) {
      moneyScore += 2
      details.push('单日流入但中期流出 +2')
    } else if (recent5Up) {
      moneyScore += 5
      details.push('5日仍流入 +5')
    }
  } else if (pct3 !== null && hist3 !== null && hist3 > 0) {
    moneyScore += 7
    details.push('3日流入 +7')
  }

  // ========== 3. 短期趋势评分（15分）==========
  let trendScore = 0
  const ma5 = lastValid(sma(close, 5))
  const ma20 = lastValid(sma(close, 20))

  if (ma5 !== null && last > ma5) {
    trendScore += 6
    details.push('站上MA5 +6')
  }
  if (ma20 !== null && last > ma20) {
    trendScore += 5
    details.push('站上MA20 +5')
  }
  if (ma5 !== null && ma20 !== null && ma5 > ma20) {
    trendScore += 4
    details.push('MA5>MA20 +4')
  }

  // ========== 4. 板块强度评分（14分）==========
  let sectorScore = 0
  if (sectorStrength !== undefined && sectorStrength > 0) {
    sectorScore = Math.round(sectorStrength * 14)
    if (sectorScore >= 9) {
      details.push('板块强势(' + (sectorStrength * 100).toFixed(0) + '%) +' + sectorScore)
    } else if (sectorScore >= 5) {
      details.push('板块偏强(' + (sectorStrength * 100).toFixed(0) + '%) +' + sectorScore)
    } else {
      details.push('板块一般(' + (sectorStrength * 100).toFixed(0) + '%) +' + sectorScore)
    }
  } else if (marketTemperature !== undefined && marketTemperature >= 50) {
    sectorScore = Math.round((marketTemperature / 100) * 7)
    details.push('大盘偏暖 +' + sectorScore)
  }

  // ========== 5. K线形态评分（10分）==========
  let patternScore = 0
  const patterns = detectPatterns(kline)
  for (const p of patterns) {
    if (p.signal === 'bullish' && p.reliability === 'high') {
      patternScore += 5
      details.push(p.name + '(强看涨) +5')
    } else if (p.signal === 'bullish') {
      patternScore += 3
      details.push(p.name + '(看涨) +3')
    } else if (p.signal === 'bearish' && p.reliability === 'high') {
      patternScore -= 4
      details.push(p.name + '(强看跌) -4')
    } else if (p.signal === 'bearish') {
      patternScore -= 2
      details.push(p.name + '(看跌) -2')
    }
  }
  patternScore = Math.max(-5, Math.min(10, patternScore))

  // ========== 6. 买点契合度评分（10分）==========
  // 计算支撑位和买点区间
  const lowN = Math.min(...kline.map((k) => k.low).slice(-10))
  const support = Math.max(ma5 ?? last, lowN)
  const buyLow = support * 0.97
  const buyHigh = support * 1.03
  let entryScore = 0
  if (price >= buyLow && price <= buyHigh) {
    // 在买点区间内：越靠近低点分越高
    const distFromLow = (price - buyLow) / (buyHigh - buyLow) // 0=最低, 1=最高
    entryScore = Math.round(10 - distFromLow * 4) // 低点=10分, 中点=8分, 高点=6分
    details.push('买点区间' + buyLow.toFixed(1) + '~' + buyHigh.toFixed(1) + '（距低' + (distFromLow * 100).toFixed(0) + '%） +' + entryScore)
  } else if (price > buyHigh && price <= buyHigh * 1.05) {
    entryScore = 4
    details.push('略高于买点（+' + (((price - buyHigh) / buyHigh) * 100).toFixed(1) + '%） +4')
  } else if (price < buyLow && price >= buyLow * 0.95) {
    entryScore = 7
    details.push('略低于买点（' + (((price - buyLow) / buyLow) * 100).toFixed(1) + '%） +7（低吸机会）')
  } else if (price > buyHigh * 1.05) {
    entryScore = 0
    details.push('远高于买点（+' + (((price - buyHigh) / buyHigh) * 100).toFixed(1) + '%） +0（追高）')
  } else {
    entryScore = 3
    details.push('远低于买点 +3（可能还在磨底）')
  }

  // ========== 7. 风险过滤评分（5分）==========
  let riskScore = 5
  if (ma5 !== null && ma5 > 0) {
    const deviation = last / ma5 - 1
    if (deviation > 0.15) {
      riskScore -= 3
      details.push('乖离MA5过大(' + (deviation * 100).toFixed(1) + '%) -3')
    }
  }
  const ret3 = n > 4 && close[n - 4] > 0 ? last / close[n - 4] - 1 : null
  if (ret3 !== null && ret3 > 0.2) {
    riskScore -= 2
    details.push('近3日涨' + (ret3 * 100).toFixed(0) + '%过热 -2')
  }
  riskScore = Math.max(0, riskScore)

  // 涨停异动：今日涨停扣分，涨停后回调加分
  let totalScore = volumeScore + moneyScore + trendScore + sectorScore + patternScore + entryScore + riskScore
  let limitUpDay = -1
  for (let i = Math.max(0, n - 5); i < n; i++) {
    if (i > 0 && close[i - 1] > 0) {
      const dayGain = close[i] / close[i - 1] - 1
      if (dayGain > 0.098) {
        limitUpDay = i
        break
      }
    }
  }
  if (limitUpDay >= 0) {
    const daysSinceLimitUp = n - 1 - limitUpDay
    if (daysSinceLimitUp === 0) {
      totalScore = Math.round(totalScore * 0.6)
      details.push('今日涨停 ×0.6（买不进）')
    } else if (daysSinceLimitUp <= 2) {
      totalScore += 8
      details.push('涨停后' + daysSinceLimitUp + '天回调 +8（低吸机会）')
    } else {
      details.push('近日有涨停（+' + daysSinceLimitUp + '天前）')
    }
  }

  return { volumeScore, moneyScore, trendScore, sectorScore, patternScore, entryScore, riskScore, totalScore, details }
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
