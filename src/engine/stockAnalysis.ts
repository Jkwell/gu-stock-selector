import type { Kline } from '../types'
import { lastValid, macd, rsi, sma } from './indicators'
import { computeTradingSignal, isOneWordLimitUp, type TradingSignal } from './tradingSignals'
import type { MarketSentiment } from './marketSentiment'

/**
 * 单只股票买卖点分析引擎（纯函数）
 * 输入日 K 线 + 实时价，输出：
 *   - 综合结论（适合买 / 观望 / 不适合买）
 *   - 买入区间 / 止盈 / 止损
 *   - 逐项技术检查（趋势/MACD/RSI/量能/买点可及/风险回报）+ 可解释理由
 *   - 大盘情绪作为总闸门（冰点时只降级不抬分）
 */

export type Verdict = 'buy' | 'watch' | 'avoid'

export interface StockCheck {
  key: string
  label: string
  pass: boolean
  weight: number
  detail: string
}

export interface StockAnalysis {
  code: string
  name: string
  price: number
  changePct?: number
  verdict: Verdict
  verdictLabel: string
  verdictIcon: string
  score: number // 0-100 综合得分
  checks: StockCheck[]
  signal: TradingSignal | null
  indicators: {
    ma5: number | null
    ma20: number | null
    ma60: number | null
    ma20Slope: number | null // MA20 相对 2 日前方向（正=向上）
    rsi: number | null
    macdHist: number
    macdHistPrev: number
    volumeRatio: number | null // 当日量 / 20 日均量
    trendLabel: string
    oneWord: boolean
    limitUpDays: number // 连续涨停天数
  }
  summary: string
}

const round2 = (v: number) => Number(v.toFixed(2))

/** 判断趋势状态 */
function trendLabelOf(price: number, ma20: number | null, ma60: number | null): string {
  if (ma20 === null) return '数据不足'
  if (price > ma20 && (ma60 === null || ma20 > ma60)) return '多头排列'
  if (price < ma20 && (ma60 === null || ma20 < ma60)) return '空头排列'
  return '震荡整理'
}

