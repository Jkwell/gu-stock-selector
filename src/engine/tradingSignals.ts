import type { Kline, StockInfo } from '../types'
import { atr, lastValid, macd, rsi, sma, annualizedVol } from './indicators'

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
 *   - 止盈目标（前期高点）
 *   - 止损价（ATR 波动率止损，结合支撑位）
 * 并额外识别「突破箱体 / 打开空间」趋势启动信号。
 */

export interface BoxBreakoutSignal {
  active: boolean // 是否处于突破状态（刚突破或已站稳箱体上方）
  inBox: boolean // 是否处于横盘箱体内（还没突破）
  boxHigh: number // 箱体上沿
  boxLow: number // 箱体下沿
  boxHeight: number // 箱体高度（上沿-下沿）
  boxDays: number // 箱体持续天数（横盘时间）
  measuredTarget: number // 打开空间目标（箱体高度投影）
  breakoutDay: boolean // 是否当日放量突破
  sinceBreakout: number // 突破后天数（0 = 当日）
  volumeSurge: number // 突破当日量比
  buyLow: number // 突破买入下沿（回踩箱体上沿）
  buyHigh: number // 突破买入上沿（突破位）
  stopLoss: number // 突破止损（箱体上沿下方，假突破即离场）
  riskReward: number // 打开空间的风险回报比
}

/** 企稳相关指标（含综合判断结论） */
export interface StabilizationAnalysis {
  aboveMa20: boolean // 收盘是否站上 MA20
  aboveMa60: boolean // 收盘是否站上 MA60
  ma20: number // MA20 值
  ma60: number // MA60 值
  macdHist: number // 最新 MACD 柱值
  macdHistPrev: number // 前一根 MACD 柱值
  macdTrend: 'improving' | 'deteriorating' // 柱体是放大（转好）还是缩小
  volRatio: number // 当日量 / 前5日均量（放量>1 缩量<1）
  makeNewLow: boolean // 近5日是否创出近20日新低（破位）
  nearLow: boolean // 现价距近20日低点是否 ≤3%（还在低位）
  distToMa20Pct: number // 现价距 MA20 的百分比（正=上方）
  rsi: number | null // RSI(14)
  priceVsBox: 'inside' | 'above' | 'below' // 现价相对箱体的位置
  verdict: StabilizationVerdict // 综合企稳判断结论
}

/** 企稳综合判断结论（多因子评分） */
export interface StabilizationVerdict {
  label: '已企稳' | '企稳中' | '观察等待' | '未企稳'
  score: number // -10 ~ +10 综合评分
  color: 'good' | 'mid' | 'warn' | 'bad'
  confidence: 'high' | 'medium' | 'low' // 信号一致度
  signals: string[] // 触发的主要信号（正面）
  risks: string[] // 主要风险点（负面）
  summary: string // 一句话总结
}

export interface TradingSignal {
  currentPrice: number // 尾盘实时价
  buyLow: number // 买入区间下沿
  buyHigh: number // 买入区间上沿
  takeProfit: number // 止盈目标价
  stopLoss: number // 止损价
  riskReward: number // 风险回报比
  trailingStop: number // 移动止盈价（最高价回撤N%）
  reasons: string[] // 可解释理由
  box?: BoxBreakoutSignal // 箱体状态（常态存在，含未突破）
  stability?: StabilizationAnalysis // 企稳相关指标
}

const round2 = (v: number) => Number(v.toFixed(2))

// ── ATR 波动率止损参数 ──
const ATR_PERIOD = 14 // ATR 周期（与 RSI 同周期，业界默认）
const ATR_MULT = 2.0 // 默认止损 = 现价 - k×ATR；短线模式收紧到 1.5
const MAX_LOSS_PCT = 0.08 // 止损距离上限 -8%（异常大 ATR 钳制）
const MIN_LOSS_PCT = 0.04 // 止损距离下限 -4%（横盘 ATR 过小钳制，避免 2% 日波被轻易扫损）

// ── 箱体突破参数 ──
const BOX_LOOKBACK = 60 // 箱体识别回看窗口（交易日）
const BOX_EXCLUDE_LAST = 5 // 排除最近 N 天（避免突破当天污染箱体边界）
const BOX_HEIGHT_MAX = 0.12 // 箱体高度上限（相对箱体中枢），>12% 视为非横盘
const BOX_MIN_DAYS = 25 // 箱体最少持续天数（横盘太短不算有效箱体）
const BOX_MIN_HEIGHT = 0.02 // 箱体高度下限，避免把微幅波动当箱体
const BOX_VOLUME_SURGE = 1.5 // 突破当日量比阈值

/**
 * 识别「箱体 / 突破 / 打开空间」状态（常态返回，不只突破时）
 * 逻辑：
 *  1. 取近 BOX_LOOKBACK 日（剔除最近 BOX_EXCLUDE_LAST 天）的高低点 → 箱体上下沿
 *  2. 箱体高度足够小（横盘）且持续时间足够长 → 判定为横盘箱体（inBox=true）
 *  3. 现价突破箱体上沿（当日放量突破 或 已站稳上方）→ 激活突破信号
 *  4. 打开空间 = 箱体高度投影（箱体上沿 + 箱体高度）
 *  5. 止损 = 箱体上沿下方（跌破=假突破离场）
 *  无有效箱体（单边趋势/剧烈波动）时返回 null，由调用方显示"趋势中"状态。
 */
