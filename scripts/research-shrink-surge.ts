import { readFileSync } from 'node:fs'
import { calcShrinkSurgeScore } from '../src/engine/shrink-surge-factor'
import { runOptimizedBacktest } from '../src/engine/backtest-optimized'
import type { Kline } from '../src/types'

const CACHE = 'C:/Users/lenovo/AppData/Local/Temp/bt-cache.json'
type Stock = { code: string; name: string; kline: Kline[] }

const raw = JSON.parse(readFileSync(CACHE, 'utf8')) as { stocks: Stock[] }
const stocks = raw.stocks.map((s) => ({ ...s, kline: [...s.kline].sort((a, b) => a.date.localeCompare(b.date)) }))

const scoredStocks = stocks

const combos = [
  [5, 5, 8, 15, 55], [5, 6, 8, 15, 55], [5, 7, 8, 15, 55],
  [5, 6, 8, 20, 55], [5, 6, 8, 25, 55], [5, 6, 8, 15, 60],
  [5, 6, 8, 15, 65], [5, 6, 8, 15, 70], [8, 6, 8, 15, 55],
  [10, 6, 8, 15, 55], [5, 6, 10, 15, 55],
] as const

function run(lookbackDays: number, c: typeof combos[number]) {
  const [topN, holdDays, stopLossPct, takeProfitPct, minScore] = c
  return runOptimizedBacktest(scoredStocks, {
    topN, holdDays, lookbackDays, minScore, stopLossPct, takeProfitPct,
    enableMineDetection: true, costRate: 0.0015,
  })
}

console.log('lookback | topN hold stop tp min | return win dd trades')
console.log('stocks', stocks.length)
for (const c of combos) {
  const full = run(500, c)
  const recent = run(250, c)
  console.log(`500 | ${c.join(' ')} | ${full.totalReturn} ${full.winRate} ${full.maxDrawdown} ${full.tradeCount}`)
  console.log(`250 | ${c.join(' ')} | ${recent.totalReturn} ${recent.winRate} ${recent.maxDrawdown} ${recent.tradeCount}`)
}
