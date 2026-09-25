import { scoreGentleVolume } from './quickRules'
import type { Kline } from '../types'

/** 候选股票（含 K 线） */
interface KlineStock {
  code: string
  name: string
  kline: Kline[]
}

/**
 * 温和放量策略回测引擎
 * 用历史 K 线数据滚动评分，选出 Top N 持有固定天数，计算组合收益。
 */

export interface BacktestConfig {
  topN: number // 每期持仓数
  holdDays: number // 持有天数（调仓间隔）
  lookbackDays: number // 回测覆盖的交易日数量
  costRate?: number // 每期综合交易成本
}

export interface BacktestTrade {
  date: string // 调仓日
  code: string
  name: string
  score: number
  entryPrice: number
  exitPrice: number
  exitDate: string
  returnPct: number
}

export interface BacktestResult {
  startDate: string
  endDate: string
  totalReturn: number // 累计收益率 %
  avgReturn: number // 平均每笔收益 %
  winRate: number // 胜率 %
  maxReturn: number // 单笔最大收益 %
  minReturn: number // 单笔最大亏损 %
  tradeCount: number
  trades: BacktestTrade[]
}

/**
 * 计算某只股票在某日的温和放量评分
 * 用截至该日的 K 线数据
 */
function scoreAtDay(kline: Kline[], dayIdx: number): number {
  if (dayIdx < 70) return 0 // 数据不足
  const slice = kline.slice(0, dayIdx + 1)
  const score = scoreGentleVolume(slice, null, true, 5e9)
  return score.totalScore
}

/**
 * 运行温和放量回测
 * @param candidates 候选股票（含 K 线）
 * @param config 回测配置
 */
export function runGentleVolumeBacktest(
  candidates: KlineStock[],
  config: BacktestConfig,
): BacktestResult {
  const { topN, holdDays, lookbackDays } = config

  const pool = candidates
    .map((c) => ({ ...c, kline: [...c.kline].sort((a, b) => a.date.localeCompare(b.date)) }))
    .filter((c) => c.kline.length >= 70 + holdDays + 1)
  if (pool.length === 0) {
    return { startDate: '', endDate: '', totalReturn: 0, avgReturn: 0, winRate: 0, maxReturn: 0, minReturn: 0, tradeCount: 0, trades: [] }
  }

  const trades: BacktestTrade[] = []
  const dates = [...new Set(pool.flatMap((c) => c.kline.map((k) => k.date)))].sort()
  const byDate = pool.map((c) => new Map(c.kline.map((k, i) => [k.date, i])))
  const lastDay = dates.length - 1
  const startDay = Math.max(70, lastDay - lookbackDays)
  if (lastDay - startDay < holdDays + 1) return { startDate: '', endDate: '', totalReturn: 0, avgReturn: 0, winRate: 0, maxReturn: 0, minReturn: 0, tradeCount: 0, trades: [] }
  let equity = 1
  for (let day = startDay; day < lastDay - holdDays; day += holdDays) {
    // 对所有候选票打分
    const scored = pool
      .map((c, stockIdx) => {
        const idx = byDate[stockIdx].get(dates[day])
        const score = idx === undefined ? 0 : scoreAtDay(c.kline, idx)
        return { ...c, score, stockIdx }
      })
      .filter((s) => s.score >= 30) // 最低入选线
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)

    if (scored.length === 0) continue

    // 等权持有 holdDays 天
    const entryDate = dates[day + 1] ?? ''
    const exitDate = dates[Math.min(day + holdDays, lastDay)] ?? entryDate
    let periodReturn = 0
    let valid = 0

    for (const s of scored) {
      const entryIdx = byDate[s.stockIdx].get(entryDate)
      const exitIdx = byDate[s.stockIdx].get(exitDate)
      const entryPrice = entryIdx === undefined ? null : s.kline[entryIdx]?.open ?? null
      const exitPrice = exitIdx === undefined ? null : s.kline[exitIdx]?.close ?? null
      if (entryPrice === null || exitPrice === null || entryPrice <= 0) continue
      const returnPct = ((exitPrice / entryPrice) - 1) * 100
      periodReturn += returnPct
      valid++
      trades.push({
        date: entryDate,
        code: s.code,
        name: s.name,
        score: s.score,
        entryPrice,
        exitPrice,
        exitDate,
        returnPct: Number(returnPct.toFixed(2)),
      })
    }
    if (valid > 0) equity *= Math.max(0, 1 + periodReturn / valid / 100 - (config.costRate ?? 0.0015))
  }

  if (trades.length === 0) {
    return { startDate: '', endDate: '', totalReturn: 0, avgReturn: 0, winRate: 0, maxReturn: 0, minReturn: 0, tradeCount: 0, trades: [] }
  }

  const returns = trades.map((t) => t.returnPct)
  const wins = returns.filter((r) => r > 0).length
  const totalReturn = (equity - 1) * 100

  return {
    startDate: trades[0]?.date ?? '',
    endDate: trades[trades.length - 1]?.exitDate ?? '',
    totalReturn: Number(totalReturn.toFixed(2)),
    avgReturn: Number((returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2)),
    winRate: Number(((wins / returns.length) * 100).toFixed(1)),
    maxReturn: Math.max(...returns),
    minReturn: Math.min(...returns),
    tradeCount: trades.length,
    trades: trades.slice(-20), // 只保留最近20笔
  }
}