export function detectBoxBreakout(kline: Kline[]): BoxBreakoutSignal | null {
  if (kline.length < BOX_MIN_DAYS + BOX_EXCLUDE_LAST + 5) return null
  const close = kline.map((k) => k.close)
  const high = kline.map((k) => k.high)
  const low = kline.map((k) => k.low)
  const volume = kline.map((k) => k.volume)
  const n = kline.length

  // 箱体区间：从窗口起点到"最近排除段"之前（数据不足时用更早起点）
  const start = Math.max(0, n - BOX_LOOKBACK)
  const end = n - BOX_EXCLUDE_LAST // 不含最后 EXCLUDE 天
  if (end <= start) return null
  const boxHigh = Math.max(...high.slice(start, end))
  const boxLow = Math.min(...low.slice(start, end))
  const boxCenter = (boxHigh + boxLow) / 2
  const boxHeight = boxHigh - boxLow
  if (boxCenter <= 0) return null
  // 横盘判定：高度相对中枢足够小，且有一定厚度
  const heightRatio = boxHeight / boxCenter
  const inBox = heightRatio <= BOX_HEIGHT_MAX && heightRatio >= BOX_MIN_HEIGHT
  if (!inBox) return null // 非横盘（趋势中/剧烈波动），不判箱体
  const boxDays = end - start

  const price = close[n - 1]
  const prevClose = close[n - 2]
  if (!Number.isFinite(price) || price <= 0) return null

  // 突破判定：现价高于箱体上沿
  const aboveBox = price > boxHigh

  // 当日放量突破：最新一根放量且收盘突破
  const todayVol = volume[n - 1]
  const avgVol = lastValid(sma(volume.slice(0, n - 1), 5)) // 突破前 5 日均量（不含当日）
  const volumeSurge = avgVol && avgVol > 0 ? todayVol / avgVol : 0
  const breakoutDay =
    aboveBox && volumeSurge > BOX_VOLUME_SURGE && prevClose <= boxHigh

  // 突破后天数（0 = 当日突破）
  let sinceBreakout = 0
  if (aboveBox && !breakoutDay) {
    for (let i = n - 1; i > end - 1 && i >= 0; i--) {
      if (close[i] <= boxHigh) break
      sinceBreakout++
    }
  }

  const active = aboveBox

  // 打开空间：箱体高度投影
  const measuredTarget = boxHigh + boxHeight

  // 突破买入区间：回踩箱体上沿到突破位
  const buyHigh = round2(price)
  const buyLow = round2(Math.max(boxHigh, price - boxHeight * 0.25))

  // 突破止损：箱体上沿下方 1%（跌破=假突破）
  const stopLoss = round2(Math.min(boxHigh * 0.99, price - boxHeight * 0.2))
  // 止损钳制：距现价不超 8%
  const clampedStop = Math.max(stopLoss, price * (1 - MAX_LOSS_PCT))
  const finalStop = clampedStop >= price ? price * 0.98 : clampedStop

  const upside = measuredTarget - price
  const downside = price - finalStop
  const riskReward = downside > 0 ? Number((upside / downside).toFixed(2)) : 0

  return {
    active,
    inBox,
    boxHigh: round2(boxHigh),
    boxLow: round2(boxLow),
    boxHeight: round2(boxHeight),
    boxDays,
    measuredTarget: round2(measuredTarget),
    breakoutDay,
    sinceBreakout,
    volumeSurge: Number(volumeSurge.toFixed(2)),
    buyLow,
    buyHigh,
    stopLoss: finalStop,
    riskReward,
  }
}

/**
 * 企稳综合判断（多因子评分系统）
 * 评分逻辑：每个信号贡献正/负分，最终汇总为结论
 *  - 已企稳(score>=6): 多数指标向好，可关注
 *  - 企稳中(score 3-5): 部分转好，需观察
 *  - 观察等待(score 0-2): 信号不明确
 *  - 未企稳(score<0): 多数指标仍弱
 */
function judgeStabilization(p: {
  aboveMa20: boolean
  aboveMa60: boolean
  macdTrend: 'improving' | 'deteriorating'
  makeNewLow: boolean
  nearLow: boolean
  rsi: number | null
  volRatio: number
  priceVsBox: 'inside' | 'above' | 'below'
  distToMa20Pct: number
}): StabilizationVerdict {
  let score = 0
  const signals: string[] = []
  const risks: string[] = []

  // 1. 均线位置（权重最高，趋势核心）
  if (p.aboveMa20) {
    score += 2
    signals.push('站上MA20')
  } else {
    score -= 1
    risks.push('跌破MA20')
  }
  if (p.aboveMa60) {
    score += 2
    signals.push('站上MA60')
  } else {
    score -= 1
    risks.push('跌破MA60')
  }

  // 2. MACD 柱方向（动能）
  if (p.macdTrend === 'improving') {
    score += 2
    signals.push('MACD柱放大(动能转强)')
  } else {
    score -= 1
    risks.push('MACD柱收窄(动能减弱)')
  }

  // 3. 是否创新低（最关键——创新低=没企稳）
  if (!p.makeNewLow) {
    score += 2
    signals.push('未创新低(止跌)')
  } else {
    score -= 3
    risks.push('创20日新低(破位)')
  }

  // 4. RSI 位置
  if (p.rsi !== null) {
    if (p.rsi >= 40 && p.rsi <= 70) {
      score += 1
      signals.push(`RSI健康(${p.rsi.toFixed(0)})`)
    } else if (p.rsi < 30) {
      score -= 1
      risks.push(`RSI超卖(${p.rsi.toFixed(0)})`)
    } else if (p.rsi > 70) {
      risks.push(`RSI超买(${p.rsi.toFixed(0)})`)
    }
  }

  // 5. 量能配合
  if (p.volRatio >= 0.8 && p.volRatio <= 1.3) {
    score += 1
    signals.push('量能温和')
  } else if (p.volRatio < 0.6) {
    score -= 1
    risks.push('量能过低(缩量)')
  }

  // 6. 相对箱体位置
  if (p.priceVsBox === 'above') {
    score += 2
    signals.push('突破箱体上方')
  } else if (p.priceVsBox === 'below') {
    score -= 2
    risks.push('跌破箱体下方')
  }

  // 结论判定
  let label: StabilizationVerdict['label']
  let color: StabilizationVerdict['color']
  if (score >= 6) {
    label = '已企稳'
    color = 'good'
  } else if (score >= 3) {
    label = '企稳中'
    color = 'mid'
  } else if (score >= 0) {
    label = '观察等待'
    color = 'warn'
  } else {
    label = '未企稳'
    color = 'bad'
  }

  // 信号一致度（正面信号占比）
  const totalSignals = signals.length + risks.length
  const confidence: StabilizationVerdict['confidence'] =
    totalSignals === 0 ? 'low' : signals.length / totalSignals >= 0.7 ? 'high' : signals.length / totalSignals >= 0.4 ? 'medium' : 'low'

  const summary =
    label === '已企稳'
      ? `多指标共振企稳（${signals.slice(0, 3).join('、')}），可关注低吸机会`
      : label === '企稳中'
        ? `部分信号转好（${signals.slice(0, 2).join('、') || '暂无'}），但${risks[0] || '仍需确认'}，继续观察`
        : label === '观察等待'
          ? `信号不明确，${risks[0] || '暂无方向'}，建议等待`
          : `多数指标偏弱（${risks.slice(0, 2).join('、') || '暂无'}），暂不建议参与`

  return { label, score, color, confidence, signals, risks, summary }
}

