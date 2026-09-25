import type {
  FactorDef,
  FactorScore,
  Financials,
  Kline,
  MoneyFlow,
  StockInfo,
  StockScore,
} from '../types'
import {
  annualizedVol,
  bollinger,
  lastValid,
  macd,
  rsi,
  sma,
} from './indicators'
import { maSqueeze } from './breakout'

/** 打分引擎输入：一只股票的所有原始数据 */
export interface ScoringInput {
  info: StockInfo
  kline: Kline[] // 至少 60 根才参与技术因子打分
  financials?: Financials
  moneyFlow?: MoneyFlow
  moneyFlowHistory?: number[] // 近 N 日主力净流入（资金趋势）
  fundConcentration?: import('../engine/quickRules').FundConcentration
  _sectorStrength?: number // 板块内相对热度（pipeline 注入）
  _marketTemp?: number // 大盘温度（pipeline 注入）
}

const clamp = (v: number, lo = 0, hi = 100) =>
  Math.min(hi, Math.max(lo, v))

interface TechnicalRaw {
  trend: number | null
  macd: number | null
  rsi: number | null
  volume: number | null
  momentum_1m: number | null
  momentum_3m: number | null
  reversal: number | null
  volatility: number | null
  short_momentum: number | null
  breakout: number | null
  limit_up: number | null
  ma_squeeze: number | null
  // 新增因子
  vol_pattern: number | null   // 量能形态：缩量蓄势+首次放量+量价配合 → 0~1
  entry_fit: number | null     // 买点契合度：价格靠近支撑位 → 0~1
  limitup_state: number | null // 涨停状态：-1=今日涨停, 0=无, 1=涨停后1天, 2=涨停后2天
  sector_heat: number | null   // 板块热度：板块内相对排名 → 0~1
  market_temp: number | null   // 大盘温度 → 0~100
  vol_price_div: number | null // 量价背离：价涨量缩=控盘 → 0~1
  accumulation: number | null  // 吸筹痕迹：大进小出=建仓 → 0~1
  startup: number | null       // 启动形态：涨停+粘合+缩量+突破 → 0~1
  pullback: number | null      // 回踩低吸：涨停+突破过+回踩均线缩量 → 0~1
  platform: number | null      // 平台突破：横盘平台+放量突破+上升趋势 → 0~1
  shrink_surge: number | null  // 缩量蓄势突破：前期放量→缩量洗盘→突破启动 → 0~1
}

/** 计算连续涨停板天数（从最新一天往前数） */
function countLimitUp(kline: Kline[], threshold: number): number {
  let days = 0
  for (let i = kline.length - 1; i >= 1; i--) {
    const prev = kline[i - 1].close
    if (prev <= 0) break
    const change = kline[i].close / prev - 1
    if (change >= threshold - 0.005) days++
    else break
  }
  return days
}

