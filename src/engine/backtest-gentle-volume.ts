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
 * 获取某只股票在某日的价格
 */
function priceAtDay(kline: Kline[], dayIdx: number): number | null {
  if (dayIdx < 0 || dayIdx >= kline.length) return null
  return kline[dayIdx].close
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

  // 找最短 K 线长度（确保所有股票有足够数据）
  const minLen = Math.min(...candidates.map((c) => c.kline.length))
  const totalDays = Math.min(lookbackDays, minLen)
  if (totalDays < 70 + holdDays) {
    return { startDate: '', endDate: '', totalReturn: 0, avgReturn: 0, winRate: 0, maxReturn: 0, minReturn: 0, tradeCount: 0, trades: [] }
  }

  const trades: BacktestTrade[] = []
  // 从第 70 天开始（确保有足够 K 线算分），每隔 holdDays 天调仓
  let equity = 1
  for (let day = 70; day < totalDays - holdDays; day += holdDays) {
    // 对所有候选票打分
    const scored = candidates
      .map((c) => {
        const score = scoreAtDay(c.kline, day)
        return { ...c, score }
      })
      .filter((s) => s.score >= 40) // 最低入选线
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)

    if (scored.length === 0) continue

    // 等权持有 holdDays 天
    const entryDate = candidates[0].kline[day]?.date ?? ''
    const exitDayIdx = Math.min(day + holdDays, totalDays - 1)
    const exitDate = candidates[0].kline[exitDayIdx]?.date ?? ''

    for (const s of scored) {
      const entryPrice = priceAtDay(s.kline, day)
      const exitPrice = priceAtDay(s.kline, exitDayIdx)
      if (entryPrice === null || exitPrice === null || entryPrice <= 0) continue
      const returnPct = ((exitPrice / entryPrice) - 1) * 100
      equity *= (1 + returnPct / 100)
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