/** 企稳相关指标（含综合判断结论） */
export function analyzeStabilization(kline: Kline[]): StabilizationAnalysis {
  const close = kline.map((k) => k.close)
  const low = kline.map((k) => k.low)
  const volume = kline.map((k) => k.volume)
  const n = close.length

  const price = close[n - 1]
  const ma20 = lastValid(sma(close, 20)) ?? price
  const ma60 = lastValid(sma(close, 60)) ?? ma20
  const aboveMa20 = price > ma20
  const aboveMa60 = price > ma60
  const distToMa20Pct = ma20 > 0 ? Number((((price - ma20) / ma20) * 100).toFixed(2)) : 0

  const m = macd(close)
  const macdHist = m.hist[n - 1]
  const macdHistPrev = m.hist[n - 2] ?? macdHist
  const macdTrend = macdHist >= macdHistPrev ? 'improving' : 'deteriorating'

  const avgVol5 = lastValid(sma(volume, 5)) ?? 1
  const volRatio = avgVol5 > 0 ? Number((volume[n - 1] / avgVol5).toFixed(2)) : 0

  const low20 = Math.min(...low.slice(-20))
  const low5 = Math.min(...low.slice(-5))
  const makeNewLow = low5 <= low20 * 1.001 // 近5日低点接近/低于近20日低点 → 破位风险
  const nearLow = price <= low20 * 1.03

  const rsiVal = lastValid(rsi(close, 14))

  const box = detectBoxBreakout(kline)
  const priceVsBox: 'inside' | 'above' | 'below' = !box
    ? 'inside'
    : price > box.boxHigh
      ? 'above'
      : price < box.boxLow
        ? 'below'
        : 'inside'

  const verdict = judgeStabilization({
    aboveMa20,
    aboveMa60,
    macdTrend,
    makeNewLow,
    nearLow,
    rsi: rsiVal,
    volRatio,
    priceVsBox,
    distToMa20Pct,
  })

  return {
    aboveMa20,
    aboveMa60,
    ma20,
    ma60,
    macdHist,
    macdHistPrev,
    macdTrend,
    volRatio,
    makeNewLow,
    nearLow,
    distToMa20Pct,
    rsi: rsiVal,
    priceVsBox,
    verdict,
  }
}

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

  // 买入区间：支撑位到现价上方2%（低吸为主，允许小幅追入）
  const buyLow = round2(Math.min(support, price))
  const buyHigh = round2(Math.max(support, price * 1.02))

  // 止盈目标：前期高点与 +5% 的较大者
  const takeProfit = round2(Math.max(high20, price * 1.05))

  // ATR 波动率止损：波动大→止损宽、波动小→止损紧，并结合支撑位锚（不抛弃原 min(ma, lowN) 逻辑）。
  const k = shortMode ? 1.5 : ATR_MULT
  const atrVal = lastValid(atr(high, low, close, ATR_PERIOD)) ?? price * 0.03
  const supportFloor = Math.min(ma, lowN)
  // ① 波动率止损；② 支撑位兜底：不浅于支撑位下方 1%（保留"跌破支撑才止损"语义）
  let stopLoss = Math.min(price - atrVal * k, supportFloor * 0.99)
  // ③ 上下限钳制：止损距离恒在 [2%, 8%]，横盘不震出、极端 ATR 不过宽
  stopLoss = Math.min(
    Math.max(stopLoss, price * (1 - MAX_LOSS_PCT)),
    price * (1 - MIN_LOSS_PCT),
  )
  // ④ 保底低于现价（价格已跌破均线/低点时，支撑可能高于现价）
  if (stopLoss >= price) stopLoss = price * 0.98
  stopLoss = round2(stopLoss)

  // 风险回报比
  const upside = takeProfit - price
  const downside = price - stopLoss
  const riskReward = downside > 0 ? Number((upside / downside).toFixed(2)) : 0

  // 箱体突破信号（横盘蓄势后突破/打开空间）
  const box = detectBoxBreakout(kline)

  // 理由
  const reasons: string[] = []
  if (box && box.active) {
    reasons.push(
      box.breakoutDay
        ? `今日放量突破 ${box.boxDays} 日箱体上沿 ${round2(box.boxHigh)}（量比 ${box.volumeSurge}），打开上方空间，测量目标 ${round2(box.measuredTarget)}`
        : `已站稳 ${box.boxDays} 日箱体上方（突破后 ${box.sinceBreakout} 日），打开空间目标 ${round2(box.measuredTarget)}`,
    )
  }
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
  const stopDistPct = ((price - stopLoss) / price) * 100
  reasons.push(
    `止损 ${stopLoss}（距现价 ${stopDistPct.toFixed(1)}%，ATR${ATR_PERIOD} 波动率止损，结合近 ${lowPeriod} 日低点 ${round2(lowN)}）`,
  )

  // 移动止盈：基于ATR的动态止盈（最高价回撤N%触发）
  const trailingStop = round2(price - atrVal * 1.5)

  return {
    currentPrice: round2(price),
    buyLow,
    buyHigh,
    takeProfit,
    stopLoss,
    riskReward,
    trailingStop,
    reasons,
    box: box && box.inBox ? box : undefined,
    stability: analyzeStabilization(kline),
  }
}

/** 选股维度（原始数据，供用户自行判断） */
export interface SelectionMetrics {
  /** 相对大盘强弱 */
  relativeStrength: {
    stock5d: number // 个股5日涨幅%
    stock20d: number // 个股20日涨幅%
    stock60d: number // 个股60日涨幅%
    market1d: number // 大盘1日涨幅%（全市场平均）
    vsMarket: number // 个股1日相对大盘超额%
  }
  /** N日高低点位置 */
  highLows: {
    at20dHigh: boolean // 是否20日新高
    at60dHigh: boolean // 是否60日新高
    at20dLow: boolean // 是否20日新低
    at60dLow: boolean // 是否60日新低
    distTo20dHighPct: number // 距20日高点%（负=下方）
    distTo20dLowPct: number // 距20日低点%（正=上方）
  }
  /** 量价关系 */
  volPrice: {
    priceChange5d: number // 5日价格变化%
    volChange5d: number // 5日量能变化（当前5日均量/前5日均量）
    relationship: '价涨量增' | '价涨量缩' | '价跌量缩' | '价跌量增'
  }
  /** 均线排列 */
  maAlignment: {
    ma5: number
    ma20: number
    ma60: number
    bullAlign: boolean // MA5>MA20>MA60
    bearAlign: boolean // MA5<MA20<MA60
  }
  /** 连阳/连阴 */
  consecutive: {
    type: 'up' | 'down' | 'none'
    count: number
  }
  /** 距高点回撤 */
  drawdown: {
    peak20d: number // 20日最高价
    peak60d: number // 60日最高价
    dd20d: number // 距20日高点回撤%
    dd60d: number // 距60日高点回撤%
  }
  /** 波动率 */
  volatility: {
    annualized: number // 年化波动率%
  }
}

/**
 * 选股维度分析（纯数据，不下结论）
 * @param kline 个股K线
 * @param market 全市场快照（用于计算大盘强弱）
 */