/** 计算某只股票的技术指标原始值 */
function computeTechnicalRaw(
  kline: Kline[],
  limitUpThreshold: number,
  turnoverRate?: number,
  floatMv?: number,
  marketTemp?: number,
): TechnicalRaw {
  const empty: TechnicalRaw = {
    trend: null,
    macd: null,
    rsi: null,
    volume: null,
    momentum_1m: null,
    momentum_3m: null,
    reversal: null,
    volatility: null,
    short_momentum: null,
    breakout: null,
    limit_up: null,
    ma_squeeze: null,
    vol_pattern: null,
    entry_fit: null,
    limitup_state: null,
    sector_heat: null,
    market_temp: null,
    vol_price_div: null,
    accumulation: null,
    startup: null,
    pullback: null,
    platform: null,
    shrink_surge: null,
  }
  if (kline.length < 70) return empty
  const close = kline.map((k) => k.close)
  const high = kline.map((k) => k.high)
  const volume = kline.map((k) => k.volume)
  const n = close.length

  const ma20 = lastValid(sma(close, 20))
  const ma60 = lastValid(sma(close, 60))
  const ma20arr = sma(close, 20)
  const ma20prev = ma20arr[n - 3]

  const macdRes = macd(close)
  const difLast = macdRes.dif[n - 1]
  const deaLast = macdRes.dea[n - 1]
  const histLast = macdRes.hist[n - 1]
  const histPrev = macdRes.hist[n - 2]

  const rsiArr = rsi(close, 14)
  const rsiLast = lastValid(rsiArr)

  const vol20 = lastValid(sma(volume, 20))
  const volLast = volume[n - 1]

  // 趋势强度：相对 20/60 日线位置 + 均线多空排列
  const trend = (() => {
    if (!ma20 || !ma60 || !ma20prev) return null
    const above20 = close[n - 1] / ma20 - 1
    const above60 = close[n - 1] / ma60 - 1
    const maBull = ma20 / ma60 - 1 // >0 表示 ma20 在 ma60 上方（多头）
    const ma20Turn = (ma20 - ma20prev) / ma20prev // ma20 方向
    return above20 * 0.35 + above60 * 0.35 + maBull * 0.2 + ma20Turn * 1.5
  })()

  // MACD：更严格的区分度
  const macdRaw = (() => {
    if (difLast === undefined || deaLast === undefined || histLast === undefined) return null
    const histRatio = (histLast / close[n - 1]) * 100
    let v = histRatio <= 0 ? 40 + histRatio * 50 : 40 + Math.sqrt(histRatio) * 22
    if (histLast > 0 && histPrev <= 0) v += 15
    if (histLast < 0 && histPrev >= 0) v -= 15
    if (difLast > deaLast) v += 5
    return clamp(v, 5, 100)
  })()

  // RSI：更严格的区分度
  const rsiScore = (() => {
    if (rsiLast === null) return null
    const r = rsiLast
    if (r < 30) return 20
    if (r < 40) return 40
    if (r < 50) return 60
    if (r < 60) return 80
    if (r < 70) return 90
    if (r < 80) return 70
    if (r < 90) return 40
    return 20
  })()

  // 成交量异动：更严格的区分度
  const volumeScore = (() => {
    if (!vol20 || vol20 === 0) return null
    const ratio = volLast / vol20
    if (ratio <= 0.5) return 20
    if (ratio <= 0.8) return 35
    if (ratio <= 1.0) return 50
    if (ratio <= 1.3) return 70
    if (ratio <= 2.0) return 85
    if (ratio <= 3.0) return 60
    if (ratio <= 5.0) return 40
    return 25
  })()

  // 动量（1月）：过去 20 个交易日涨幅
  const momentum1m = (() => {
    if (n < 21 || close[n - 21] === 0) return null
    return close[n - 1] / close[n - 21] - 1
  })()

  // 动量（3月）：过去 60 个交易日涨幅
  const momentum3m = (() => {
    if (n < 61 || close[n - 61] === 0) return null
    return close[n - 1] / close[n - 61] - 1
  })()

  // 短期反转：过去 5 日跌幅（负值=超跌），越跌分越高
  const reversal = (() => {
    if (n < 6 || close[n - 6] === 0) return null
    return close[n - 6] / close[n - 1] - 1 // >0 表示过去5日下跌
  })()

  // 波动率：20 日年化波动率（%）
  const volatilityRaw = (() => {
    if (n < 30) return null
    return annualizedVol(close, 20)
  })()

  // 短线爆发力：过去 3 个交易日涨幅
  const shortMomentum = (() => {
    if (n < 4 || close[n - 4] === 0) return null
    return close[n - 1] / close[n - 4] - 1
  })()

  // 启动形态：前期涨停 + 均线粘合 + 横盘缩量 + 放量突破
  // 经典"首板回调→粘合蓄势→放量启动"形态（含涨停质量/回调幅度/粘合时长/突破K线）
  const startup = (() => {
    if (n < 30 || !vol20 || vol20 === 0) return null
    const c = close[n - 1]

    let raw = 0

    // ① 前期涨停质量（近20日内，不含今日）
    let limitUpIdx = -1
    for (let i = n - 2; i >= Math.max(1, n - 20); i--) {
      if (close[i - 1] > 0 && close[i] / close[i - 1] - 1 > 0.095) {
        limitUpIdx = i
        break
      }
    }
    if (limitUpIdx >= 0) {
      raw += 0.22 // 有涨停 = 主力痕迹
      const luClose = close[limitUpIdx]
      const luK = kline[limitUpIdx]
      // 涨停换手质量：实体涨停（非一字板）更好
      const luBody = Math.abs(luK.close - luK.open)
      const luRange = luK.high - luK.low
      if (luRange > 0 && luBody / luRange > 0.5) raw += 0.05
      // 涨停后回调幅度：在涨停价附近横盘 = 洗盘，深跌 = 破位
      const pullback = luClose > 0 ? (luClose - c) / luClose : 1
      if (pullback <= 0.03) raw += 0.12 // 几乎没回调，强势
      else if (pullback <= 0.08) raw += 0.06
      else if (pullback > 0.15) raw -= 0.12 // 跌太多，形态破坏
      // 涨停新鲜度：越近主力越活跃
      const daysAgo = n - 1 - limitUpIdx
      if (daysAgo <= 5) raw += 0.08
      else if (daysAgo <= 10) raw += 0.04
      // 首板识别：涨停前一天不是涨停（首板 > 连板后回调）
      const dayBefore = limitUpIdx - 1
      if (dayBefore >= 1) {
        const prevGain = close[dayBefore - 1] > 0 ? close[dayBefore] / close[dayBefore - 1] - 1 : 0
        if (prevGain < 0.095) raw += 0.05 // 首板
        else raw -= 0.05 // 连板后，风险更高
      }
    }

    // ② 均线粘合 + 粘合持续时长
    const ma5v = lastValid(sma(close, 5))
    const ma10v = lastValid(sma(close, 10))
    const ma20v = lastValid(sma(close, 20))
    if (ma5v && ma10v && ma20v && ma5v > 0) {
      const mx = Math.max(ma5v, ma10v, ma20v)
      const mn = Math.min(ma5v, ma10v, ma20v)
      const squeeze = (mx - mn) / mn
      if (squeeze < 0.02) raw += 0.18 // 高度粘合
      else if (squeeze < 0.04) raw += 0.1

      // 粘合持续：近5日 MA5/MA20 极差都很小 → 粘合越久越好
      const ma5Arr = sma(close, 5)
      const ma20Arr = sma(close, 20)
      let squeezeDays = 0
      for (let k = 0; k < 5; k++) {
        const idx = n - 1 - k
        if (idx < 20) break
        const m5 = ma5Arr[idx]
        const m20 = ma20Arr[idx]
        if (m5 !== null && m20 !== null && m20 > 0 && Math.abs(m5 / m20 - 1) < 0.02) squeezeDays++
        else break
      }
      if (squeezeDays >= 4) raw += 0.1 // 长期粘合
      else if (squeezeDays >= 2) raw += 0.05

      // 均线多头排列：MA5≥MA10≥MA20（健康趋势，突破更可靠）
      if (ma5v >= ma10v && ma10v >= ma20v) raw += 0.05
    }

    // ③ 横盘缩量（近10日振幅小 + 量能萎缩）
    const seg = kline.slice(-10)
    const segHigh = Math.max(...seg.map((k) => k.high))
    const segLow = Math.min(...seg.map((k) => k.low))
    const amplitude = c > 0 ? (segHigh - segLow) / c : 1
    const segVolAvg = seg.reduce((a, k) => a + k.volume, 0) / seg.length
    if (amplitude < 0.10) raw += 0.12
    else if (amplitude < 0.15) raw += 0.07
    if (segVolAvg < vol20 * 0.8) raw += 0.12 // 极度缩量（筹码锁定）
    else if (segVolAvg < vol20 * 0.95) raw += 0.06

    // ③b 缩量企稳低吸（埋伏形态）：站上MA5 + 极度缩量 + 未破位
    if (ma5v && c >= ma5v * 0.99 && segVolAvg < vol20 * 0.75 && amplitude < 0.12) {
      raw += 0.08 // 缩量企稳，适合逢低埋伏
    }

    // ③c 回踩均线支撑（5日线买点）：回踩MA5/MA10附近 + 缩量 + 均线向上
    const ma10v2 = lastValid(sma(close, 10))
    if (ma5v && ma10v2 && ma10v2 > 0) {
      const nearMa5 = Math.abs(c / ma5v - 1) <= 0.025
      const nearMa10 = Math.abs(c / ma10v2 - 1) <= 0.025
      const ma5Up = n >= 6 ? (sma(close, 5)[n - 1] ?? ma5v) >= (sma(close, 5)[n - 6] ?? ma5v) : false
      const volShrink = volLast < vol20 * 0.9 // 回踩应缩量
      if ((nearMa5 || nearMa10) && volShrink && ma5Up) {
        raw += 0.12 // 回踩均线支撑，最佳低吸点
      }
    }

    // ④ 放量突破 + K线质量
    const volRatio = volLast / vol20
    const high10prev = Math.max(...high.slice(Math.max(0, n - 11), n - 1))
    const volSurge = volRatio >= 1.4 && volRatio <= 3.5 // 温和放量最佳，爆量反而危险
    const breakout = high10prev > 0 && c >= high10prev * 0.995
    if (volSurge && breakout) raw += 0.3 // 关键：温和放量突破
    else if (volSurge && !breakout) raw += 0.05
    else if (breakout && volRatio >= 1.0) raw += 0.08

    // 突破日K线质量：实体阳线、上影线短
    const todayK = kline[n - 1]
    const tBody = Math.abs(todayK.close - todayK.open)
    const tRange = todayK.high - todayK.low
    const tUpper = todayK.high - Math.max(todayK.close, todayK.open)
    if (tRange > 0 && todayK.close > todayK.open) {
      if (tUpper / tRange < 0.25) raw += 0.08 // 收盘接近最高，强势
      if (tBody / tRange > 0.5) raw += 0.05 // 实体饱满
    }

    // 换手率：有量有人气但不过度（2%~10% 最佳）
    if (turnoverRate !== undefined && breakout) {
      if (turnoverRate >= 2 && turnoverRate <= 10) raw += 0.08
      else if (turnoverRate > 15) raw -= 0.06 // 换手过度，可能派发
      else if (turnoverRate < 1) raw -= 0.05 // 无人气
    }

    // ⑤ 中期趋势（MA60）：突破应发生在中期趋势不差的票上
    const ma60Arr = sma(close, 60)
    const ma60v = lastValid(ma60Arr)
    if (ma60v !== null && ma60v > 0) {
      if (c > ma60v) raw += 0.06 // 站上MA60
      const ma60prev = ma60Arr[n - 6]
      if (ma60prev !== null && ma60v >= ma60prev) raw += 0.05 // MA60走平或向上
      if (ma60prev !== null && ma60v < ma60prev * 0.98) raw -= 0.08 // MA60明显下行，下跌中继
    }

    // ⑥ 突破力度：收盘突破平台越多越有力
    if (breakout && high10prev > 0) {
      const breakStrength = (c - high10prev) / high10prev
      if (breakStrength >= 0.02) raw += 0.08
      else if (breakStrength >= 0) raw += 0.03
    }

    // ⑦ 上方空间（距120日高点）：有空间才好，逼近前高压制
    const high120 = Math.max(...high.slice(-120))
    if (high120 > 0) {
      const space = (high120 - c) / c
      if (space >= 0.15) raw += 0.08 // 上方空间充足
      else if (space < 0.03) raw -= 0.1 // 逼近前高，压力大
    }

    // ⑧ 周线共振：周线 MA5 > MA10（周线多头，日线突破更可靠）
    if (n >= 60) {
      const weeklyCloses: number[] = []
      for (let i = n - 1; i >= 0; i -= 5) weeklyCloses.unshift(close[i])
      if (weeklyCloses.length >= 10) {
        const w = weeklyCloses
        const wma5 = w.slice(-5).reduce((a, b) => a + b, 0) / 5
        const wma10 = w.slice(-10).reduce((a, b) => a + b, 0) / 10
        if (wma5 > wma10) raw += 0.06
      }
    }

    // ⑨ 流通市值：20~150亿最适合短线（太小易操纵，太大拉不动）
    if (floatMv !== undefined && floatMv > 0) {
      const yi = floatMv / 1e8
      if (yi >= 20 && yi <= 150) raw += 0.05
      else if (yi < 10 || yi > 500) raw -= 0.04
    }

    // ⑩ 大盘环境：大盘冰冷时突破失败率高
    if (marketTemp !== undefined) {
      if (marketTemp >= 45 && marketTemp <= 75) raw += 0.04
      else if (marketTemp < 30) raw -= 0.06
    }

    // 减分：今日涨幅过大（已爆发，不是启动初期）
    const todayGain = close[n - 2] > 0 ? c / close[n - 2] - 1 : 0
    if (todayGain > 0.07) raw -= 0.15
    // 减分：今日爆量（可能出货）
    if (volRatio > 5.0) raw -= 0.1

    // 核心门槛：既无涨停痕迹、又无突破、又不在均线支撑附近 → 非启动形态
    const nearMaSupport = ma5v !== null && Math.abs(c / ma5v - 1) <= 0.025
    if (limitUpIdx < 0 && !breakout && !nearMaSupport) {
      raw *= 0.35
    }

    // 归一化：满分目标 ≈ 1.3，避免过多票并列 100 分，保持区分度
    return Math.max(0, Math.min(1, Math.round((raw / 1.3) * 100) / 100))
  })()

  // 回踩低吸形态：前期涨停 + 突破过 + 回踩均线缩量企稳
  // 与 startup 相反：不买突破日，买回踩到均线的低吸点
  const pullback = (() => {
    if (n < 30 || !vol20 || vol20 === 0) return null
    const c = close[n - 1]
    const low = kline.map((k) => k.low)

    // ① 前期有涨停（20日内，不含今日）→ 主力痕迹（硬门槛）
    let limitUpIdx = -1
    for (let i = n - 2; i >= Math.max(1, n - 20); i--) {
      if (close[i - 1] > 0 && close[i] / close[i - 1] - 1 > 0.095) {
        limitUpIdx = i
        break
      }
    }
    if (limitUpIdx < 0) return 0 // 没有涨停痕迹，不是该形态

    let raw = 0.2
    const luClose = close[limitUpIdx]

    // ② 突破过：近期高点接近/超过20日高点（资金推过）
    const high10 = Math.max(...high.slice(-10))
    const high20 = Math.max(...high.slice(-20))
    if (high20 > 0 && high10 >= high20 * 0.99) raw += 0.12

    // ③ 回踩到MA5/MA10附近（±3%）→ 核心买点
    const ma5v = lastValid(sma(close, 5))
    const ma10v = lastValid(sma(close, 10))
    const nearMa5 = ma5v !== null && Math.abs(c / ma5v - 1) <= 0.03
    const nearMa10 = ma10v !== null && Math.abs(c / ma10v - 1) <= 0.03
    if (nearMa5 || nearMa10) raw += 0.3
    else if (ma5v !== null && c > ma5v && c <= ma5v * 1.06) raw += 0.1
    else if (ma5v !== null && c < ma5v) raw -= 0.15 // 已跌破，弱势

    // ④ 缩量（回踩应缩量）
    if (volLast < vol20 * 0.8) raw += 0.2
    else if (volLast < vol20) raw += 0.1
    else if (volLast > vol20 * 1.8) raw -= 0.15 // 放量下跌，危险

    // ⑤ 均线向上（趋势没坏）
    const ma5Arr = sma(close, 5)
    const ma5Prev = ma5Arr[n - 6]
    if (ma5v !== null && ma5Prev !== null && ma5v >= ma5Prev) raw += 0.1

    // ⑥ 未破位：未跌破MA10太多，且未深跌破涨停实体
    if (ma10v !== null && c >= ma10v * 0.97) raw += 0.1
    else raw -= 0.2
    const pullbackFromLu = luClose > 0 ? (luClose - c) / luClose : 0
    if (pullbackFromLu > 0.2) raw -= 0.15 // 涨停后跌超20%，形态破坏

    // ⑦ 位置不高
    const high60 = Math.max(...high.slice(-60))
    if (high60 > 0 && c / high60 <= 0.9) raw += 0.08

    // ⑧ 今日企稳（不能是暴跌中）
    const todayGain = close[n - 2] > 0 ? c / close[n - 2] - 1 : 0
    if (todayGain < -0.05) raw -= 0.2 // 还在下跌
    else if (todayGain >= -0.02 && todayGain <= 0.04) raw += 0.1 // 缩量小阴小阳，企稳

    // ⑨ 近期低点不再创新低（止跌）
    const low5 = Math.min(...low.slice(-5))
    const low10 = Math.min(...low.slice(-10))
    if (low5 > low10 * 0.99) raw += 0.08 // 未创新低

    // ⑩ 流通市值
    if (floatMv !== undefined && floatMv > 0) {
      const yi = floatMv / 1e8
      if (yi >= 20 && yi <= 150) raw += 0.05
      else if (yi < 10 || yi > 500) raw -= 0.04
    }

    // ⑪ 大盘环境
    if (marketTemp !== undefined) {
      if (marketTemp >= 45 && marketTemp <= 75) raw += 0.04
      else if (marketTemp < 30) raw -= 0.06
    }

    // 归一化
    return Math.max(0, Math.min(1, Math.round((raw / 1.2) * 100) / 100))
  })()

  // 平台突破形态：横盘平台 + 放量突破 + 上升趋势
  // 用户核心策略：平台突破（日线筛选）+ 分时踩均线确认（实时看）
  const platform = (() => {
    if (n < 45 || !vol20 || vol20 === 0) return null
    const c = close[n - 1]
    const low = kline.map((k) => k.low)
    let raw = 0

    // ① 平台：近20日（不含最近2日）横盘，振幅小
    const platStart = Math.max(0, n - 22)
    const platEnd = n - 2
    if (platEnd - platStart < 10) return null
    const platHigh = Math.max(...high.slice(platStart, platEnd))
    const platLow = Math.min(...low.slice(platStart, platEnd))
    const platAmp = platLow > 0 ? (platHigh - platLow) / platLow : 1
    // 平台振幅越小越好
    if (platAmp < 0.10) raw += 0.25
    else if (platAmp < 0.15) raw += 0.15
    else if (platAmp > 0.25) raw -= 0.15 // 波动太大，非平台

    // ② 平台内缩量蓄势
    const platVols = kline.slice(platStart, platEnd).map((k) => k.volume)
    const platVolAvg = platVols.length > 0 ? platVols.reduce((a, b) => a + b, 0) / platVols.length : vol20
    if (platVolAvg < vol20 * 0.9) raw += 0.1

    // ③ 突破：今日收盘站上平台上沿（核心）
    const volRatio = volLast / vol20
    const abovePlat = platHigh > 0 && c > platHigh * 1.003
    const volSurge = volRatio >= 1.3 && volRatio <= 4.0
    if (abovePlat && volSurge) raw += 0.4 // 放量突破（最佳）
    else if (abovePlat) raw += 0.2
    else if (c > platHigh * 0.99) raw += 0.08 // 逼近上沿

    // ④ 上升趋势：MA5>MA20 且 站上MA20
    const ma5v = lastValid(sma(close, 5))
    const ma20v = lastValid(sma(close, 20))
    if (ma5v !== null && ma20v !== null && ma20v > 0) {
      if (ma5v > ma20v && c > ma20v) raw += 0.2
      else if (c > ma20v) raw += 0.1
    }

    // ⑤ 突破力度 & K线质量
    if (abovePlat && platHigh > 0) {
      const breakStrength = (c - platHigh) / platHigh
      if (breakStrength >= 0.02) raw += 0.08
    }
    const todayK = kline[n - 1]
    const tRange = todayK.high - todayK.low
    const tUpper = todayK.high - Math.max(todayK.close, todayK.open)
    if (tRange > 0 && todayK.close > todayK.open && tUpper / tRange < 0.3) raw += 0.05

    // ⑥ 位置不高（距120日高点有空间）
    const high120 = Math.max(...high.slice(-120))
    if (high120 > 0) {
      const space = (high120 - c) / c
      if (space >= 0.12) raw += 0.08
      else if (space < 0.03) raw -= 0.08
    }

    // 减分：今日涨幅过大（已冲天炮，非突破初期）
    const todayGain = close[n - 2] > 0 ? c / close[n - 2] - 1 : 0
    if (todayGain > 0.085) raw -= 0.2
    // 减分：爆量（可能出货）
    if (volRatio > 5) raw -= 0.1

    // 归一化
    return Math.max(0, Math.min(1, Math.round((raw / 1.2) * 100) / 100))
  })()

  // 缩量蓄势突破形态：前期放量 → 缩量洗盘 → 突破启动主升浪
  const shrinkSurge = (() => {
    if (n < 30 || !vol20 || vol20 === 0) return null
    const c = close[n - 1]
    const low = kline.map((k) => k.low)
    const open = kline.map((k) => k.open)
    let score = 0

    // ① 前期放量（10-20天前）
    let hadHighVolume = false
    let hadLimitUp = false
    for (let j = Math.max(1, n - 20); j < n - 5; j++) {
      const volRatio = volume[j] / vol20
      if (volRatio > 2.0) hadHighVolume = true
      if (close[j - 1] > 0 && close[j] / close[j - 1] - 1 > 0.095) {
        hadLimitUp = true
      }
    }
    if (hadHighVolume) score += 0.2
    if (hadLimitUp) score += 0.15

    // ② 持续缩量（近5-10天）
    const recentVols = volume.slice(Math.max(0, n - 9), n)
    const recentAvgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length
    const shrinkRatio = recentAvgVol / vol20

    if (shrinkRatio >= 0.5 && shrinkRatio <= 0.8) {
      score += 0.25
    } else if (shrinkRatio > 0.8 && shrinkRatio <= 0.95) {
      score += 0.15
    }

    // 量能连续递减
    let consecutiveShrink = 0
    for (let j = n - 5; j < n; j++) {
      if (j > 0 && volume[j] < volume[j - 1]) {
        consecutiveShrink++
      }
    }
    if (consecutiveShrink >= 3) score += 0.1

    // ③ 横盘整理（近10天波动小）
    const segHigh = Math.max(...high.slice(Math.max(0, n - 9), n))
    const segLow = Math.min(...low.slice(Math.max(0, n - 9), n))
    const amplitude = c > 0 ? (segHigh - segLow) / c : 1

    if (amplitude < 0.10) score += 0.15
    else if (amplitude < 0.15) score += 0.08

    // ④ 今日突破启动
    const todayVolRatio = volLast / vol20
    const isRedCandle = c > open[n - 1] && c > close[n - 2]

    const volumeSurge = todayVolRatio >= 1.0 && todayVolRatio <= 3.5
    if (volumeSurge && isRedCandle) {
      score += 0.3
    } else if (volumeSurge) {
      score += 0.1
    } else if (isRedCandle && todayVolRatio >= 0.9) {
      score += 0.15
    }

    // 价格突破前期平台
    const highBefore = Math.max(...high.slice(Math.max(0, n - 10), n))
    const priceBreakout = highBefore > 0 && c >= highBefore * 0.995
    if (priceBreakout) score += 0.15

    // ⑤ 过滤：今日涨幅过大
    const todayGain = close[n - 2] > 0 ? c / close[n - 2] - 1 : 0
    if (todayGain > 0.08) score -= 0.2

    // 位置过高
    const high60 = Math.max(...high.slice(Math.max(0, n - 59), n))
    if (high60 > 0 && c / high60 > 0.95) score -= 0.1

    // 天量
    if (todayVolRatio > 4.0) score -= 0.15

    return Math.max(0, Math.min(1, score))
  })()

  // 创新高程度：现价相对前 20 日最高价（不含当日）
  const breakout = (() => {
    if (n < 21) return null
    const high20prev = Math.max(...high.slice(n - 21, n - 1))
    if (high20prev <= 0) return null
    return close[n - 1] / high20prev - 1
  })()

  // 连板高度：连续涨停天数
  const limitUp = countLimitUp(kline, limitUpThreshold)

  // 均线粘合突破：粘合度越接近 0 越粘合；粘合后放量突破 = 启动信号
  const squeeze = maSqueeze(kline)
  const maSqueezeScore =
    squeeze.squeeze !== null
      ? squeeze.breakout
        ? clamp(100 - squeeze.squeeze * 2000, 70, 100) // 突破 → 高分
        : clamp(70 - squeeze.squeeze * 1500, 30, 70) // 粘合蓄势 → 中分
      : null

  // ========== 新增因子 ==========
  // 1. 量能形态（缩量蓄势 + 首次放量 + 量价配合）
  const volPattern = (() => {
    if (!vol20 || vol20 === 0) return null
    const ratio = volLast / vol20
    if (ratio < 1.0 || ratio > 4.0) return null // 只处理温和放量区间
    const prev3Avg = n >= 5 ? (volume[n-2] + volume[n-3] + volume[n-4]) / 3 : 0
    const hasShrinkBase = prev3Avg < vol20 * 1.0 // 缩量蓄势
    const isFirstSurge = prev3Avg > 0 && volLast > prev3Avg * 1.3 // 首次放量
    const isUpDay = close[n-1] > kline[n-1].open && close[n-1] > close[n-2] // 量价齐升
    // 趋势过滤：MA5 > MA20（短期多头）
    const ma5v = lastValid(sma(close, 5)) ?? close[n-1]
    const ma20v = lastValid(sma(close, 20)) ?? close[n-1]
    const isTrendUp = ma5v > ma20v && close[n-1] > ma20v
    // 综合：0~1，越高越好
    let score = 0.3
    if (hasShrinkBase) score += 0.2
    if (isFirstSurge) score += 0.15
    if (isUpDay) score += 0.15
    if (isTrendUp) score += 0.2 // 趋势向上加分
    if (ratio > 2.5) score -= 0.15 // 放量偏大扣分
    return Math.round(score * 100) / 100
  })()

  // 2. 涨停状态（-1=今日涨停, 0=无, 1=涨停后1天, 2=涨停后2天+）
  const limitupState = (() => {
    for (let i = n - 1; i >= Math.max(1, n - 5); i--) {
      const gain = close[i] / close[i-1] - 1
      if (gain > 0.095) {
        return i === n - 1 ? -1 : n - 1 - i
      }
    }
    return 0
  })()

  // 3. 量价背离（价涨量缩 = 主力控盘，启动前兆）
  const volPriceDiv = (() => {
    if (n < 10) return null
    // 近5日价格涨幅
    const priceChange5 = close[n-1] / close[n-6] - 1
    // 近5日量能变化：前半段均量 vs 后半段均量
    const firstHalf = n >= 6 ? (volume[n-6] + volume[n-5] + volume[n-4]) / 3 : 0
    const secondHalf = n >= 3 ? (volume[n-3] + volume[n-2] + volume[n-1]) / 3 : 0
    const volChange = firstHalf > 0 ? (secondHalf - firstHalf) / firstHalf : 0
    // 价涨量缩 = 正向背离（主力控盘）
    if (priceChange5 > 0.02 && volChange < -0.1) {
      return Math.min(1, 0.5 + Math.abs(volChange) + priceChange5 * 2)
    }
    // 价跌量缩 = 正常缩量，不算背离
    if (priceChange5 < -0.02 && volChange < -0.1) {
      return 0.3
    }
    return null
  })()

  return {
    trend,
    macd: macdRaw,
    rsi: rsiScore,
    volume: volumeScore,
    momentum_1m: momentum1m,
    momentum_3m: momentum3m,
    reversal,
    volatility: volatilityRaw,
    short_momentum: shortMomentum,
    breakout,
    limit_up: limitUp,
    ma_squeeze: maSqueezeScore,
    vol_pattern: volPattern,
    entry_fit: null, // 在 scoreStocks 中计算（需要实时价格）
    limitup_state: limitupState,
    sector_heat: null, // 在 pipeline 中注入
    market_temp: null, // 在 pipeline 中注入
    vol_price_div: volPriceDiv,
    accumulation: null, // 在 scoreStocks 中计算（需要资金流数据）
    startup,
    pullback,
    platform,
    shrink_surge: shrinkSurge,
  }
}

