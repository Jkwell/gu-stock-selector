import type { FactorDef, Kline } from '../types'
import { buildTechnicalCalculators } from './rawFactors'

/**
 * 简易回测引擎
 * 在历史各调仓日对候选池按技术因子打分，选出 Top N 等权持有，
 * 滚动到下一调仓日换仓，计算组合净值与绩效指标。
 * 仅使用技术因子（基本面因子在历史截面难获取，MVP 阶段不纳入）。
 *
 * 时序约定：调仓日 T 收盘后用 T 日数据打分并换仓，T+1 日生效。
 */

export interface BacktestConfig {
  startDate: string // 'YYYY-MM-DD'
  endDate: string
  topN: number // 每期持仓数
  rebalanceDays: number // 调仓间隔交易日（20 ≈ 每月）
  factors: FactorDef[] // 技术因子配置
}

export interface BacktestTrade {
  rebalanceDate: string
  codes: string[] // 本期持仓代码
  periodReturn: number // 本期组合收益（%）
  benchmarkReturn: number // 本期基准收益（%）
}

export interface BacktestResult {
  dates: string[]
  portfolio: number[] // 组合净值（起点 = 1）
  benchmark: number[] // 基准净值（全部候选等权）
  trades: BacktestTrade[]
  totalReturn: number // 累计收益 %
  annualReturn: number // 年化收益 %
  sharpe: number // 夏普比率（日频年化）
  maxDrawdown: number // 最大回撤 %
  winRate: number // 调仓期跑赢基准的比例 %
  excessReturn: number // 累计超额收益 %
}

/** 在调仓日对候选池打分（横截面分位归一化 + 加权） */
function scoreAt(
  rawByStock: Array<(number | null)[]>,
  direction: 'higher' | 'lower',
  rebalIdx: number,
): Map<number, number> {
  const valid: Array<{ si: number; v: number }> = []
  rawByStock.forEach((vals, si) => {
    const v = vals[rebalIdx]
    if (v !== null && v !== undefined && Number.isFinite(v)) valid.push({ si, v })
  })
  if (valid.length === 0) return new Map()
  const sorted = [...valid].sort((a, b) => a.v - b.v)
  const scoreOf = new Map<number, number>()
  sorted.forEach((item, idx) => {
    const pctRank = idx / (sorted.length - 1 || 1)
    scoreOf.set(item.si, direction === 'higher' ? pctRank * 100 : (1 - pctRank) * 100)
  })
  return scoreOf
}

/** 空结果 */
function emptyResult(dates: string[]): BacktestResult {
  return {
    dates, portfolio: [], benchmark: [], trades: [],
    totalReturn: 0, annualReturn: 0, sharpe: 0, maxDrawdown: 0, winRate: 0, excessReturn: 0,
  }
}