export function analyzeStockSelection(kline: Kline[], market: StockInfo[]): SelectionMetrics | null {
  if (kline.length < 30) return null
  const close = kline.map((k) => k.close)
  const high = kline.map((k) => k.high)
  const low = kline.map((k) => k.low)
  const volume = kline.map((k) => k.volume)
  const n = close.length
  const price = close[n - 1]
  if (!Number.isFinite(price) || price <= 0) return null

  // 1. 相对大盘强弱
  const stock5d = n >= 6 ? Number((((price / close[n - 6]) - 1) * 100).toFixed(2)) : 0
  const stock20d = n >= 21 ? Number((((price / close[n - 21]) - 1) * 100).toFixed(2)) : 0
  const stock60d = n >= 61 ? Number((((price / close[n - 61]) - 1) * 100).toFixed(2)) : 0
  const marketReturns = market
    .filter((s) => s.changePct !== undefined && s.changePct !== null)
    .map((s) => s.changePct as number)
  const market1d =
    marketReturns.length > 0
      ? Number((marketReturns.reduce((a, b) => a + b, 0) / marketReturns.length).toFixed(2))
      : 0
  const stock1d = n >= 2 ? Number((((price / close[n - 2]) - 1) * 100).toFixed(2)) : 0
  const vsMarket = Number((stock1d - market1d).toFixed(2))

  // 2. N日高低点
  const high20 = Math.max(...high.slice(-20))
  const high60 = Math.max(...high.slice(-60))
  const low20 = Math.min(...low.slice(-20))
  const low60 = Math.min(...low.slice(-60))
  const at20dHigh = price >= high20 * 0.995
  const at60dHigh = price >= high60 * 0.995
  const at20dLow = price <= low20 * 1.005
  const at60dLow = price <= low60 * 1.005
  const distTo20dHighPct = Number((((price - high20) / high20) * 100).toFixed(2))
  const distTo20dLowPct = Number((((price - low20) / low20) * 100).toFixed(2))

  // 3. 量价关系
  const priceChange5d = n >= 6 ? Number((((price / close[n - 6]) - 1) * 100).toFixed(2)) : 0
  const curVol5 = n >= 6 ? volume.slice(-6).reduce((a, b) => a + b, 0) / 6 : 1
  const prevVol5 = n >= 12 ? volume.slice(-12, -6).reduce((a, b) => a + b, 0) / 6 : curVol5
  const volChange5d = prevVol5 > 0 ? Number((curVol5 / prevVol5).toFixed(2)) : 1
  const relationship: SelectionMetrics['volPrice']['relationship'] =
    priceChange5d >= 0
      ? volChange5d >= 1.1
        ? '价涨量增'
        : '价涨量缩'
      : volChange5d <= 0.9
        ? '价跌量缩'
        : '价跌量增'

  // 4. 均线排列
  const ma5 = lastValid(sma(close, 5)) ?? price
  const ma20 = lastValid(sma(close, 20)) ?? price
  const ma60 = lastValid(sma(close, 60)) ?? ma20
  const bullAlign = ma5 > ma20 && ma20 > ma60
  const bearAlign = ma5 < ma20 && ma20 < ma60

  // 5. 连阳/连阴
  let upCount = 0
  let downCount = 0
  for (let i = n - 1; i >= 1; i--) {
    if (close[i] > close[i - 1]) upCount++
    else break
  }
  for (let i = n - 1; i >= 1; i--) {
    if (close[i] < close[i - 1]) downCount++
    else break
  }
  const consecutive: SelectionMetrics['consecutive'] =
    upCount >= 2 ? { type: 'up', count: upCount } : downCount >= 2 ? { type: 'down', count: downCount } : { type: 'none', count: 0 }

  // 6. 距高点回撤
  const peak20d = high20
  const peak60d = high60
  const dd20d = Number((((price - peak20d) / peak20d) * 100).toFixed(2))
  const dd60d = Number((((price - peak60d) / peak60d) * 100).toFixed(2))

  // 7. 波动率
  const annualized = Number((annualizedVol(close, 20)).toFixed(2))

  return {
    relativeStrength: { stock5d, stock20d, stock60d, market1d, vsMarket },
    highLows: { at20dHigh, at60dHigh, at20dLow, at60dLow, distTo20dHighPct, distTo20dLowPct },
    volPrice: { priceChange5d, volChange5d, relationship },
    maAlignment: { ma5, ma20, ma60, bullAlign, bearAlign },
    consecutive,
    drawdown: { peak20d, peak60d, dd20d, dd60d },
    volatility: { annualized },
  }
}

/** K线形态识别 + 支撑压力位 + 量能趋势 + 换手解读 */
export interface KlinePatternAnalysis {
  patterns: KlinePattern[] // 识别到的K线形态
  supportResistance: {
    supports: number[] // 支撑位（最多3个，从低到高）
    resistances: number[] // 压力位（最多3个，从低到高）
    nearestSupport: number // 最近支撑
    nearestResistance: number // 最近压力
  }
  volumeTrend: {
    trend: '放量' | '缩量' | '稳定'
    vol5d: number // 5日均量
    vol20d: number // 20日均量
    ratio: number // 5日/20日量比
  }
  turnover: {
    rate: number // 换手率%
    level: '极低' | '温和' | '活跃' | '过高'
    signal: string // 解读
  }
}

export interface KlinePattern {
  name: string
  signal: 'bullish' | 'bearish' | 'neutral'
  reliability: 'high' | 'medium' | 'low'
  desc: string
}

/**
 * K线形态识别 + 支撑压力位 + 量能趋势 + 换手解读
 * @param kline 个股K线
 * @param turnoverRate 换手率（来自快照）
 */
