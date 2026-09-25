import { scoreStocks } from './factors'
import { calcShrinkSurgeScore } from './shrink-surge-factor'
import type { FactorDef, Kline, StockInfo } from '../types'

/** 候选股票（含 K 线） */
interface KlineStock {
  code: string
  name: string
  kline: Kline[]
}

/** 由代码推断市场（回测用） */
function marketOf(code: string): StockInfo['market'] {
  if (code.startsWith('6')) return 'sh'
  if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return 'bj'
  return 'sz'
}

export interface StartupBacktestConfig {
  topN: number // 每期持仓数
  holdDays: number // 持有天数
  lookbackDays: number // 回测覆盖交易日
  minScore: number // 最低入选分
  stopLossPct: number // 止损百分比（如 8 → 亏8%离场）
  takeProfitPct: number // 止盈百分比（如 15 → 赚15%离场）
  stopUseClose?: boolean // true=收盘价触发止损（避免盘中假摔），默认 true
  marketFilterPct?: number // 大盘5日跌幅超过此值则空仓（如 3 → 跌超3%不交易），0=关闭
  factorKey?: string // 打分因子：'startup'（启动）或 'pullback'（回踩低吸），默认 startup
  requireMarketUp?: boolean // true=只在大盘20日中位涨幅>0时交易（只在上升市做）
  useRawScore?: boolean // true=使用原始因子分数（不经过归一化和权重计算），适用于 shrink_surge
  /** 资金流历史：code → (日期 → 当日主力净流入)，用于"资金趋势"排序加成（和首页一致） */
  moneyFlowByCode?: Map<string, Map<string, number>>
}

export interface StartupTrade {
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

export interface StartupBacktestResult {
  startDate: string
  endDate: string
  totalReturn: number
  avgReturn: number
  winRate: number
  maxReturn: number
  minReturn: number
  maxDrawdown: number
  tradeCount: number
  trades: StartupTrade[]
}

/** 构造只启用单个因子的配置 */
function singleFactor(key: string, name: string): FactorDef[] {
  return [{ key, name, group: 'technical', weight: 1, enabled: true, desc: '' }]
}

const STARTUP_ONLY = singleFactor('startup', '启动形态')
const PULLBACK_ONLY = singleFactor('pullback', '回踩低吸')
const PLATFORM_ONLY = singleFactor('platform', '平台突破')
const SHRINK_SURGE_ONLY = singleFactor('shrink_surge', '缩量蓄势突破')

/** 计算某只股票在某日的形态得分（用截至该日的数据） */
function scoreAtDay(
  code: string,
  name: string,
  kline: Kline[],
  dayIdx: number,
  factorKey: string,
  useRawScore?: boolean,
): number {
  if (dayIdx < 30) return 0
  const slice = kline.slice(0, dayIdx + 1)

  // 如果使用原始因子分数（不经过归一化和权重计算）
  if (useRawScore && factorKey === 'shrink_surge') {
    const scores = calcShrinkSurgeScore(slice)
    const score = scores[scores.length - 1]
    return score !== null ? score : 0 // 直接使用原始分数（0-1）
  }

  const info: StockInfo = { code, name, market: marketOf(code) }
  const factors =
    factorKey === 'pullback'
      ? PULLBACK_ONLY
      : factorKey === 'platform'
        ? PLATFORM_ONLY
        : factorKey === 'shrink_surge'
          ? SHRINK_SURGE_ONLY
          : STARTUP_ONLY
  const scored = scoreStocks([{ info, kline: slice }], factors)
  return scored.length > 0 ? scored[0].totalScore : 0
}

function priceAtDay(kline: Kline[], dayIdx: number): number | null {
  if (dayIdx < 0 || dayIdx >= kline.length) return null
  return kline[dayIdx].close
}

/**
 * 运行启动策略回测
 * 滚动评分 → 每期选 Top N → 持有 holdDays 天 → 统计收益
 */
export function runStartupBacktest(
  candidates: KlineStock[],
  config: StartupBacktestConfig,
): StartupBacktestResult {
  const { topN, holdDays, lookbackDays, minScore } = config
  const stopLossPct = Math.max(0, config.stopLossPct)
  const takeProfitPct = Math.max(0, config.takeProfitPct)
  const stopUseClose = config.stopUseClose !== false // 默认收盘价止损
  const marketFilterPct = config.marketFilterPct ?? 0
  const factorKey = config.factorKey ?? 'startup'
  const moneyFlowByCode = config.moneyFlowByCode

  // 资金趋势加成：近5日主力净流入天数越多，加成越高（调整为0-1范围以匹配shrink_surge因子）
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
    // 流入天数 0~5 → -0.15 ~ +0.15（缩小100倍以匹配0-1的因子分数）
    return (inflowDays - hist.length / 2) * (0.3 / hist.length)
  }

