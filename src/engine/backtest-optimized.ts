import { calcShrinkSurgeScore } from './shrink-surge-factor'
import type { Kline } from '../types'

/** 候选股票（含 K 线） */
interface KlineStock {
  code: string
  name: string
  kline: Kline[]
}

export interface OptimizedBacktestConfig {
  topN: number
  holdDays: number
  lookbackDays: number
  minScore: number
  stopLossPct: number
  takeProfitPct: number
  factorKey?: string
  enableBreakthroughTiming?: boolean // 突破时机优化
  enablePullbackEntry?: boolean // 回踩买点优化
  enableMineDetection?: boolean // 排雷规则
  enableDynamicExit?: boolean // 动态止盈止损
  moneyFlowByCode?: Map<string, Map<string, number>>
  /** 买卖双边综合成本，按每期组合收益扣除。 */
  costRate?: number
}

export interface OptimizedTrade {
  date: string
  code: string
  name: string
  score: number
  entryPrice: number
  exitPrice: number
  exitDate: string
  returnPct: number
  exitReason: '止盈' | '止损' | '到期'
}

export interface OptimizedBacktestResult {
  startDate: string
  endDate: string
  totalReturn: number
  avgReturn: number
  winRate: number
  maxReturn: number
  minReturn: number
  maxDrawdown: number
  tradeCount: number
  trades: OptimizedTrade[]
  baselineReturn?: number
  improvement?: number
}

/** 计算某只股票在某日的形态得分 */
function scoreAtDay(
  _code: string,
  _name: string,
  kline: Kline[],
  dayIdx: number,
  _factorKey: string,
): number {
  if (dayIdx < 30) return 0
  const slice = kline.slice(0, dayIdx + 1)

  // 使用原始因子分数（不经过归一化和权重计算）
  const scores = calcShrinkSurgeScore(slice)
  const score = scores[scores.length - 1]
  return score !== null ? score * 100 : 0 // 缩放到0-150范围（calcShrinkSurgeScore返回0-1.5）
}

function priceAtDay(kline: Kline[], dayIdx: number): number | null {
  if (dayIdx < 0 || dayIdx >= kline.length) return null
  return kline[dayIdx].close
}

/** 突破时机优化：判断突破确认度 */
function breakthroughTimingBonus(kline: Kline[], dayIdx: number): number {
  if (dayIdx < 20) return 0
  const today = kline[dayIdx]
  const yesterday = kline[dayIdx - 1]
  if (!today || !yesterday) return 0

  // 突破当天 = 1.0分，后面每天递减 0.2
  const ma20 = kline.slice(dayIdx - 19, dayIdx + 1).reduce((sum, k) => sum + k.close, 0) / 20
  const justBreakthrough = yesterday.close <= ma20 && today.close > ma20
  if (justBreakthrough) return 10 // 突破当天加10分

  // 突破后1-3天内回踩但未跌破均线
  for (let i = 1; i <= 3 && dayIdx - i >= 0; i++) {
    const prevDay = kline[dayIdx - i]
    const prevPrevDay = kline[dayIdx - i - 1]
    if (prevDay && prevPrevDay && prevPrevDay.close <= ma20 && prevDay.close > ma20) {
      return Math.max(0, 10 - i * 3) // 递减
    }
  }

  return 0
}

/** 回踩买点优化：识别黄金坑 */
function pullbackEntryBonus(kline: Kline[], dayIdx: number): number {
  if (dayIdx < 30) return 0
  const today = kline[dayIdx]
  const ma10 = kline.slice(dayIdx - 9, dayIdx + 1).reduce((sum, k) => sum + k.close, 0) / 10

  // 回踩10日均线 + 缩量 = 黄金坑
  const nearMA = Math.abs(today.close - ma10) / ma10 < 0.03 // 价格在均线±3%内
  const avgVol5 = kline.slice(dayIdx - 4, dayIdx + 1).reduce((sum, k) => sum + k.volume, 0) / 5
  const avgVol10 = kline.slice(dayIdx - 9, dayIdx + 1).reduce((sum, k) => sum + k.volume, 0) / 10
  const shrinking = avgVol5 < avgVol10 * 0.8 // 近5日量能 < 10日均量80%

  if (nearMA && shrinking) return 8 // 黄金坑加8分

  return 0
}