export function analyzeKlinePatterns(kline: Kline[], turnoverRate?: number): KlinePatternAnalysis | null {
  if (kline.length < 30) return null
  const close = kline.map((k) => k.close)
  const high = kline.map((k) => k.high)
  const low = kline.map((k) => k.low)
  const volume = kline.map((k) => k.volume)
  const open = kline.map((k) => k.open)
  const n = kline.length
  const price = close[n - 1]

  // ---- 1. K线形态识别 ----
  const patterns: KlinePattern[] = []
  const c0 = close[n - 1], o0 = open[n - 1], h0 = high[n - 1], l0 = low[n - 1]
  const c1 = close[n - 2], o1 = open[n - 2]
  const c2 = close[n - 3], o2 = open[n - 3]
  const body0 = Math.abs(c0 - o0)
  const body1 = Math.abs(c1 - o1)
  const body2 = Math.abs(c2 - o2)
  const upperShadow0 = h0 - Math.max(c0, o0)
  const lowerShadow0 = Math.min(c0, o0) - l0
  const avgBody = (body0 + body1 + body2) / 3
  const range0 = h0 - l0

  // 锤子线：小实体 + 长下影（>=2倍实体）+ 短上影
  if (body0 > 0 && lowerShadow0 >= body0 * 2 && upperShadow0 <= body0 * 0.5) {
    const atBottom = price <= Math.min(...close.slice(-20)) * 1.05
    patterns.push({
      name: '锤子线',
      signal: atBottom ? 'bullish' : 'neutral',
      reliability: atBottom ? 'high' : 'medium',
      desc: atBottom ? '底部锤子线，可能止跌反转' : '非底部锤子线，信号偏弱',
    })
  }

  // 十字星：实体极小（<10% range）
  if (range0 > 0 && body0 / range0 < 0.1) {
    patterns.push({
      name: '十字星',
      signal: 'neutral',
      reliability: 'medium',
      desc: '多空犹豫，等待方向选择',
    })
  }

  // 看涨吞没：前阴后阳，后完全吞没前
  if (c1 < o1 && c0 > o0 && o0 <= c1 && c0 >= o1 && body0 > body1) {
    const atBottom = price <= Math.min(...close.slice(-20)) * 1.08
    patterns.push({
      name: '看涨吞没',
      signal: 'bullish',
      reliability: atBottom ? 'high' : 'medium',
      desc: atBottom ? '底部吞没，反转信号强' : '非底部吞没',
    })
  }

  // 看跌吞没：前阳后阴，后完全吞没前
  if (c1 > o1 && c0 < o0 && o0 >= c1 && c0 <= o1 && body0 > body1) {
    const atTop = price >= Math.max(...close.slice(-20)) * 0.92
    patterns.push({
      name: '看跌吞没',
      signal: 'bearish',
      reliability: atTop ? 'high' : 'medium',
      desc: atTop ? '顶部吞没，可能见顶回落' : '非顶部吞没',
    })
  }

  // 早晨之星：3根组合（大阴+小阳/十字+大阳）
  if (n >= 3 && body2 > avgBody * 1.5 && c2 < o2 && body1 < body2 * 0.4 && body0 > avgBody * 1.5 && c0 > o0) {
    patterns.push({
      name: '早晨之星',
      signal: 'bullish',
      reliability: 'high',
      desc: '经典底部反转形态',
    })
  }

  // 黄昏之星：3根组合（大阳+小阴/十字+大阴）
  if (n >= 3 && body2 > avgBody * 1.5 && c2 > o2 && body1 < body2 * 0.4 && body0 > avgBody * 1.5 && c0 < o0) {
    patterns.push({
      name: '黄昏之星',
      signal: 'bearish',
      reliability: 'high',
      desc: '经典顶部反转形态',
    })
  }

  // 红三兵：连续3根阳线，每根收盘高于前一根
  if (n >= 3 && c0 > o0 && c1 > o1 && c2 > o2 && c0 > c1 && c1 > c2) {
    patterns.push({
      name: '红三兵',
      signal: 'bullish',
      reliability: 'high',
      desc: '连续阳线，多头稳步推进',
    })
  }

  // 三只乌鸦：连续3根阴线，每根收盘低于前一根
  if (n >= 3 && c0 < o0 && c1 < o1 && c2 < o2 && c0 < c1 && c1 < c2) {
    patterns.push({
      name: '三只乌鸦',
      signal: 'bearish',
      reliability: 'high',
      desc: '连续阴线，空头持续打压',
    })
  }

  // ---- 2. 支撑压力位 ----
  const pivotPoints: number[] = []
  for (let i = 2; i < n - 2; i++) {
    // 支撑：比左右各2根都低
    if (low[i] <= low[i - 1] && low[i] <= low[i - 2] && low[i] <= low[i + 1] && low[i] <= low[i + 2]) {
      pivotPoints.push(low[i])
    }
    // 压力：比左右各2根都高
    if (high[i] >= high[i - 1] && high[i] >= high[i - 2] && high[i] >= high[i + 1] && high[i] >= high[i + 2]) {
      pivotPoints.push(high[i])
    }
  }
  // 聚类：合并相近的价格（差距<2%）
  const clustered: number[] = []
  const sorted = [...new Set(pivotPoints)].sort((a, b) => a - b)
  for (const p of sorted) {
    const near = clustered.find((c) => Math.abs(c - p) / p < 0.02)
    if (near !== undefined) {
      const idx = clustered.indexOf(near)
      clustered[idx] = (near + p) / 2
    } else {
      clustered.push(p)
    }
  }
  const supports = clustered.filter((p) => p < price).sort((a, b) => b - a).slice(0, 3)
  const resistances = clustered.filter((p) => p > price).sort((a, b) => a - b).slice(0, 3)
  const nearestSupport = supports.length > 0 ? supports[0] : Math.min(...low.slice(-20))
  const nearestResistance = resistances.length > 0 ? resistances[0] : Math.max(...high.slice(-20))

  // ---- 3. 量能趋势 ----
  const vol5d = n >= 6 ? volume.slice(-6).reduce((a, b) => a + b, 0) / 6 : volume[n - 1]
  const vol20d = n >= 21 ? volume.slice(-21).reduce((a, b) => a + b, 0) / 21 : vol5d
  const ratio = vol20d > 0 ? Number((vol5d / vol20d).toFixed(2)) : 1
  const volTrend: KlinePatternAnalysis['volumeTrend']['trend'] =
    ratio >= 1.2 ? '放量' : ratio <= 0.8 ? '缩量' : '稳定'

  // ---- 4. 换手率解读 ----
  let turnoverSignal = ''
  let turnoverLevel: KlinePatternAnalysis['turnover']['level'] = '温和'
  if (turnoverRate !== undefined) {
    if (turnoverRate < 1) {
      turnoverLevel = '极低'
      turnoverSignal = '成交低迷，关注是否地量变盘'
    } else if (turnoverRate <= 3) {
      turnoverLevel = '温和'
      turnoverSignal = '量价配合健康'
    } else if (turnoverRate <= 7) {
      turnoverLevel = '活跃'
      turnoverSignal = '资金关注度高，注意方向选择'
    } else {
      turnoverLevel = '过高'
      turnoverSignal = '换手过大，警惕分歧'
    }
  }

  return {
    patterns,
    supportResistance: {
      supports: supports.map(round2),
      resistances: resistances.map(round2),
      nearestSupport: round2(nearestSupport),
      nearestResistance: round2(nearestResistance),
    },
    volumeTrend: { trend: volTrend, vol5d: Math.round(vol5d), vol20d: Math.round(vol20d), ratio },
    turnover: { rate: turnoverRate ?? 0, level: turnoverLevel, signal: turnoverSignal },
  }
}