/** 估值原始值：返回 PE（用于全市场分位比较），无效值返回 null */
function computeValuationRaw(info: StockInfo): number | null {
  const pe = info.pe
  if (pe === undefined || pe === null) return null
  if (pe <= 0 || pe > 300) return null // 亏损或异常值不参与分位
  return pe
}

/** 盈利能力原始值：ROE */
function computeProfitabilityRaw(fin?: Financials): number | null {
  if (!fin || fin.roe === undefined || fin.roe === null) return null
  return fin.roe
}

/** 成长性原始值：净利润增速（缺失用营收增速） */
function computeGrowthRaw(fin?: Financials): number | null {
  if (!fin) return null
  if (fin.profitGrowth !== undefined && fin.profitGrowth !== null) {
    return fin.profitGrowth
  }
  if (fin.revenueGrowth !== undefined && fin.revenueGrowth !== null) {
    return fin.revenueGrowth
  }
  return null
}

/** 资金面原始值：主力净流入占流通市值比例（%） */
function computeMoneyflowRaw(
  mf: MoneyFlow | undefined,
  info: StockInfo,
): number | null {
  if (!mf || mf.mainNetInflow === undefined || mf.mainNetInflow === null) return null
  const fmv = info.floatMv ?? info.totalMv
  if (!fmv || fmv <= 0) return null
  return (mf.mainNetInflow / fmv) * 100
}