/** 单只股票完整分析 */
export function analyzeStock(
  code: string,
  name: string,
  kline: Kline[],
  currentPrice?: number,
  sentiment?: MarketSentiment | null,
): StockAnalysis | null {
  if (kline.length < 30) return null

  const close = kline.map((k) => k.close)
  const volume = kline.map((k) => k.volume)
  const n = kline.length

  const price = currentPrice ?? close[n - 1]
  if (!Number.isFinite(price) || price <= 0) return null

  const signal = computeTradingSignal(kline, price, false)

  // ---- 指标 ----
  const ma5 = lastValid(sma(close, 5))
  const ma20 = lastValid(sma(close, 20))
  const ma60 = lastValid(sma(close, 60))
  const ma20Arr = sma(close, 20)
  const ma20Prev = ma20Arr[n - 3] ?? ma20
  const ma20Slope = ma20 !== null && ma20Prev !== null ? ma20 - ma20Prev : null

  const m = macd(close)
  const macdHist = m.hist[n - 1]
  const macdHistPrev = m.hist[n - 2] ?? 0

  const rsiArr = rsi(close, 14)
  const rsiVal = lastValid(rsiArr)

  const vol20 = sma(volume, 20)
  const vol20Val = vol20[n - 1]
  const volumeRatio = vol20Val && vol20Val > 0 ? volume[n - 1] / vol20Val : null

  const limitUpDays = (() => {
    const TH = 0.095
    let days = 0
    for (let j = n - 1; j >= 1; j--) {
      const prev = kline[j - 1].close
      if (prev <= 0) break
      if (kline[j].close / prev - 1 >= TH) days++
      else break
    }
    return days
  })()

  const oneWord = isOneWordLimitUp(kline, 0.095)
  const highRisk = limitUpDays >= 5 || (limitUpDays >= 2 && (volumeRatio ?? 0) >= 6)

  // ---- 逐项检查 ----
  const checks: StockCheck[] = []

  // ① 趋势
  {
    const pass = ma20 !== null && price > ma20 && (ma60 === null || ma20 > ma60)
    const detail = ma20 === null
      ? '均线数据不足'
      : `现价 ${round2(price)}，MA20 ${round2(ma20)}，MA60 ${ma60 ? round2(ma60) : '--'}（${trendLabelOf(price, ma20, ma60)}）`
    checks.push({ key: 'trend', label: '上升趋势', pass, weight: 3, detail })
  }
  // ② MACD 动能
  {
    const pass = macdHist > 0
    const detail = `MACD 柱 ${round2(macdHist)}（${macdHist > 0 ? '红柱·多方' : '绿柱·空方'}）`
    checks.push({ key: 'macd', label: 'MACD 动量', pass, weight: 2, detail })
  }
  // ③ RSI 状态
  {
    const pass = rsiVal !== null && rsiVal >= 40 && rsiVal <= 70
    const detail = rsiVal === null
      ? 'RSI 数据不足'
      : `RSI14 ${round2(rsiVal)}（${rsiVal > 75 ? '超买·谨慎追高' : rsiVal < 30 ? '超卖·下跌趋势' : '健康区'}）`
    checks.push({ key: 'rsi', label: 'RSI 状态', pass, weight: 2, detail })
  }
  // ④ 量能配合
  {
    const pass = volumeRatio !== null && volumeRatio >= 1 && volumeRatio <= 8
    const detail = volumeRatio === null
      ? '量能数据不足'
      : `量比 ${round2(volumeRatio)}（当日量/20日均量${volumeRatio >= 1.2 && volumeRatio <= 5 ? '，温和放量' : volumeRatio > 5 ? '，放量过大注意分歧' : '，缩量'}）`
    checks.push({ key: 'volume', label: '量能配合', pass, weight: 1, detail })
  }
  // ⑤ 买点可及（现价靠近支撑，回踩可低吸）
  if (signal) {
    const gapPct = ((price - signal.buyLow) / signal.buyLow) * 100
    const pass = gapPct <= 5
    const detail = `现价距买入区间下沿 ${round2(signal.buyLow)} 约 ${gapPct.toFixed(1)}%（${gapPct <= 5 ? '回踩可低吸' : '已偏离支撑，追高需谨慎'}）`
    checks.push({ key: 'buygap', label: '买点可及', pass, weight: 2, detail })
  }
  // ⑥ 风险回报比
  if (signal) {
    const pass = signal.riskReward >= 1.0
    const detail = `风险回报比 ${signal.riskReward}（止盈距 ${round2(signal.takeProfit)}，止损距 ${round2(signal.stopLoss)}）`
    checks.push({ key: 'riskreward', label: '风险回报', pass, weight: 2, detail })
  }

  // 大盘情绪作为总闸门（只降级、不抬分），单独记录
  let sentimentNote: string | null = null
  if (sentiment) {
    sentimentNote =
      sentiment.level === 'cold'
        ? `🧊 大盘情绪 ${sentiment.temperature}°（${sentiment.advice}），今天不建议开新仓`
        : sentiment.level === 'hot'
          ? `🔥 大盘情绪 ${sentiment.temperature}°，可积极参与`
          : `😐 大盘情绪 ${sentiment.temperature}°，谨慎参与`
  }

  // ---- 一票否决 ----
  let score = 0
  let maxScore = 0
  for (const c of checks) {
    maxScore += c.weight
    if (c.pass) score += c.weight
  }
  const scorePct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0

  let verdict: Verdict
  let verdictLabel: string
  let verdictIcon: string

  if (oneWord) {
    verdict = 'avoid'
    verdictLabel = '一字板买不进'
    verdictIcon = '⛔'
  } else if (highRisk) {
    verdict = 'avoid'
    verdictLabel = '高位风险'
    verdictIcon = '🔴'
  } else if (price <= (signal?.stopLoss ?? -Infinity)) {
    verdict = 'avoid'
    verdictLabel = '已破止损'
    verdictIcon = '🔻'
  } else if (scorePct >= 70) {
    verdict = 'buy'
    verdictLabel = '适合买入'
    verdictIcon = '✅'
  } else if (scorePct >= 45) {
    verdict = 'watch'
    verdictLabel = '观望等待'
    verdictIcon = '⏳'
  } else {
    verdict = 'avoid'
    verdictLabel = '不建议买入'
    verdictIcon = '❌'
  }

  // 大盘情绪总闸门：冰点时「适合买入」降为「观望」
  if (verdict === 'buy' && sentiment?.level === 'cold') {
    verdict = 'watch'
    verdictLabel = '观望等待'
    verdictIcon = '⏳'
  }

  // ---- 综合摘要 ----
  const passList = checks.filter((c) => c.pass).map((c) => c.label)
  const failList = checks.filter((c) => !c.pass).map((c) => c.label)
  let summary: string
  if (oneWord) {
    summary = '今日一字涨停封板，正常挂单买不进，不建议追。等开板回调到支撑位再看。'
  } else if (highRisk) {
    summary = `已连续 ${limitUpDays} 个涨停，短期涨幅过大，追高风险极高，建议回避。`
  } else if (price <= (signal?.stopLoss ?? -Infinity)) {
    summary = '现价已跌破止损位，趋势走坏，不建议买入。'
  } else if (verdict === 'buy') {
    summary = `技术面 ${passList.join('、') || '整体健康'}，回踩支撑可分批低吸，到止盈位减仓、破止损坚决离场。`
  } else if (verdict === 'watch') {
    summary = `有${passList.join('、') || '部分'}积极信号，但${failList.join('、') || '存在不确定性'}，建议等更明确信号（回踩支撑不破 / MACD 翻红）再介入。`
  } else {
    summary = `技术面偏弱（${failList.join('、') || '多项指标不配合'}），当前不是好的买点，建议观望或选更强势的标的。`
  }
  if (sentimentNote) summary = `${summary}${summary.endsWith('。') ? '' : '。'} ${sentimentNote}`

  return {
    code,
    name,
    price: round2(price),
    verdict,
    verdictLabel,
    verdictIcon,
    score: scorePct,
    checks,
    signal,
    indicators: {
      ma5: ma5 !== null ? round2(ma5) : null,
      ma20: ma20 !== null ? round2(ma20) : null,
      ma60: ma60 !== null ? round2(ma60) : null,
      ma20Slope: ma20Slope !== null ? round2(ma20Slope) : null,
      rsi: rsiVal !== null ? round2(rsiVal) : null,
      macdHist: round2(macdHist),
      macdHistPrev: round2(macdHistPrev),
      volumeRatio: volumeRatio !== null ? round2(volumeRatio) : null,
      trendLabel: trendLabelOf(price, ma20, ma60),
      oneWord,
      limitUpDays,
    },
    summary,
  }
}