/** 跳空缺口分析 */
export interface GapAnalysis {
  gaps: Gap[] // 近10日内的缺口
  unfilledUp: Gap[] // 未回补的向上缺口（支撑）
  unfilledDown: Gap[] // 未回补的向下缺口（压力）
  nearestGapSupport: number | null // 最近的缺口支撑
  nearestGapResistance: number | null // 最近的缺口压力
}

export interface Gap {
  date: string // 缺口日期
  type: 'up' | 'down' // 向上/向下
  gapLow: number // 缺口下沿
  gapHigh: number // 缺口上沿
  size: number // 缺口大小（跳空幅度%）
  filled: boolean // 是否已回补
}

/** 趋势动能评分 */
export interface TrendMomentum {
  score: number // -10 ~ +10
  label: '加速上涨' | '上涨减速' | '加速下跌' | '下跌减速' | '震荡'
  maScore: number // 均线得分 -3~+3
  macdScore: number // MACD得分 -3~+3
  volScore: number // 量能得分 -2~+2
  details: string[]
}

/**
 * 跳空缺口分析
 * 缺口 = 当日开盘价与昨日收盘价之间的空白区域
 * 向上缺口（今日低 > 昨日收）= 多头跳空，未回补=支撑
 * 向下缺口（今日高 < 昨日收）= 空头跳空，未回补=压力
 */
export function analyzeGaps(kline: Kline[]): GapAnalysis | null {
  if (kline.length < 11) return null
  const n = kline.length
  const gaps: Gap[] = []

  for (let i = n - 10; i < n; i++) {
    const prevClose = kline[i - 1].close
    const curLow = kline[i].low
    const curHigh = kline[i].high
    const curOpen = kline[i].open

    // 向上缺口：今日最低 > 昨日收盘
    if (curLow > prevClose * 1.001) {
      const size = Number((((curOpen - prevClose) / prevClose) * 100).toFixed(2))
      // 检查是否被回补：后续K线是否有跌破缺口下沿
      let filled = false
      for (let j = i + 1; j < n; j++) {
        if (kline[j].low <= prevClose) {
          filled = true
          break
        }
      }
      gaps.push({ date: kline[i].date, type: 'up', gapLow: prevClose, gapHigh: curLow, size, filled })
    }
    // 向下缺口：今日最高 < 昨日收盘
    else if (curHigh < prevClose * 0.999) {
      const size = Number((((prevClose - curOpen) / prevClose) * 100).toFixed(2))
      let filled = false
      for (let j = i + 1; j < n; j++) {
        if (kline[j].high >= prevClose) {
          filled = true
          break
        }
      }
      gaps.push({ date: kline[i].date, type: 'down', gapLow: curHigh, gapHigh: prevClose, size, filled })
    }
  }

  const unfilledUp = gaps.filter((g) => g.type === 'up' && !g.filled)
  const unfilledDown = gaps.filter((g) => g.type === 'down' && !g.filled)
  const nearestGapSupport = unfilledUp.length > 0 ? Math.max(...unfilledUp.map((g) => g.gapHigh)) : null
  const nearestGapResistance = unfilledDown.length > 0 ? Math.min(...unfilledDown.map((g) => g.gapLow)) : null

  return { gaps, unfilledUp, unfilledDown, nearestGapSupport, nearestGapResistance }
}

/**
 * 趋势动能评分
 * 综合均线、MACD、量能三个维度，判断趋势在加速还是减速
 */
export function analyzeTrendMomentum(kline: Kline[]): TrendMomentum | null {
  if (kline.length < 30) return null
  const close = kline.map((k) => k.close)
  const volume = kline.map((k) => k.volume)
  const n = kline.length
  const details: string[] = []

  // 1. 均线得分（-3 ~ +3）
  const ma5 = lastValid(sma(close, 5)) ?? close[n - 1]
  const ma20 = lastValid(sma(close, 20)) ?? close[n - 1]
  const ma60 = lastValid(sma(close, 60)) ?? ma20
  let maScore = 0
  if (ma5 > ma20 && ma20 > ma60) {
    maScore = 3
    details.push('均线多头排列(+3)')
  } else if (ma5 > ma20) {
    maScore = 1
    details.push('MA5>MA20(+1)')
  } else if (ma5 < ma20 && ma20 < ma60) {
    maScore = -3
    details.push('均线空头排列(-3)')
  } else if (ma5 < ma20) {
    maScore = -1
    details.push('MA5<MA20(-1)')
  }

  // 2. MACD得分（-3 ~ +3）
  const m = macd(close)
  const hist = m.hist[n - 1]
  const histPrev = m.hist[n - 2] ?? hist
  const histPrev2 = m.hist[n - 3] ?? histPrev
  let macdScore = 0
  if (hist > 0 && hist > histPrev && histPrev > histPrev2) {
    macdScore = 3
    details.push('红柱持续放大(+3)')
  } else if (hist > 0 && hist > histPrev) {
    macdScore = 2
    details.push('红柱放大(+2)')
  } else if (hist > 0) {
    macdScore = 1
    details.push('红柱(+1)')
  } else if (hist < 0 && hist < histPrev && histPrev < histPrev2) {
    macdScore = -3
    details.push('绿柱持续放大(-3)')
  } else if (hist < 0 && hist < histPrev) {
    macdScore = -2
    details.push('绿柱放大(-2)')
  } else if (hist < 0) {
    macdScore = -1
    details.push('绿柱(-1)')
  }

  // 3. 量能得分（-2 ~ +2）
  const vol5d = n >= 6 ? volume.slice(-6).reduce((a, b) => a + b, 0) / 6 : 1
  const vol20d = n >= 21 ? volume.slice(-21).reduce((a, b) => a + b, 0) / 21 : vol5d
  const volRatio = vol20d > 0 ? vol5d / vol20d : 1
  let volScore = 0
  if (volRatio >= 1.3) {
    volScore = 2
    details.push('明显放量(+2)')
  } else if (volRatio >= 1.1) {
    volScore = 1
    details.push('温和放量(+1)')
  } else if (volRatio <= 0.7) {
    volScore = -2
    details.push('明显缩量(-2)')
  } else if (volRatio <= 0.9) {
    volScore = -1
    details.push('温和缩量(-1)')
  }

  const score = maScore + macdScore + volScore
  let label: TrendMomentum['label']
  if (score >= 5) label = '加速上涨'
  else if (score >= 2) label = '上涨减速'
  else if (score <= -5) label = '加速下跌'
  else if (score <= -2) label = '下跌减速'
  else label = '震荡'

  return { score, label, maScore, macdScore, volScore, details }
}