  // 大盘代理：候选池所有股票的中位N日涨幅
  const marketReturnN = (day: number, n: number): number => {
    const rets: number[] = []
    for (const c of pool) {
      const a = c.kline[day]?.close
      const b = c.kline[day - n]?.close
      if (a && b && b > 0) rets.push(a / b - 1)
    }
    if (rets.length === 0) return 0
    rets.sort((x, y) => x - y)
    return rets[Math.floor(rets.length / 2)]
  }
  const marketReturn5 = (day: number) => marketReturnN(day, 5)
  const empty: StartupBacktestResult = {
    startDate: '', endDate: '', totalReturn: 0, avgReturn: 0, winRate: 0,
    maxReturn: 0, minReturn: 0, maxDrawdown: 0, tradeCount: 0, trades: [],
  }
  // 只保留 K 线足够长的股票（评分需要至少 70 根 + 持有期）
  const need = 70 + holdDays
  const pool = candidates.filter((c) => c.kline.length >= need)
  if (pool.length === 0) return empty

  const maxLen = Math.max(...pool.map((c) => c.kline.length))
  // 回测"最近的 lookbackDays 天"：从数组末尾往前取（而非从头）
  const startDay = Math.max(70, maxLen - lookbackDays)
  const lastDay = maxLen - 1
  if (lastDay - startDay < holdDays * 2) return empty

  const trades: StartupTrade[] = []
  const equityCurve: number[] = [1]
  let equity = 1

  // 从 startDay（够算形态）开始，每 holdDays 调仓
  for (let day = startDay; day < lastDay - holdDays; day += holdDays) {
    // 大盘择时：大盘5日中位跌幅超过阈值 → 空仓不交易
    if (marketFilterPct > 0 && marketReturn5(day) * 100 < -marketFilterPct) {
      continue
    }
    // 上升市过滤：只在大盘20日中位涨幅>0时交易
    if (config.requireMarketUp && day >= 20 && marketReturnN(day, 20) <= 0) {
      continue
    }
    const scored = pool
      .map((c) => ({
        ...c,
        score: scoreAtDay(c.code, c.name, c.kline, day, factorKey, config.useRawScore)
          + moneyBonus(c.code, c.kline, day),
      }))
      .filter((s) => s.score >= (config.useRawScore ? minScore / 100 : minScore))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)

    if (scored.length === 0) continue

    const entryDate = pool[0].kline[day]?.date ?? ''

    let periodReturn = 0
    let valid = 0
    for (const s of scored) {
      const entryPrice = priceAtDay(s.kline, day)
      if (entryPrice === null || entryPrice <= 0) continue

      const exitIdx = Math.min(day + holdDays, lastDay)
      let actualExitIdx = exitIdx
      let exitPrice = priceAtDay(s.kline, exitIdx)
      let exitReason: StartupTrade['exitReason'] = '到期'
      const stopPrice = entryPrice * (1 - stopLossPct / 100)
      const targetPrice = entryPrice * (1 + takeProfitPct / 100)
      for (let d = day + 1; d <= exitIdx; d++) {
        const bar = s.kline[d]
        if (!bar) continue
        const stopHit = stopLossPct > 0 && (stopUseClose ? bar.close <= stopPrice : bar.low <= stopPrice)
        if (stopHit) {
          exitPrice = stopUseClose ? bar.close : (bar.open <= stopPrice ? bar.open : stopPrice)
          actualExitIdx = d
          exitReason = '止损'
          break
        }
        if (takeProfitPct > 0 && bar.high >= targetPrice) {
          exitPrice = bar.open >= targetPrice ? bar.open : targetPrice
          actualExitIdx = d
          exitReason = '止盈'
          break
        }
      }

      if (exitPrice === null || exitPrice === undefined || exitPrice <= 0) continue
      const exitDate = s.kline[actualExitIdx]?.date ?? ''
      const returnPct = (exitPrice / entryPrice - 1) * 100

      periodReturn += returnPct
      valid++

      trades.push({
        date: entryDate,
        code: s.code,
        name: s.name,
        score: Math.round(s.score * 100),
        entryPrice,
        exitPrice,
        exitDate,
        returnPct: Number(returnPct.toFixed(2)),
        exitReason,
      })
    }

    if (valid > 0) {
      // 正确的等权组合：本期平均收益
      const avgPeriod = periodReturn / valid
      equity *= 1 + avgPeriod / 100
      equityCurve.push(equity)
    }
  }

  if (trades.length === 0) return empty

  const returns = trades.map((t) => t.returnPct)
  const wins = returns.filter((r) => r > 0).length
  const totalReturn = (equity - 1) * 100

  // 最大回撤（基于净值曲线）
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
    maxReturn: Math.max(...returns),
    minReturn: Math.min(...returns),
    maxDrawdown: Number((maxDD * 100).toFixed(2)),
    tradeCount: trades.length,
    trades: trades.slice(-30),
  }
}
