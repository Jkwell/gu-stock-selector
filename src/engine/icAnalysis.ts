import type { Kline } from '../types'
import { buildTechnicalCalculators } from './rawFactors'
import { pearsonCorr, spearmanRankCorr } from './correlation'

/**
 * 因子 IC/IR 分析引擎
 * IC（信息系数）：因子值与未来 N 日收益的 Spearman 秩相关
 * IR（信息比率）：IC 均值 / IC 标准差，衡量因子有效性稳定性
 * 仅覆盖技术因子（时变、可由 K 线直接计算）。
 */

/** 单只股票的时间序列 */
export interface StockSeries {
  code: string
  name?: string
  kline: Kline[] // 日期升序
}

/** 单个因子的 IC 分析结果 */
export interface FactorIC {
  key: string
  name: string
  /** 每个有效交易日的 IC 值 */
  icSeries: number[]
  /** 对应的交易日（用于绘图） */
  dates: string[]
  meanIC: number
  stdIC: number
  ir: number // IC 均值 / 标准差
  tStat: number // mean / (std / sqrt(n))
  winRate: number // IC > 0 的占比
}

/** Spearman 秩相关系数（-1~1），处理并列取平均秩 */
export { spearmanRankCorr } from './correlation'

/**
 * 计算各技术因子的 IC 序列与统计量
 * @param stocks 多只股票的历史 K 线
 * @param forwardDays 未来收益天数（默认 5）
 * @param minStocks 每个截面日至少需要的有效股票数
 */
export function computeFactorICs(
  stocks: StockSeries[],
  forwardDays = 5,
  minStocks = 10,
): FactorIC[] {
  const calcs = buildTechnicalCalculators()
  const nStocks = stocks.length

  // 对齐日期：以第一只股票的日期轴为基准（所有股票应同频率）
  const dateAxis = stocks[0]?.kline.map((k) => k.date) ?? []
  const nDays = dateAxis.length

  // 预计算每只股票每个因子的原始值矩阵
  // rawByFactor[factorIdx][stockIdx] = (number|null)[]
  const rawByFactor = calcs.map((c) =>
    stocks.map((s) => c.calc(s.kline)),
  )

  // 未来收益矩阵
  // fwdReturn[stockIdx][i] = close[i+forwardDays]/close[i] - 1
  const fwdReturn = stocks.map((s) => {
    const close = s.kline.map((k) => k.close)
    return close.map((c, i) =>
      i + forwardDays < close.length ? close[i + forwardDays] / c - 1 : null,
    )
  })

  const results: FactorIC[] = calcs.map((c, fi) => {
    const icSeries: number[] = []
    const dates: string[] = []
    for (let d = 0; d < nDays; d++) {
      const xs: number[] = []
      const ys: number[] = []
      for (let si = 0; si < nStocks; si++) {
        const x = rawByFactor[fi][si][d]
        const y = fwdReturn[si][d]
        if (x !== null && x !== undefined && y !== null && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
          xs.push(x)
          ys.push(y)
        }
      }
      if (xs.length >= minStocks) {
        icSeries.push(spearmanRankCorr(xs, ys))
        dates.push(dateAxis[d])
      }
    }

    const n = icSeries.length
    if (n === 0) {
      return {
        key: c.key,
        name: c.name,
        icSeries: [],
        dates: [],
        meanIC: 0,
        stdIC: 0,
        ir: 0,
        tStat: 0,
        winRate: 0,
      }
    }
    const meanIC = icSeries.reduce((a, b) => a + b, 0) / n
    const variance = icSeries.reduce((a, b) => a + (b - meanIC) ** 2, 0) / (n - 1)
    const stdIC = Math.sqrt(variance)
    return {
      key: c.key,
      name: c.name,
      icSeries,
      dates,
      meanIC,
      stdIC,
      ir: stdIC > 0 ? meanIC / stdIC : 0,
      tStat: stdIC > 0 ? (meanIC / stdIC) * Math.sqrt(n) : 0,
      winRate: icSeries.filter((v) => v > 0).length / n,
    }
  })

  return results
}

/** 因子 IC 序列之间的相关性矩阵（用于判断因子冗余） */
export function computeFactorCorrelation(
  factors: FactorIC[],
): Array<{ a: string; b: string; corr: number }> {
  const out: Array<{ a: string; b: string; corr: number }> = []
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      const n = Math.min(factors[i].icSeries.length, factors[j].icSeries.length)
      if (n < 5) continue
      const xs = factors[i].icSeries.slice(-n)
      const ys = factors[j].icSeries.slice(-n)
      out.push({ a: factors[i].key, b: factors[j].key, corr: pearsonCorr(xs, ys) })
    }
  }
  return out
}
