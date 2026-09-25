import type { FactorDef, Kline } from '../types'
import { buildTechnicalCalculators } from './rawFactors'
import { calcVolumeRatio, isUptrend } from './quickRules'

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
  /** 交易成本率（买卖双向合计，默认 0.0015 = 万2.5佣金 + 千1印花税 + 万2.5滑点） */
  costRate?: number
  /** 温和放量模式：模拟实盘打分制的硬性趋势/量能要求（仅选上升趋势 + 量比≥0.8 的票） */
  gentleVolume?: boolean
}

export interface BacktestTrade {
  rebalanceDate: string
  codes: string[] // 本期持仓代码
  names: string[] // 本期持仓名称（与 codes 对应）
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
  costRate: number // 实际使用的交易成本率
  excludedCount: number // 因涨停买不进被过滤的票数
  sampleDays: number // 回测覆盖的交易日数量
  usedFactorKeys: string[]
  omittedFactorKeys: string[]
  firstHalfReturn: number
  secondHalfReturn: number
  secondHalfExcessReturn: number
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
function emptyResult(
  dates: string[],
  usedFactorKeys: string[] = [],
  omittedFactorKeys: string[] = [],
): BacktestResult {
  return {
    dates, portfolio: [], benchmark: [], trades: [],
    totalReturn: 0, annualReturn: 0, sharpe: 0, maxDrawdown: 0, winRate: 0, excessReturn: 0,
    costRate: 0, excludedCount: 0, sampleDays: dates.length,
    usedFactorKeys, omittedFactorKeys,
    firstHalfReturn: 0, secondHalfReturn: 0, secondHalfExcessReturn: 0,
  }
}

/** 运行回测 */
export function runBacktest(
  stocks: Array<{ code: string; name?: string; kline: Kline[] }>,
  config: BacktestConfig,
): BacktestResult {
  const costRate = config.costRate ?? 0.0015
  const calcs = buildTechnicalCalculators()
  const enabledTech = calcs.filter((c) =>
    config.factors.some((f) => f.enabled && f.key === c.key),
  )
  const enabledKeys = config.factors.filter((f) => f.enabled).map((f) => f.key)
  const usedFactorKeys = enabledTech.map((c) => c.key)
  const omittedFactorKeys = enabledKeys.filter((key) => !usedFactorKeys.includes(key))
  if (enabledTech.length === 0 || stocks.length === 0) {
    return emptyResult([], usedFactorKeys, omittedFactorKeys)
  }

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
  if (dates.length === 0) return emptyResult(dates, usedFactorKeys, omittedFactorKeys)

  const nStocks = stocks.length
  const priceAt = stocks.map((s) => {
    const byDate = new Map(s.kline.map((k) => [k.date, k.close]))
    return dates.map((d) => byDate.get(d) ?? null)
  })
  const openAt = stocks.map((s) => {
    const byDate = new Map(s.kline.map((k) => [k.date, k.open]))
    return dates.map((d) => byDate.get(d) ?? null)
  })
  // 每日最高价（用于涨停判断：收盘贴涨停价 + 涨幅 ≥ 9.8% ≈ 买不进）
  const highAt = stocks.map((s) => {
    const byDate = new Map(s.kline.map((k) => [k.date, k.high]))
    return dates.map((d) => byDate.get(d) ?? null)
  })
  // 预计算各因子原始值矩阵，并按统一日期轴重排，避免不同股票上市日不同导致错位。
  const rawMatrices = enabledTech.map((c) =>
    stocks.map((s) => {
      const raw = c.calc(s.kline)
      const byDate = new Map(s.kline.map((k, i) => [k.date, raw[i] ?? null]))
      return dates.map((d) => byDate.get(d) ?? null)
    }),
  )

  // 调仓日索引
  const rebalIndices: number[] = []
  for (let i = 0; i < dates.length; i += config.rebalanceDays) rebalIndices.push(i)

  const trades: BacktestTrade[] = []
  const portfolio: number[] = [1]
  const benchmark: number[] = [1]
  let currentHoldings = new Set<number>() // 当前已生效持仓
  let pendingHoldings: Set<number> | null = null // 已选但下一日生效的持仓
  let excludedCount = 0 // 因涨停买不进被过滤的票数
  let lastTradeRebalIndex: number | null = null

  const rebalanceAt = (d: number) => {
    const totalScores = new Map<number, number>()
    for (let fi = 0; fi < enabledTech.length; fi++) {
      const fScores = scoreAt(rawMatrices[fi], enabledTech[fi].direction, d)
      const w = weightMap.get(enabledTech[fi].key) ?? 0
      for (const [si, sc] of fScores) {
        totalScores.set(si, (totalScores.get(si) ?? 0) + sc * w)
      }
    }
    const ranked = [...totalScores.entries()].sort((a, b) => b[1] - a[1])
    // 指标尚未积累足够历史数据时，不生成空调仓记录，也不强制平仓。
    if (ranked.length === 0) return
    // 涨停过滤：当日涨停且收盘贴近最高价，下一交易日通常无法按计划买入。
    const buyable = ranked.filter(([si]) => {
      const prev = priceAt[si][d - 1]
      const cur = priceAt[si][d]
      const hi = highAt[si][d]
      if (cur === null || cur <= 0) return false
      if (prev === null || prev <= 0 || hi === null) return d === 0
      const chg = cur / prev - 1
      return !(chg >= 0.098 && cur >= hi * 0.995)
    })
    // 温和放量模式：模拟实盘打分制的趋势/量能硬性要求
    let gentleFiltered = buyable
    if (config.gentleVolume) {
      gentleFiltered = buyable.filter(([si]) => {
        // 取调仓日为止的 K 线切片（需足够长度判断趋势）
        const idx = d
        const ks = stocks[si].kline.filter((k) => k.date <= dates[idx])
        if (ks.length < 70) return false
        if (!isUptrend(ks)) return false
        const ratio = calcVolumeRatio(ks)
        return ratio !== null && ratio >= 0.8
      })
    }
    excludedCount += ranked.length - gentleFiltered.length
    const picked = gentleFiltered.slice(0, config.topN).map(([si]) => si)
    const nextHoldings = new Set(picked)

    // costRate 是买卖双向合计成本；仅新增仓位时按半个往返成本计。
    const changed = [...currentHoldings].filter((si) => !nextHoldings.has(si)).length
      + picked.filter((si) => !currentHoldings.has(si)).length
    const turnover = currentHoldings.size === 0
      ? (nextHoldings.size > 0 ? 0.5 : 0)
      : changed / Math.max(config.topN * 2, 1)
    portfolio[portfolio.length - 1] *= Math.max(0, 1 - costRate * turnover)

    pendingHoldings = nextHoldings
    trades.push({
      rebalanceDate: dates[d],
      codes: picked.map((si) => stocks[si].code),
      names: picked.map((si) => stocks[si].name || stocks[si].code),
      periodReturn: 0,
      benchmarkReturn: 0,
    })

    // 记录上一期从上次调仓后第一个生效日到本次调仓日的收益。
    if (lastTradeRebalIndex !== null) {
      const prevRebalIdx = lastTradeRebalIndex
      const startEquity = portfolio[prevRebalIdx + 1] ?? 1
      const endEquity = portfolio[d]
      trades[trades.length - 2].periodReturn = (endEquity / startEquity - 1) * 100
      trades[trades.length - 2].benchmarkReturn =
        (benchmark[d] / benchmark[prevRebalIdx + 1] - 1) * 100
    }
    lastTradeRebalIndex = d
  }

  // 第一个交易日收盘选股，下一交易日开盘建仓，避免前 N 天无持仓造成偏差。
  rebalanceAt(rebalIndices[0])

  for (let d = 1; d < dates.length; d++) {
    let activatedToday = new Set<number>()
    // 若 pendingHoldings 非空，当日生效（d 是某调仓日的次日）
    if (pendingHoldings !== null) {
      // 只有新增仓位按开盘价成交；继续持有的仓位沿用前一日收盘价。
      activatedToday = new Set(
        [...pendingHoldings].filter((si) => !currentHoldings.has(si)),
      )
      currentHoldings = pendingHoldings
      pendingHoldings = null
    }

    // 计算当日组合收益（用 currentHoldings）
    let portRet: number | null = null
    if (currentHoldings.size > 0) {
      let sum = 0
      let cnt = 0
      for (const si of currentHoldings) {
        const p0 = activatedToday.has(si) ? openAt[si][d] : priceAt[si][d - 1]
        const p1 = priceAt[si][d]
        if (p0 !== null && p0 > 0 && p1 !== null && p1 > 0) {
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

    // 判断今日是否为调仓日（T 收盘选股，T+1 开盘生效）
    if (rebalIndices.includes(d)) {
      rebalanceAt(d)
    }
  }

  // 最后一期收益（从最后一个调仓日次日到末日）
  const lastRebal = lastTradeRebalIndex
  if (trades.length > 0 && lastRebal !== null && lastRebal + 1 < dates.length) {
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

  // 将样本拆成前后两半，后半段只作为稳定性参考，不参与调参或选股。
  const splitIndex = Math.max(0, Math.floor((portfolio.length - 1) / 2))
  const splitPortfolio = portfolio[splitIndex] > 0 ? portfolio[splitIndex] : 1
  const splitBenchmark = benchmark[splitIndex] > 0 ? benchmark[splitIndex] : 1
  const firstHalfReturn = (splitPortfolio - 1) * 100
  const secondHalfReturn = (equity / splitPortfolio - 1) * 100
  const secondHalfBenchmarkReturn = (benchEquity / splitBenchmark - 1) * 100

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
    costRate,
    excludedCount,
    sampleDays: dates.length,
    usedFactorKeys,
    omittedFactorKeys,
    firstHalfReturn,
    secondHalfReturn,
    secondHalfExcessReturn: secondHalfReturn - secondHalfBenchmarkReturn,
  }
}
