/**
 * 策略优化验证：回测成本+涨停过滤 & IC 驱动权重优化
 * 运行：npx tsx scripts/verify-opt.ts
 */
import { runBacktest, type BacktestConfig } from '../src/engine/backtest'
import type { Kline } from '../src/types'
import { DEFAULT_FACTORS } from '../src/config/factors'
import {
  optimizeWeightsFromIC,
} from '../src/engine/weightOptimizer'
import type { FactorIC } from '../src/engine/icAnalysis'
import { selectCandidatePool } from '../src/data/pipeline'
import type { StockInfo } from '../src/types'

let pass = true
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) pass = false
}

/** 构造 N 只股票的同步 K 线（日期升序，价格 10 起步） */
function makeStocks(n: number, days = 60): Array<{ code: string; name: string; kline: Kline[] }> {
  const dates: string[] = []
  const start = new Date(2026, 4, 1)
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    dates.push(d.toISOString().slice(0, 10))
  }
  const stocks = []
  for (let s = 0; s < n; s++) {
    const kline: Kline[] = dates.map((date, i) => {
      const close = 10 + s * 0.1 + i * 0.05 // 每只股稳定上涨
      return {
        date,
        open: close - 0.1,
        close,
        high: close + 0.1,
        low: close - 0.2,
        volume: 10000,
        amount: close * 10000 * 100,
      }
    })
    stocks.push({ code: `60000${s}`, name: `测试${s}`, kline })
  }
  return stocks
}

console.log('=== 1. 回测：交易成本扣除 ===')
{
  const stocks = makeStocks(30, 60)
  const factors = DEFAULT_FACTORS
  const base: BacktestConfig = {
    startDate: '0000-01-01', endDate: '2050-01-01',
    topN: 5, rebalanceDays: 10, factors,
  }
  const r0 = runBacktest(stocks, base)
  const rCost = runBacktest(stocks, { ...base, costRate: 0.01 }) // 1% 高成本便于验证
  check('默认成本率为 0.15%', r0.costRate === 0.0015)
  check('自定义成本率生效', rCost.costRate === 0.01)
  check(
    '成本越高累计收益越低',
    rCost.totalReturn < r0.totalReturn,
    `0%成本=${r0.totalReturn.toFixed(2)}% vs 1%成本=${rCost.totalReturn.toFixed(2)}%`,
  )
  check('回测记录实际使用的技术因子', r0.usedFactorKeys.length > 0)
  check('回测标记未时点化的基本面/资金因子',
    r0.omittedFactorKeys.includes('valuation') && r0.omittedFactorKeys.includes('moneyflow'))
  check('回测提供前后半段稳定性指标',
    Number.isFinite(r0.firstHalfReturn) && Number.isFinite(r0.secondHalfReturn) &&
      Number.isFinite(r0.secondHalfExcessReturn))
}

console.log('=== 2. 回测：涨停票被过滤 ===')
{
  // 构造 30 只票，其中 code 600003 在一个调仓日涨停（涨幅 10% + 收盘=最高）
  const stocks = makeStocks(30, 60)
  const rebalIdx = 50 // 调仓日（rebalanceDays=10 → 0,10,20,30,40,50）
  const prev = stocks[3].kline[rebalIdx - 1].close
  stocks[3].kline[rebalIdx] = {
    ...stocks[3].kline[rebalIdx],
    close: prev * 1.1,
    high: prev * 1.1,
    open: prev * 1.05,
    low: prev * 0.95,
  }
  const factors = DEFAULT_FACTORS.filter((f) => f.enabled && f.group === 'technical')
  const r = runBacktest(stocks, {
    startDate: '0000-01-01', endDate: '2050-01-01',
    topN: 10, rebalanceDays: 10, factors, costRate: 0.0015,
  })
  check('存在被过滤的涨停票', r.excludedCount > 0, `排除 ${r.excludedCount} 只`)
}

console.log('=== 3. IC → 权重优化：正 IC 加权 / 负 IC 禁用 / 不稳定限权 ===')
{
  // 构造 4 个技术因子的 IC 结果
  const mkIC = (key: string, name: string, meanIC: number, tStat: number): FactorIC => ({
    key, name, icSeries: [meanIC], dates: ['2026-01-01'], // icSeries 非空才被视为"有 IC 数据"
    meanIC, stdIC: Math.abs(meanIC) / Math.max(Math.abs(tStat), 0.01), ir: 0, tStat, winRate: 0.5,
  })
  const icResults: FactorIC[] = [
    mkIC('trend', '趋势强度', 0.05, 3.0),        // 强正 IC → 高权重
    mkIC('macd', 'MACD 动量', 0.03, 2.0),        // 中等正 IC → 中等权重
    mkIC('reversal', '短期反转', -0.04, -2.5),   // 显著负 IC → 禁用
    mkIC('volatility', '低波动', 0.01, 0.5),     // 不稳定 → 权重上限 5%
  ]
  const factorDefs = DEFAULT_FACTORS.filter((f) => ['trend', 'macd', 'reversal', 'volatility'].includes(f.key))
  const { factors, suggestions } = optimizeWeightsFromIC(icResults, factorDefs)

  const trend = factors.find((f) => f.key === 'trend')!
  const macd = factors.find((f) => f.key === 'macd')!
  const reversal = factors.find((f) => f.key === 'reversal')!
  const volatility = factors.find((f) => f.key === 'volatility')!

  check('强正 IC 因子权重最高', trend.weight > macd.weight,
    `trend=${(trend.weight * 100).toFixed(0)}% > macd=${(macd.weight * 100).toFixed(0)}%`)
  check('显著负 IC 因子被禁用', !reversal.enabled && reversal.weight === 0)
  check('不稳定因子权重上限 5%', volatility.weight <= 0.05,
    `volatility=${(volatility.weight * 100).toFixed(0)}%`)
  check('技术因子权重总和=1', (trend.weight + macd.weight + volatility.weight).toFixed(4) === '1.0000')
  check('建议明细含优化理由', suggestions.every((s) => s.note.length > 0))
}

console.log('=== 4. 多源候选池：配额、去重与单一排序 ===')
{
  const stocks: StockInfo[] = Array.from({ length: 20 }, (_, i) => ({
    code: `600${String(i).padStart(3, '0')}`,
    name: `Stock ${i}`,
    market: 'sh',
    changePct: i < 7 ? 100 - i : 0,
    turnoverRate: i >= 7 && i < 12 ? 100 - i : 0,
    floatMv: i >= 12 && i < 17 ? (100 - i) * 1e8 : 0,
    totalMv: i >= 17 ? (100 - i) * 1e8 : 0,
  }))
  const config = { candidatePool: 'momentum' as const, candidateCount: 10 }
  const mixed = selectCandidatePool(stocks, config, true)
  const single = selectCandidatePool(stocks, config, false)
  check('混合候选池不超过配置数量', mixed.length === config.candidateCount)
  check('混合候选池股票不重复', new Set(mixed.map((s) => s.code)).size === mixed.length)
  check('主排序保留约 70% 名额', mixed.slice(0, 7).every((s) => (s.changePct ?? 0) > 0))
  check('其他排序能补充不同股票', mixed.some((s) => (s.turnoverRate ?? 0) > 0))
  check('关闭混合时保持单一主排序',
    single.length === config.candidateCount &&
      single.slice(0, 7).every((s) => (s.changePct ?? 0) > 0) &&
      single.every((s, i) => i === 0 || (s.changePct ?? 0) <= (single[i - 1].changePct ?? 0)))
}

console.log('\n' + (pass ? '✅ 全部通过' : '❌ 有失败项'))
process.exit(pass ? 0 : 1)