/** 买入检查清单 + 性价比判断 + 仓位建议 */
export interface BuyDecision {
  checklist: BuyChecklistItem[]
  summary: {
    passCount: number
    total: number
    verdict: '适合买入' | '观望等待' | '不建议买入'
    color: 'good' | 'warn' | 'bad'
    hint: string
  }
  riskReward: {
    entryPrice: number
    stopLoss: number
    takeProfit: number
    riskPct: number
    rewardPct: number
    ratio: number
    worthEntry: boolean
    hint: string
  }
  position: {
    atr: number
    riskPerShare: number
    maxLotFor2pctRisk: number
    suggestion: string
  } | null
}

export interface BuyChecklistItem {
  label: string
  pass: boolean
  weight: 'high' | 'medium' | 'low'
  detail: string
}

/**
 * 买入决策评分（0-9，列表与详情共用，保证一致）
 * 基于企稳检查清单的简化版，两处调用结果一致。
 */
export function computeBuyScore(
  stability: StabilizationAnalysis,
  riskReward: number,
): number {
  let buyScore = 0
  if (stability.verdict.score >= 3) buyScore += 2 // 已企稳
  else if (stability.verdict.score >= 0) buyScore += 1 // 企稳中
  if (stability.aboveMa20) buyScore += 1 // 站上MA20
  if (!stability.makeNewLow) buyScore += 1 // 未创新低
  if (stability.macdTrend === 'improving') buyScore += 1 // MACD转好
  if (stability.volRatio >= 0.8 && stability.volRatio <= 1.3) buyScore += 1 // 量能健康
  if (riskReward >= 1.5) buyScore += 2 // 性价比高
  else if (riskReward >= 0.8) buyScore += 1
  if (stability.rsi !== null && stability.rsi >= 40 && stability.rsi <= 70) buyScore += 1 // RSI健康
  return buyScore
}

/**
 * 买入决策综合分析
 * @param signal 买卖点信号
 * @param stability 企稳分析
 * @param trendMomentum 趋势动能
 * @param sectorJudgment 板块判断（可选）
 * @param sentiment 大盘情绪（可选）
 * @param accountValue 账户市值（默认10万，用于仓位计算）
 */
export function analyzeBuyDecision(
  signal: TradingSignal,
  stability: StabilizationAnalysis,
  trendMomentum: TrendMomentum,
  sectorScore?: number,
  sentimentLevel?: 'hot' | 'neutral' | 'cold',
  accountValue = 100000,
): BuyDecision {
  const price = signal.currentPrice
  const checklist: BuyChecklistItem[] = []

  // 1. 企稳状态
  const stabilized =
    stability.verdict.label === '已企稳' || stability.verdict.label === '企稳中'
  checklist.push({
    label: '企稳状态',
    pass: stabilized,
    weight: 'high',
    detail: stability.verdict.label + '（评分' + (stability.verdict.score > 0 ? '+' : '') + stability.verdict.score + '）',
  })

  // 2. 趋势动能
  const momentumOk = trendMomentum.score >= 2
  checklist.push({
    label: '趋势动能',
    pass: momentumOk,
    weight: 'high',
    detail: trendMomentum.label + '（' + (trendMomentum.score > 0 ? '+' : '') + trendMomentum.score + '分）',
  })

  // 3. 站上 MA20
  checklist.push({
    label: '站上MA20',
    pass: stability.aboveMa20,
    weight: 'medium',
    detail: stability.aboveMa20 ? '现价在MA20上方' : '现价跌破MA20',
  })

  // 4. 未创新低
  checklist.push({
    label: '未创新低',
    pass: !stability.makeNewLow,
    weight: 'high',
    detail: stability.makeNewLow ? '近5日创20日新低（破位风险）' : '未创新低（止跌）',
  })

  // 5. 量能配合
  const volOk = stability.volRatio >= 0.8 && stability.volRatio <= 1.5
  checklist.push({
    label: '量能健康',
    pass: volOk,
    weight: 'medium',
    detail: '量比' + stability.volRatio.toFixed(2) + (volOk ? '（温和）' : stability.volRatio < 0.8 ? '（缩量）' : '（放量过大）'),
  })

  // 6. MACD 柱方向
  checklist.push({
    label: 'MACD动能',
    pass: stability.macdTrend === 'improving',
    weight: 'medium',
    detail: stability.macdTrend === 'improving' ? '柱体放大（转强）' : '柱体收窄（转弱）',
  })

  // 7. 板块配合
  const sectorOk = sectorScore === undefined || sectorScore >= 1
  checklist.push({
    label: '板块配合',
    pass: sectorOk,
    weight: 'medium',
    detail: sectorScore !== undefined ? '板块得分' + (sectorScore > 0 ? '+' : '') + sectorScore : '无板块数据',
  })

  // 8. 大盘环境
  const marketOk = sentimentLevel !== 'cold'
  checklist.push({
    label: '大盘环境',
    pass: marketOk,
    weight: 'low',
    detail: sentimentLevel === 'cold' ? '大盘冰点（谨慎）' : sentimentLevel === 'hot' ? '大盘偏暖' : '大盘中性',
  })

  // 9. 风险回报比
  const stopLoss = signal.stopLoss
  const takeProfit = signal.takeProfit
  const riskPerShare = price - stopLoss
  const rewardPerShare = takeProfit - price
  const riskPct = Number(((riskPerShare / price) * 100).toFixed(1))
  const rewardPct = Number(((rewardPerShare / price) * 100).toFixed(1))
  const ratio = riskPerShare > 0 ? Number((rewardPerShare / riskPerShare).toFixed(2)) : 0
  const worthEntry = ratio >= 1.5 && riskPct <= 8

  checklist.push({
    label: '风险回报比',
    pass: worthEntry,
    weight: 'high',
    detail: '回报/风险=' + ratio + '（止损' + riskPct + '% → 止盈' + rewardPct + '%）',
  })

  // 汇总
  const highPass = checklist.filter((c) => c.weight === 'high' && c.pass).length
  const highTotal = checklist.filter((c) => c.weight === 'high').length
  const allPass = checklist.filter((c) => c.pass).length
  const allTotal = checklist.length

  let verdict: BuyDecision['summary']['verdict']
  let color: BuyDecision['summary']['color']
  let hint: string

  if (highPass >= highTotal * 0.7 && worthEntry) {
    verdict = '适合买入'
    color = 'good'
    hint = '高权重条件大部分满足，性价比可接受'
  } else if (highPass >= highTotal * 0.4 || (!worthEntry && highPass >= highTotal * 0.6)) {
    verdict = '观望等待'
    color = 'warn'
    hint = worthEntry ? '部分高权重条件未满足' : '性价比偏低（回报/风险<1.5），等更好价位'
  } else {
    verdict = '不建议买入'
    color = 'bad'
    hint = '多数条件不达标，建议放弃或换标的'
  }

  // 大盘择时总闸门：冰点时降级（"适合买入"→"观望"），并建议减半仓
  const marketCold = sentimentLevel === 'cold'
  if (marketCold && verdict === '适合买入') {
    verdict = '观望等待'
    color = 'warn'
    hint = '大盘冰点，建议观望为主，仅保留最强标的轻仓试探'
  }

  // 仓位建议（冰点时按 1% 风险而非 2% 计算，等于减半仓）
  const riskBudgetPct = marketCold ? 0.01 : 0.02
  const atrVal = Number((price * 0.03).toFixed(2))
  const position =
    riskPerShare > 0
      ? {
          atr: atrVal,
          riskPerShare: Number(riskPerShare.toFixed(2)),
          maxLotFor2pctRisk: Math.floor((accountValue * riskBudgetPct) / riskPerShare / 100) * 100,
          suggestion:
            '每股风险' +
            riskPerShare.toFixed(2) +
            '元。账户' +
            (marketCold ? '1%' : '2%') +
            '风险=' +
            (accountValue * riskBudgetPct).toFixed(0) +
            '元，最多买' +
            Math.floor((accountValue * riskBudgetPct) / riskPerShare / 100) * 100 +
            '股（' +
            Math.floor((accountValue * riskBudgetPct) / riskPerShare / 100) +
            '手）' +
            (marketCold ? '（大盘冰点，建议减半仓）' : '。'),
        }
      : null

  return {
    checklist,
    summary: { passCount: allPass, total: allTotal, verdict, color, hint },
    riskReward: {
      entryPrice: price,
      stopLoss,
      takeProfit,
      riskPct,
      rewardPct,
      ratio,
      worthEntry,
      hint:
        ratio >= 2
          ? '性价比高（回报≥2倍风险），值得做'
          : ratio >= 1.5
            ? '性价比可接受'
            : '性价比偏低（回报<1.5倍风险），等更好价位',
    },
    position,
  }
}

