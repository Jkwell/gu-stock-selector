import { scoreStocks, type ScoringInput } from '../src/engine/factors'
import type { Kline } from '../src/types'

function mkCloses(closes: number[]): Kline[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: c, close: c, high: c * 1.01, low: c * 0.99, volume: 10000, amount: 0,
  }))
}

const factors = [
  { key: 'limit_up', name: '连板高度', group: 'technical', weight: 1, enabled: true },
] as const

function score(name: string, code: string, closes: number[]) {
  const input: ScoringInput = { info: { code, name, market: 'sh' }, kline: mkCloses(closes) }
  const r = scoreStocks([input], [...factors])
  const s = r[0].factorScores[0]
  return { score: s?.score, detail: s?.detail }
}

const base = Array(69).fill(10)
console.log('三连板(主板10%):', score('三连板', '600001', [...base, 11, 12.1, 13.31]))
console.log('二连板(主板10%):', score('二连板', '600002', [...base, 11, 12.1]))
console.log('首板(主板10%):', score('首板', '600003', [...base, 11]))
console.log('非涨停(涨4.8%):', score('非涨停', '600004', [...base, 10.48]))
console.log('横盘(0板):', score('横盘', '600005', Array(70).fill(10)))
console.log('创业板二连板(20%):', score('创二连板', '300001', [...base, 12, 14.4]))