/** 阈值分段打分助手：给定分档表，输出分数 */
function tierScore(
  value: number,
  tiers: Array<{ min: number; max: number; score: number }>,
): number {
  for (const t of tiers) {
    if (value >= t.min && value < t.max) return t.score
  }
  return 0
}

/**
 * 动量过热钳制打分：
 *  - 涨幅 0 ~ peak：线性升到满分（动量有效区）
 *  - 越过 peak：每超过一个 peak 长度降 30 分，防止追顶（周五涨最猛的妖股不再满分）
 *  - 下跌段：保持原有灵敏度（跌得越多分越低）
 */
function momentumOverheatScore(raw: number, peak: number): number {
  if (raw <= -0.1) return clamp(30 + raw * 100, 0, 30)
  if (raw <= 0) return clamp(30 + raw * 200, 30, 50)
  if (raw <= peak) return clamp(50 + (raw / peak) * 40, 50, 90)
  if (raw <= peak * 2) return clamp(90 - ((raw - peak) / peak) * 20, 70, 90)
  return clamp(70 - ((raw - peak * 2) / peak) * 30, 30, 70)
}

/** 主打分函数：给定一批股票与配置，返回排序后的评分结果 */
export function scoreStocks(
  inputs: ScoringInput[],
  factors: FactorDef[],
): StockScore[] {
  const enabledFactors = factors.filter((f) => f.enabled)
  if (enabledFactors.length === 0) return []

  // 权重归一化（仅启用因子）
  const weightSum = enabledFactors.reduce((s, f) => s + f.weight, 0) || 1
  const weightOf = new Map(enabledFactors.map((f) => [f.key, f.weight / weightSum]))

  // 估值分位：优先行业中性化（行业内分位），样本不足时退化为全市场分位
  const percentileOf = (() => {
    const byIndustry = new Map<string, number[]>()
    const marketPEs: number[] = []
    for (const input of inputs) {
      const pe = computeValuationRaw(input.info)
      if (pe === null) continue
      const ind = input.info.industry ?? ''
      if (!byIndustry.has(ind)) byIndustry.set(ind, [])
      byIndustry.get(ind)!.push(pe)
      marketPEs.push(pe)
    }
    for (const pes of byIndustry.values()) pes.sort((a, b) => a - b)
    marketPEs.sort((a, b) => a - b)

    const rankIn = (sorted: number[], v: number): number => {
      if (sorted.length === 0) return 0.5
      let lo = 0
      let hi = sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (sorted[mid] <= v) lo = mid + 1
        else hi = mid
      }
      return lo / sorted.length // 0~1，1 = 估值最高
    }

    // 返回 { 分位, 是否行业中性 }
    return (pe: number, industry?: string): { pct: number; isInd: boolean } => {
      const group = industry ? byIndustry.get(industry) : undefined
      if (group && group.length >= 5) {
        return { pct: rankIn(group, pe), isInd: true }
      }
      return { pct: rankIn(marketPEs, pe), isInd: false }
    }
  })()

  const results: StockScore[] = []
  for (const input of inputs) {
    // 涨停阈值：创业板(30)/科创板(688) 20%，主板 10%
    const isWide = input.info.code.startsWith('30') || input.info.code.startsWith('688')
    const limitUpThreshold = isWide ? 0.2 : 0.1
    const tech = computeTechnicalRaw(
      input.kline,
      limitUpThreshold,
      input.info.turnoverRate,
      input.info.floatMv ?? input.info.totalMv,
      (input as any)._marketTemp,
    )
    const factorScores: FactorScore[] = []
    let highRiskFlag = false

    for (const f of enabledFactors) {
      const w = weightOf.get(f.key) ?? 0
      let score: number | null = null
      let rawValue: number | null = null
      let detail = '数据不足'

      switch (f.key) {
        case 'trend': {
          rawValue = tech.trend
          if (rawValue !== null) {
            // 更严格的区分度：负分线性下降，正分缓慢上升
            if (rawValue < -0.1) {
              score = clamp(30 + rawValue * 100, 5, 30)
            } else if (rawValue < 0) {
              score = clamp(30 + rawValue * 200, 30, 50)
            } else if (rawValue < 0.15) {
              score = clamp(50 + rawValue * 200, 50, 80)
            } else if (rawValue < 0.3) {
              score = clamp(80 + (rawValue - 0.15) * 66, 80, 90)
            } else {
              score = clamp(90 + (rawValue - 0.3) * 50, 90, 100)
            }
            detail = `高于20日线 ${(rawValue * 100).toFixed(2)}% 综合`
          }
          break
        }
        case 'macd': {
          score = tech.macd
          rawValue = score
          if (score !== null) detail = `DIF-DEA柱体动量评分 ${score.toFixed(0)}`
          break
        }
        case 'rsi': {
          score = tech.rsi
          rawValue = score
          if (score !== null) detail = `RSI 状态评分 ${score.toFixed(0)}`
          break
        }
        case 'volume': {
          score = tech.volume
          rawValue = score
          if (score !== null) detail = `量比评分 ${score.toFixed(0)}`
          break
        }
        case 'momentum_1m': {
          rawValue = tech.momentum_1m
          if (rawValue !== null) {
            score = momentumOverheatScore(rawValue, 0.15)
            detail = `近1月涨幅 ${(rawValue * 100).toFixed(2)}%`
          }
          break
        }
        case 'momentum_3m': {
          rawValue = tech.momentum_3m
          if (rawValue !== null) {
            score = momentumOverheatScore(rawValue, 0.3)
            detail = `近3月涨幅 ${(rawValue * 100).toFixed(2)}%`
          }
          break
        }
        case 'short_momentum': {
          rawValue = tech.short_momentum
          if (rawValue !== null) {
            score = momentumOverheatScore(rawValue, 0.15)
            detail = `近3日涨幅 ${(rawValue * 100).toFixed(2)}%`
          }
          break
        }
        case 'breakout': {
          rawValue = tech.breakout
          if (rawValue !== null) {
            // 创新高程度：≥+5% 100，≥0 85，≥-3% 70，≥-6% 55，≥-10% 35，更低 20
            score = tierScore(rawValue, [
              { min: 0.05, max: Infinity, score: 100 },
              { min: 0, max: 0.05, score: 85 },
              { min: -0.03, max: 0, score: 70 },
              { min: -0.06, max: -0.03, score: 55 },
              { min: -0.1, max: -0.06, score: 35 },
              { min: -Infinity, max: -0.1, score: 20 },
            ])
            detail = `现价${rawValue >= 0 ? '已创新高' : `距20日高点 ${(Math.abs(rawValue) * 100).toFixed(1)}%`}`
          }
          break
        }
        case 'ma_squeeze': {
          score = tech.ma_squeeze
          rawValue = score
          if (score !== null) {
            const s = maSqueeze(input.kline)
            detail = s.breakout
              ? `均线粘合后放量突破（粘合度 ${((s.squeeze ?? 0) * 100).toFixed(1)}%）`
              : `均线粘合蓄势（粘合度 ${((s.squeeze ?? 0) * 100).toFixed(1)}%）`
          }
          break
        }
        case 'limit_up': {
          rawValue = tech.limit_up
          if (rawValue !== null) {
            // 连板高度：1板启动，2-4板黄金，5板+过高风险（降级）
            score = tierScore(rawValue, [
              { min: 5, max: Infinity, score: 60 }, // 高连板降级
              { min: 4, max: 5, score: 92 },
              { min: 3, max: 4, score: 90 },
              { min: 2, max: 3, score: 80 },
              { min: 1, max: 2, score: 60 },
              { min: 0, max: 1, score: 30 },
            ])
            // 高位风险预警：5 板以上 或 20日涨幅>50% 且 量比>4（放天量）
            const high20Gain = tech.momentum_3m !== null ? tech.momentum_3m > 0.5 : false
            const volumeRatio = tech.volume !== null && tech.volume >= 85 // volume 因子高分≈放量
            if (rawValue >= 5 || (high20Gain && volumeRatio)) {
              score = Math.min(score ?? 0, 45)
              highRiskFlag = true
              detail = `⚠️ 高位风险 · ${rawValue} 连板，注意追高风险`
            } else {
              detail = rawValue >= 1 ? `已 ${rawValue} 连板` : '未涨停'
            }
          }
          break
        }
        case 'reversal': {
          rawValue = tech.reversal
          if (rawValue !== null) {
            score = clamp(50 + rawValue * 500, 5, 100)
            detail = `近5日${rawValue >= 0 ? '下跌' : '上涨'} ${(Math.abs(rawValue) * 100).toFixed(2)}%`
          }
          break
        }
        case 'volatility': {
          rawValue = tech.volatility
          if (rawValue !== null) {
            score = clamp(50 - (rawValue - 30) * 0.6, 5, 100)
            detail = `20日年化波动 ${rawValue.toFixed(1)}%`
          }
          break
        }
        case 'valuation': {
          const pe = computeValuationRaw(input.info)
          rawValue = pe
          if (pe !== null) {
            const { pct, isInd } = percentileOf(pe, input.info.industry)
            score = clamp(100 - pct * 100, 0, 100)
            detail = `PE=${pe.toFixed(1)}，低于${
              isInd ? `${input.info.industry ?? '行业'}内` : '全市场'
            } ${(pct * 100).toFixed(0)}% 的股票`
          } else {
            detail = 'PE 缺失或非正'
          }
          break
        }
        case 'profitability': {
          const roe = computeProfitabilityRaw(input.financials)
          rawValue = roe
          if (roe !== null) {
            score = tierScore(roe, [
              { min: 25, max: Infinity, score: 100 },
              { min: 20, max: 25, score: 90 },
              { min: 15, max: 20, score: 80 },
              { min: 10, max: 15, score: 65 },
              { min: 5, max: 10, score: 50 },
              { min: 0, max: 5, score: 30 },
              { min: -Infinity, max: 0, score: 10 },
            ])
            detail = `ROE=${roe.toFixed(1)}%`
          }
          break
        }
        case 'growth': {
          const g = computeGrowthRaw(input.financials)
          rawValue = g
          if (g !== null) {
            score = tierScore(g, [
              { min: 50, max: Infinity, score: 100 },
              { min: 30, max: 50, score: 90 },
              { min: 20, max: 30, score: 75 },
              { min: 10, max: 20, score: 60 },
              { min: 0, max: 10, score: 45 },
              { min: -10, max: 0, score: 25 },
              { min: -Infinity, max: -10, score: 10 },
            ])
            detail = `净利润同比 ${g.toFixed(1)}%`
          }
          break
        }
        case 'moneyflow': {
          const m = computeMoneyflowRaw(input.moneyFlow, input.info)
          rawValue = m
          if (m !== null) {
            score = clamp(50 + m * 180, 0, 100)
            detail = `主力净流入占流通市值 ${m.toFixed(3)}%`
          }
          break
        }
        case 'moneyflow_5d': {
          const hist = input.moneyFlowHistory
          if (hist && hist.length >= 2) {
            const total = hist.reduce((a, b) => a + b, 0)
            const fmv = input.info.floatMv ?? input.info.totalMv
            const m5 = fmv && fmv > 0 ? (total / fmv) * 100 : null
            rawValue = m5
            if (m5 !== null) {
              score = clamp(50 + m5 * 250, 0, 100)
              const inflowDays = hist.filter((v) => v > 0).length
              detail = `近5日主力${total > 0 ? '净流入' : '净流出'}${(total / 1e8).toFixed(2)}亿 · ${inflowDays}/${hist.length}日流入`
            }
          }
          break
        }
        // ===== 新增因子 =====
        case 'vol_pattern': {
          // 量能形态：缩量蓄势 + 首次放量 + 量价配合
          rawValue = tech.vol_pattern
          if (rawValue !== null) {
            score = clamp(rawValue * 100, 0, 100)
            const tags: string[] = []
            if (rawValue >= 0.6) tags.push('蓄势')
            if (rawValue >= 0.8) tags.push('首次放量')
            detail = tags.length ? tags.join('+') : '量能一般'
          }
          break
        }
        case 'entry_fit': {
          // 买点契合度：用布林带下沿作支撑（比MA5更准）
          const kl = input.kline
          const cn = kl.length
          if (cn >= 20) {
            const c = kl.map(k => k.close)
            const bb = bollinger(c)
            const bbLower = lastValid(bb.lower) ?? c[cn-1] * 0.95
            const bbMid = lastValid(bb.middle) ?? c[cn-1]
            const cp = input.info.price ?? c[cn-1]
            // 买点区间：布林带下沿 ~ 中轨
            const buyLow = bbLower * 0.99
            const buyHigh = bbMid * 1.01
            if (cp >= buyLow && cp <= buyHigh) {
              const dist = (cp - buyLow) / (buyHigh - buyLow)
              rawValue = 1 - dist
              // 越靠近下沿分越高，但在中轨附近也要有一定分数
              score = clamp(100 - dist * 50, 50, 100)
              detail = `布林带低位距底${(dist * 100).toFixed(0)}%`
            } else if (cp > buyHigh && cp <= buyHigh * 1.05) {
              rawValue = 0.3
              score = 45
              detail = '中轨附近'
            } else if (cp < buyLow && cp >= buyLow * 0.97) {
              rawValue = 0.4
              score = 70
              detail = '略超下沿(低吸)'
            } else if (cp > buyHigh * 1.05) {
              rawValue = 0
              score = 15
              detail = '远离支撑(追高)'
            } else {
              rawValue = 0.2
              score = 35
              detail = '超跌区域'
            }
          }
          break
        }
        case 'limitup_state': {
          // 涨停状态：-1=今日涨停(0分), 1=涨停后1天(90分), 2=涨停后2天(70分), 3+=30分, 无=50分
          rawValue = tech.limitup_state
          if (rawValue !== null) {
            if (rawValue === -1) {
              score = 0
              detail = '今日涨停(买不进)'
            } else if (rawValue === 1) {
              score = 90
              detail = '涨停后1天(低吸)'
            } else if (rawValue === 2) {
              score = 70
              detail = '涨停后2天'
            } else if (rawValue >= 3) {
              score = 30
              detail = `涨停后${rawValue}天`
            } else {
              score = 50
              detail = '无涨停'
            }
          }
          break
        }
        case 'sector_heat': {
          // 板块热度：从 input._sectorStrength 读取（pipeline 注入）
          const heat = (input as any)._sectorStrength ?? null
          rawValue = heat
          if (heat !== null) {
            score = clamp(heat * 100, 0, 100)
            detail = `板块热度 ${(heat * 100).toFixed(0)}%`
          }
          break
        }
        case 'market_temp': {
          // 大盘温度：从 input._marketTemp 读取（pipeline 注入）
          const temp = (input as any)._marketTemp ?? null
          rawValue = temp
          if (temp !== null) {
            // 温度 40~70 最佳（不冷不热），<30 太冷，>80 太热
            if (temp >= 40 && temp <= 70) {
              score = 80 + (temp - 40) * (20 / 30) // 80~100
              detail = `大盘温和(${temp.toFixed(0)}°)`
            } else if (temp < 40) {
              score = temp * 2 // 0~80
              detail = `大盘偏冷(${temp.toFixed(0)}°)`
            } else {
              score = Math.max(0, 100 - (temp - 70) * 3) // 100~70
              detail = `大盘偏热(${temp.toFixed(0)}°)`
            }
          }
          break
        }
        case 'vol_price_div': {
          // 量价背离：价涨量缩 = 主力控盘
          rawValue = tech.vol_price_div
          if (rawValue !== null) {
            score = clamp(rawValue * 100, 0, 100)
            detail = rawValue >= 0.7 ? '量价背离(控盘)' : rawValue >= 0.5 ? '轻度背离' : '缩量回调'
          }
          break
        }
        case 'accumulation': {
          // 吸筹痕迹：大单买入+小单卖出 = 主力建仓
          const mf = input.moneyFlow
          if (mf && mf.mainNetInflow !== undefined) {
            const superVal = mf.superNetInflow ?? 0
            const bigVal = mf.bigNetInflow ?? 0
            const mainVal = mf.mainNetInflow
            // 超大单+大单占主力比例高 = 机构在建仓
            const totalBig = Math.abs(superVal) + Math.abs(bigVal)
            const ratio = Math.abs(mainVal) > 0 ? totalBig / Math.abs(mainVal) : 0
            // 主力净流入 + 大单占比高 = 吸筹
            if (mainVal > 0 && ratio > 0.6) {
              rawValue = ratio
              score = clamp(50 + ratio * 30 + mainVal / 1e7, 50, 100)
              detail = `吸筹(大单占比${(ratio * 100).toFixed(0)}%)`
            } else if (mainVal > 0) {
              rawValue = 0.3
              score = 50
              detail = '资金流入'
            } else {
              rawValue = 0
              score = 20
              detail = '资金流出'
            }
          }
          break
        }
        case 'startup': {
          // 启动形态：涨停+粘合+缩量+突破
          rawValue = tech.startup
          if (rawValue !== null) {
            score = clamp(rawValue * 100, 0, 100)
            if (rawValue >= 0.8) detail = '启动形态(最佳)'
            else if (rawValue >= 0.6) detail = '启动形态'
            else if (rawValue >= 0.4) detail = '启动中'
            else detail = '非启动阶段'
          }
          break
        }
        case 'pullback': {
          // 回踩低吸：涨停+突破过+回踩均线缩量企稳
          rawValue = tech.pullback
          if (rawValue !== null) {
            score = clamp(rawValue * 100, 0, 100)
            if (rawValue >= 0.8) detail = '回踩低吸(最佳)'
            else if (rawValue >= 0.6) detail = '回踩企稳'
            else if (rawValue >= 0.4) detail = '回踩中'
            else detail = '非回踩形态'
          }
          break
        }
        case 'platform': {
          // 平台突破：横盘平台+放量突破+上升趋势
          rawValue = tech.platform
          if (rawValue !== null) {
            score = clamp(rawValue * 100, 0, 100)
            if (rawValue >= 0.8) detail = '平台放量突破(最佳)'
            else if (rawValue >= 0.6) detail = '平台突破'
            else if (rawValue >= 0.4) detail = '接近突破'
            else detail = '非平台突破'
          }
          break
        }
        case 'shrink_surge': {
          // 缩量蓄势突破：前期放量→缩量洗盘→突破启动主升浪
          rawValue = tech.shrink_surge
          if (rawValue !== null) {
            score = clamp(rawValue * 100, 0, 100)
            if (rawValue >= 0.7) detail = '缩量蓄势突破(最佳)'
            else if (rawValue >= 0.55) detail = '蓄势突破'
            else if (rawValue >= 0.4) detail = '缩量蓄势中'
            else detail = '非突破形态'
          }
          break
        }
      }

      if (score !== null) {
        factorScores.push({
          key: f.key,
          name: f.name,
          group: f.group,
          rawValue,
          score,
          weight: w,
          detail,
        })
      }
    }

    // 总分：按实际可得因子的归一化权重加权
    const availSum = factorScores.reduce((s, fs) => s + fs.weight, 0)
    const rawTotal =
      availSum > 0
        ? factorScores.reduce((s, fs) => s + fs.score * (fs.weight / availSum), 0)
        : 0
    const coverage = weightSum > 0 ? availSum / weightSum : 0
    // 缺失因子不再被完全重新归一化掩盖，覆盖率低于 80% 时按比例降分。
    const coveragePenalty = coverage >= 0.8 ? 1 : coverage / 0.8

    // 通用高位风控（不依赖 limit_up 因子是否启用）：
    // 5 连板及以上，或 近20日涨幅>50% 且放量 → 标记高位风险并降分（不只警告）
    let total = rawTotal * coveragePenalty
    if (!highRiskFlag) {
      const lu = tech.limit_up
      if (lu !== null && lu >= 5) {
        highRiskFlag = true
      } else if (
        tech.momentum_1m !== null &&
        tech.momentum_1m > 0.5 &&
        (tech.volume ?? 0) >= 85
      ) {
        highRiskFlag = true
      }
    }
    if (highRiskFlag) total *= 0.7

    results.push({
      code: input.info.code,
      name: input.info.name,
      market: input.info.market,
      industry: input.info.industry,
      concept: input.info.concept,
      highRisk: highRiskFlag,
      totalScore: Number(total.toFixed(1)),
      dataCoverage: Number(coverage.toFixed(3)),
      price: input.info.price,
      changePct: input.info.changePct,
      totalMv: input.info.totalMv,
      floatMv: input.info.floatMv,
      pe: input.info.pe,
      pb: input.info.pb,
      turnoverRate: input.info.turnoverRate,
      factorScores,
    })
  }

  return results.sort((a, b) => b.totalScore - a.totalScore)
}

/** 布林带位置（供详情页展示） */
export function bollingerPosition(kline: Kline[]): number | null {
  if (kline.length < 20) return null
  const close = kline.map((k) => k.close)
  const bb = bollinger(close)
  const u = lastValid(bb.upper)
  const l = lastValid(bb.lower)
  const m = lastValid(bb.middle)
  if (u === null || l === null || m === null) return null
  const last = close[close.length - 1]
  return (last - l) / (u - l)
}