/** 量价背离检测 */
export interface DivergenceSignal {
  type: 'bullish' | 'bearish' | 'none'
  pricePattern: string
  indicatorPattern: string
  reliability: 'high' | 'medium' | 'low'
  signal: string
}

/** 资金流入趋势 */
export interface MoneyFlowTrend {
  trend: '持续流入' | '流入减少' | '持续流出' | '流出减少' | '平稳'
  recent2d: number
  prev3d: number
  change: number
  signal: string
}

/**
 * 量价背离检测
 * 顶背离: 价格创新高 + MACD柱降低 → 可能见顶下跌
 * 底背离: 价格创新低 + MACD柱升高 → 可能见底反弹
 */
export function detectDivergence(kline: Kline[]): DivergenceSignal {
  if (kline.length < 30) return { type: 'none', pricePattern: '', indicatorPattern: '', reliability: 'low', signal: '数据不足' }
  const close = kline.map(k => k.close)
  const n = close.length
  const m = macd(close)

  // 找近10日的价格高点和低点
  const recentHigh = Math.max(...close.slice(-10))
  const recentLow = Math.min(...close.slice(-10))
  const prevHigh = n >= 20 ? Math.max(...close.slice(-20, -10)) : recentHigh
  const prevLow = n >= 20 ? Math.min(...close.slice(-20, -10)) : recentLow

  // MACD柱的对应高点和低点
  const histRecentHigh = Math.max(...m.hist.slice(-10))
  const histPrevHigh = n >= 20 ? Math.max(...m.hist.slice(-20, -10)) : histRecentHigh
  const histRecentLow = Math.min(...m.hist.slice(-10))
  const histPrevLow = n >= 20 ? Math.min(...m.hist.slice(-20, -10)) : histRecentLow

  // 顶背离：价格新高 + MACD柱降低
  if (close[n - 1] >= prevHigh * 0.99 && histRecentHigh < histPrevHigh * 0.95) {
    return {
      type: 'bearish',
      pricePattern: '价格接近或创新高',
      indicatorPattern: 'MACD柱降低（动能减弱）',
      reliability: close[n - 1] > prevHigh * 1.02 ? 'high' : 'medium',
      signal: '顶背离：价格在涨但动能衰竭，警惕见顶回调',
    }
  }

  // 底背离：价格新低 + MACD柱升高
  if (close[n - 1] <= prevLow * 1.01 && histRecentLow > histPrevLow * 1.05) {
    return {
      type: 'bullish',
      pricePattern: '价格接近或创新低',
      indicatorPattern: 'MACD柱升高（下跌动能减弱）',
      reliability: close[n - 1] < prevLow * 0.98 ? 'high' : 'medium',
      signal: '底背离：价格在跌但跌速放缓，可能见底反弹',
    }
  }

  return {
    type: 'none',
    pricePattern: '价格无明显背离',
    indicatorPattern: 'MACD柱与价格同步',
    reliability: 'low',
    signal: '暂无背离信号',
  }
}

/**
 * 资金流入趋势
 * 近2日主力净流入 vs 前3日主力净流入的变化趋势
 */
export function analyzeMoneyFlowTrend(history: number[]): MoneyFlowTrend {
  if (history.length < 3) {
    return { trend: '平稳', recent2d: 0, prev3d: 0, change: 0, signal: '数据不足' }
  }
  const recent2d = history.slice(-2).reduce((a, b) => a + b, 0) / Math.min(2, history.length)
  const prev3d = history.slice(-5, -2).reduce((a, b) => a + b, 0) / Math.min(3, Math.max(1, history.length - 2))
  const change = prev3d !== 0 ? Number(((recent2d - prev3d) / Math.abs(prev3d) * 100).toFixed(1)) : 0

  let trend: MoneyFlowTrend['trend']
  let signal: string

  if (recent2d > 0 && recent2d > prev3d * 1.2) {
    trend = '持续流入'
    signal = '主力加速进场，看好'
  } else if (recent2d > 0 && recent2d <= prev3d * 1.2) {
    trend = '流入减少'
    signal = '主力还在买但力度减弱'
  } else if (recent2d < 0 && recent2d < prev3d * 1.2) {
    trend = '持续流出'
    signal = '主力加速离场，警惕'
  } else if (recent2d < 0 && recent2d >= prev3d * 1.2) {
    trend = '流出减少'
    signal = '抛压减轻，可能在企稳'
  } else {
    trend = '平稳'
    signal = '资金无明显方向'
  }

  return { trend, recent2d: Number(recent2d.toFixed(0)), prev3d: Number(prev3d.toFixed(0)), change, signal }
}