/** 运行回测 */
export function runBacktest(
  stocks: Array<{ code: string; kline: Kline[] }>,
  config: BacktestConfig,
): BacktestResult {
  const calcs = buildTechnicalCalculators()
  const enabledTech = calcs.filter((c) =>
    config.factors.some((f) => f.enabled && f.key === c.key),
  )
  if (enabledTech.length === 0 || stocks.length === 0) return emptyResult([])

  // 权重归一化（仅启用技术因子）
  const weightMap = new Map<string, number>()
  const wSum =
    enabledTech.reduce(
      (s, c) => s + (config.factors.find((f) => f.key === c.key)?.weight ?? 0),
      0,
    ) || 1
  for (const c of enabledTech) {
    weightMap.set(c.key, (config.factors.find((f) => f.key === c.key)?.weight ?? 0) / wSum)
  }

  // 日期轴（start~end 区间内的全部交易日，升序）
  const dateSet = new Set<string>()
  for (const s of stocks) {
    for (const k of s.kline) {
      if (k.date >= config.startDate && k.date <= config.endDate) dateSet.add(k.date)
    }
  }
  const dates = [...dateSet].sort()
  if (dates.length === 0) return emptyResult(dates)

  const nStocks = stocks.length
  const priceAt = stocks.map((s) => {
    const byDate = new Map(s.kline.map((k) => [k.date, k.close]))
    return dates.map((d) => byDate.get(d) ?? null)
  })
  // 预计算各因子原始值矩阵
  const rawMatrices = enabledTech.map((c) => stocks.map((s) => c.calc(s.kline)))

  // 调仓日索引
  const rebalIndices: number[] = []
  for (let i = 0; i < dates.length; i += config.rebalanceDays) rebalIndices.push(i)

  const trades: BacktestTrade[] = []
  const portfolio: number[] = [1]
  const benchmark: number[] = [1]
  let currentHoldings = new Set<number>() // 从 d 日开始生效的持仓
  let pendingHoldings = new Set<number>() // 已选但下一日生效的持仓

  for (let d = 1; d < dates.length; d++) {
    // 若 pendingHoldings 非空，当日生效（d 是某调仓日的次日）
    if (pendingHoldings.size > 0) {
      currentHoldings = pendingHoldings
      pendingHoldings = new Set()
    }

    // 计算当日组合收益（用 currentHoldings）
    let portRet: number | null = null
    if (currentHoldings.size > 0) {
      let sum = 0
      let cnt = 0
      for (const si of currentHoldings) {
        const p0 = priceAt[si][d - 1]
        const p1 = priceAt[si][d]
        if (p0 !== null && p1 !== null) {
          sum += p1 / p0 - 1
          cnt++
        }
      }
      if (cnt > 0) portRet = sum / cnt
    }
    // 基准收益：全部股票等权
    let benchRet = 0
    let bCnt = 0
    for (let si = 0; si < nStocks; si++) {
      const p0 = priceAt[si][d - 1]
      const p1 = priceAt[si][d]
      if (p0 !== null && p1 !== null) {
        benchRet += p1 / p0 - 1
        bCnt++
      }
    }
    if (bCnt > 0) benchRet /= bCnt
    const dayRet = portRet ?? benchRet

    portfolio.push(portfolio[portfolio.length - 1] * (1 + dayRet))
    benchmark.push(benchmark[benchmark.length - 1] * (1 + benchRet))

    // 判断今日是否为调仓日（T 收盘调仓，T+1 生效）
    if (rebalIndices.includes(d)) {
      const totalScores = new Map<number, number>()
      for (let fi = 0; fi < enabledTech.length; fi++) {
        const fScores = scoreAt(rawMatrices[fi], enabledTech[fi].direction, d)
        const w = weightMap.get(enabledTech[fi].key) ?? 0
        for (const [si, sc] of fScores) {
          totalScores.set(si, (totalScores.get(si) ?? 0) + sc * w)
        }
      }
      const ranked = [...totalScores.entries()].sort((a, b) => b[1] - a[1])
      const picked = ranked.slice(0, config.topN).map(([si]) => si)
      pendingHoldings = new Set(picked)
      trades.push({
        rebalanceDate: dates[d],
        codes: picked.map((si) => stocks[si].code),
        periodReturn: 0, // 占位，随后计算
        benchmarkReturn: 0,
      })
      // 记录该期从上一调仓日到 d 的收益
      const t = trades[trades.length - 1]
      const prevT = trades[trades.length - 2]
      // 简化：periodReturn 用该期起止日的组合收益近似（由后续 trade 填充逻辑替代）
      void prevT
      // 计算上一期收益：从上一调仓日次日到 d 的每日收益累积
      if (trades.length >= 2) {
        const prevRebalIdx = rebalIndices[rebalIndices.indexOf(d) - 1]
        const startEquity = portfolio[prevRebalIdx + 1] ?? 1
        const endEquity = portfolio[d]
        trades[trades.length - 2].periodReturn = (endEquity / startEquity - 1) * 100
        trades[trades.length - 2].benchmarkReturn =
          (benchmark[d] / benchmark[prevRebalIdx + 1] - 1) * 100
      }
      void t
    }
  }

  // 最后一期收益（从最后一个调仓日次日到末日）
  const lastRebal = rebalIndices[rebalIndices.length - 1]
  if (trades.length > 0 && lastRebal + 1 < dates.length) {
    const startEquity = portfolio[lastRebal + 1] ?? 1
    trades[trades.length - 1].periodReturn =
      (portfolio[dates.length - 1] / startEquity - 1) * 100
    trades[trades.length - 1].benchmarkReturn =
      (benchmark[dates.length - 1] / benchmark[lastRebal + 1] - 1) * 100
  }

  const equity = portfolio[portfolio.length - 1]
  const benchEquity = benchmark[benchmark.length - 1]
  const totalReturn = (equity - 1) * 100
  const benchTotal = (benchEquity - 1) * 100
  const years = dates.length / 252
  const annualReturn = years > 0 && equity > 0 ? (Math.pow(equity, 1 / years) - 1) * 100 : 0

  const dailyReturns = portfolio.slice(1).map((v, i) => v / portfolio[i] - 1)
  const meanDaily = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0
  const varDaily =
    dailyReturns.length > 1
      ? dailyReturns.reduce((a, b) => a + (b - meanDaily) ** 2, 0) / (dailyReturns.length - 1)
      : 0
  const stdDaily = Math.sqrt(varDaily)
  const sharpe = stdDaily > 0 ? ((meanDaily - 0.02 / 252) / stdDaily) * Math.sqrt(252) : 0

  let peak = 1
  let maxDD = 0
  for (const v of portfolio) {
    if (v > peak) peak = v
    const dd = (peak - v) / peak
    if (dd > maxDD) maxDD = dd
  }

  const winCount = trades.filter((t) => t.periodReturn > t.benchmarkReturn).length
  const winRate = trades.length > 0 ? (winCount / trades.length) * 100 : 0

  return {
    dates,
    portfolio,
    benchmark,
    trades,
    totalReturn,
    annualReturn,
    sharpe,
    maxDrawdown: maxDD * 100,
    winRate,
    excessReturn: totalReturn - benchTotal,
  }
}