/** 排雷规则：过滤高风险票 */
function shouldFilter(kline: Kline[], dayIdx: number): boolean {
  if (dayIdx < 60) return false
  const today = kline[dayIdx]

  // 高位放量：距60日高点<10% 且 成交额较大
  const high60 = Math.max(...kline.slice(dayIdx - 59, dayIdx + 1).map(k => k.high))
  const distFromHigh = (high60 - today.close) / high60

  // 用成交额/流通市值估算换手率（简化，因为 Kline 没有 turnover）
  // 这里只判断高位，暂时注释掉换手率判断
  // const highTurnover = today.turnover && today.turnover > 15
  const isNearHigh = distFromHigh < 0.1

  // 简化：只判断是否在高位且成交额明显放大
  const avgAmount10 = kline.slice(dayIdx - 9, dayIdx + 1).reduce((sum, k) => sum + k.amount, 0) / 10
  const highVolume = today.amount > avgAmount10 * 2 // 成交额是10日均量2倍以上

  if (isNearHigh && highVolume) return true // 高位放量，剔除

  // 连续涨停3板以上（假设涨停=涨幅>9.5%）
  let consecutiveLimits = 0
  for (let i = 0; i < 3 && dayIdx - i >= 0; i++) {
    const k = kline[dayIdx - i]
    const prevK = kline[dayIdx - i - 1]
    if (k && prevK && k.close / prevK.close - 1 > 0.095) {
      consecutiveLimits++
    } else {
      break
    }
  }
  if (consecutiveLimits >= 3) return true // 连板3板以上，剔除

  return false
}

/** 动态止盈止损 */
function dynamicExitLogic(
  entryPrice: number,
  kline: Kline[],
  entryDay: number,
  holdDays: number,
  lastDay: number,
): { exitPrice: number; exitIdx: number; exitReason: '止盈' | '止损' | '到期' } {
  let exitPrice = priceAtDay(kline, Math.min(entryDay + holdDays, lastDay)) || entryPrice
  let exitIdx = Math.min(entryDay + holdDays, lastDay)
  let exitReason: '止盈' | '止损' | '到期' = '到期'

  let highestPrice = entryPrice
  const maxDay = Math.min(entryDay + holdDays, lastDay, kline.length - 1)
  for (let d = entryDay + 1; d <= maxDay; d++) {
    const k = kline[d]
    if (!k) break

    highestPrice = Math.max(highestPrice, k.high)
    const unrealizedGain = (highestPrice / entryPrice - 1) * 100

    // 快速拉升（3天涨15%+）→ 涨20%卖80%仓位
    if (d - entryDay <= 3 && unrealizedGain >= 20) {
      exitPrice = entryPrice * 1.2
      exitIdx = d
      exitReason = '止盈'
      break
    }

    // 固定止损优先：使用日内低点，跳空按开盘成交。
    if (k.low <= entryPrice * 0.95) {
      exitPrice = k.open <= entryPrice * 0.95 ? k.open : entryPrice * 0.95
      exitIdx = d
      exitReason = '止损'
      break
    }

    // 稳健上涨 → 跌破5日均线卖出
    if (unrealizedGain >= 10 && unrealizedGain < 30 && d >= 4) {
      const slice = kline.slice(Math.max(0, d - 4), d + 1)
      if (slice.length === 5) {
        const ma5 = slice.reduce((sum, ks) => sum + ks.close, 0) / 5
        if (k.close < ma5) {
          exitPrice = k.open < ma5 ? k.open : k.close
          exitIdx = d
          exitReason = '止盈'
          break
        }
      }
    }

    // 慢牛（涨30%+）→ 跌破10日均线卖出
    if (unrealizedGain >= 30 && d >= 9) {
      const slice = kline.slice(Math.max(0, d - 9), d + 1)
      if (slice.length === 10) {
        const ma10 = slice.reduce((sum, ks) => sum + ks.close, 0) / 10
        if (k.close < ma10) {
          exitPrice = k.open < ma10 ? k.open : k.close
          exitIdx = d
          exitReason = '止盈'
          break
        }
      }
    }

  }

  return { exitPrice, exitIdx, exitReason }
}

/**
 * 运行优化策略回测
 */
export function runOptimizedBacktest(
  candidates: KlineStock[],
  config: OptimizedBacktestConfig,
): OptimizedBacktestResult {
  const {
    topN,
    holdDays,
    lookbackDays,
    minScore,
    stopLossPct,
    takeProfitPct,
    factorKey = 'shrink_surge',
    enableBreakthroughTiming = false,
    enablePullbackEntry = false,
    enableMineDetection = false,
    enableDynamicExit = false,
    moneyFlowByCode,
  } = config

  const moneyBonus = (code: string, kline: Kline[], dayIdx: number): number => {
    if (!moneyFlowByCode) return 0
    const m = moneyFlowByCode.get(code)
    if (!m) return 0
    const hist: number[] = []
    for (let i = dayIdx; i >= 0 && hist.length < 5; i--) {
      const d = kline[i]?.date
      if (d && m.has(d)) hist.push(m.get(d)!)
    }
    if (hist.length < 3) return 0
    const inflowDays = hist.filter((v) => v > 0).length
    return (inflowDays - hist.length / 2) * (30 / hist.length)
  }

  const empty: OptimizedBacktestResult = {
    startDate: '',
    endDate: '',
    totalReturn: 0,
    avgReturn: 0,
    winRate: 0,
    maxReturn: 0,
    minReturn: 0,
    maxDrawdown: 0,
    tradeCount: 0,
    trades: [],
  }

  const need = 70 + holdDays + 1
  // K线必须按日期升序，重复日期会破坏“次日成交”的时序。
  const pool = candidates
    .map((c) => ({ ...c, kline: [...c.kline].sort((a, b) => a.date.localeCompare(b.date)) }))
    .filter((c) => c.kline.length >= need)
  if (pool.length === 0) return empty

  // 用真实日期轴对齐不同上市日/缺失交易日的股票，禁止用数组下标跨股票比较。
  const dates = [...new Set(pool.flatMap((c) => c.kline.map((k) => k.date)))].sort()
  const byDate = pool.map((c) => new Map(c.kline.map((k, i) => [k.date, i])))
  const lastGlobalDay = dates.length - 1
  const startGlobalDay = Math.max(70, lastGlobalDay - lookbackDays)
  if (lastGlobalDay - startGlobalDay < holdDays + 1) return empty

  const trades: OptimizedTrade[] = []
  const equityCurve: number[] = [1]
  let equity = 1

  // T日收盘后评分，T+1日开盘成交；每期持有 holdDays 个交易日。
  for (let signalDay = startGlobalDay; signalDay < lastGlobalDay - holdDays; signalDay += holdDays) {
    const scored = pool
      .map((c, stockIdx) => {
        const signalIdx = byDate[stockIdx].get(dates[signalDay])
        if (signalIdx === undefined) return { ...c, score: -Infinity, signalIdx: -1 }
        let score = scoreAtDay(c.code, c.name, c.kline, signalIdx, factorKey)
        score += moneyBonus(c.code, c.kline, signalIdx)

        // 优化1: 突破时机加成
        if (enableBreakthroughTiming) {
          score += breakthroughTimingBonus(c.kline, signalIdx)
        }

        // 优化2: 回踩买点加成
        if (enablePullbackEntry) {
          score += pullbackEntryBonus(c.kline, signalIdx)
        }

        // 所有加成只用于排序，统一限制在 0~100，阈值含义稳定。
        return { ...c, score: Math.max(0, Math.min(100, score)), signalIdx }
      })
      .filter((s) => {
        if (s.signalIdx < 0) return false
        // 优化3: 排雷规则
        if (enableMineDetection && shouldFilter(s.kline, s.signalIdx)) {
          return false
        }
        return s.score >= minScore
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)

    if (scored.length === 0) continue

    const entryGlobalDay = signalDay + 1
    const entryDate = dates[entryGlobalDay] ?? ''

    let periodReturn = 0
    let valid = 0
    for (const s of scored) {
      const stockIdx = pool.findIndex((p) => p.code === s.code)
      const entryIdx = byDate[stockIdx].get(entryDate)
      if (entryIdx === undefined) continue
      const entryBar = s.kline[entryIdx]
      const entryPrice = entryBar.open
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue

      let exitPrice: number
      let exitIdx: number
      let exitReason: '止盈' | '止损' | '到期'

      // 优化4: 动态止盈止损
      if (enableDynamicExit) {
        const lastDate = dates[Math.min(entryGlobalDay + holdDays - 1, lastGlobalDay)]
        const lastIdx = byDate[stockIdx].get(lastDate) ?? entryIdx
        const result = dynamicExitLogic(entryPrice, s.kline, entryIdx, holdDays - 1, lastIdx)
        exitPrice = result.exitPrice
        exitIdx = result.exitIdx
        exitReason = result.exitReason
      } else {
        // 基准策略：固定止损止盈
        const stopPrice = entryPrice * (1 - stopLossPct / 100)
        const targetPrice = entryPrice * (1 + takeProfitPct / 100)
        const lastDate = dates[Math.min(entryGlobalDay + holdDays - 1, lastGlobalDay)]
        const lastIdx = byDate[stockIdx].get(lastDate) ?? entryIdx

        exitPrice = priceAtDay(s.kline, lastIdx) || entryPrice
        exitIdx = lastIdx
        exitReason = '到期'

        for (let d = entryIdx + 1; d <= lastIdx; d++) {
          const k = s.kline[d]
          if (!k) break

          // 日内同时触发止损/止盈时按止损优先，避免使用收盘价美化结果。
          if (stopLossPct > 0 && k.low <= stopPrice) {
            exitPrice = k.open <= stopPrice ? k.open : stopPrice
            exitIdx = d
            exitReason = '止损'
            break
          }

          if (takeProfitPct > 0 && k.high >= targetPrice) {
            exitPrice = k.open >= targetPrice ? k.open : targetPrice
            exitIdx = d
            exitReason = '止盈'
            break
          }
        }
      }

      const exitDate = s.kline[exitIdx]?.date ?? entryDate
      const returnPct = (exitPrice / entryPrice - 1) * 100
      periodReturn += returnPct
      valid++
      trades.push({
        date: entryDate,
        code: s.code,
        name: s.name,
        score: Math.round(s.score),
        entryPrice,
        exitPrice,
        exitDate,
        returnPct: Number(returnPct.toFixed(2)),
        exitReason,
      })
    }

    if (valid > 0) {
      const avgPeriod = periodReturn / valid
      const costRate = Math.max(0, config.costRate ?? 0.0015)
      equity *= Math.max(0, 1 + avgPeriod / 100 - costRate)
      equityCurve.push(equity)
    }
  }

  if (trades.length === 0) return empty

  const returns = trades.map((t) => t.returnPct)
  const wins = returns.filter((r) => r > 0).length
  const totalReturn = (equity - 1) * 100

  let peak = equityCurve[0]
  let maxDD = 0
  for (const v of equityCurve) {
    if (v > peak) peak = v
    const dd = (peak - v) / peak
    if (dd > maxDD) maxDD = dd
  }

  return {
    startDate: trades[0]?.date ?? '',
    endDate: trades[trades.length - 1]?.exitDate ?? '',
    totalReturn: Number(totalReturn.toFixed(2)),
    avgReturn: Number((returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2)),
    winRate: Number(((wins / returns.length) * 100).toFixed(1)),
    maxReturn: Number(Math.max(...returns).toFixed(2)),
    minReturn: Number(Math.min(...returns).toFixed(2)),
    maxDrawdown: Number((maxDD * 100).toFixed(2)),
    tradeCount: trades.length,
    trades: trades.slice(-30),
  }
}
