/**
 * 量化规则增强验证：均线粘合突破 + 大盘择时 + 高位风险预警
 * 运行：npx tsx scripts/verify-rules.ts
 */
import { maSqueeze } from '../src/engine/breakout'
import { computeMarketTiming } from '../src/engine/marketTiming'
import { scoreStocks, type ScoringInput } from '../src/engine/factors'
import type { Kline } from '../src/types'

const mk = (closes: number[], volumes: number[]): Kline[] =>
  closes.map((c, i) => ({
    date: `d${i}`,
    open: c, close: c,
    high: c * 1.01, low: c * 0.99,
    volume: volumes[i] ?? 10000,
    amount: 0,
  }))

console.log('=== 1. 均线粘合突破 ===')
// 横盘 40 天（10元）→ 粘合，然后放量突破涨到 11
const squeezeCloses = [...Array(40).fill(10), ...Array.from({ length: 20 }, (_, i) => 10 + i * 0.05)]
const squeezeVols = [...Array(40).fill(10000), ...Array.from({ length: 19 }, () => 10000), 20000]
const s1 = maSqueeze(mk(squeezeCloses, squeezeVols))
console.log(`  粘合后突破: 粘合度=${((s1.squeeze ?? 0) * 100).toFixed(1)}% 突破=${s1.breakout} ${s1.breakout ? '✅' : '❌ 应突破'}`)

// 上升趋势（均线发散）→ 不粘合
const trendCloses = Array.from({ length: 60 }, (_, i) => 10 + i * 0.2)
const s2 = maSqueeze(mk(trendCloses, Array(60).fill(10000)))
console.log(`  均线发散: 粘合度=${((s2.squeeze ?? 0) * 100).toFixed(1)}% ${(s2.squeeze ?? 1) > 0.05 ? '✅ 发散(粘合度大)' : '❌'}`)

console.log('\n=== 2. 大盘择时 ===')
// 指数在 20 日线上方
const aboveK = mk(Array.from({ length: 30 }, (_, i) => 3000 + i * 2), [])
const t1 = computeMarketTiming(aboveK)!
console.log(`  指数上行: trend=${t1.trend} ${t1.trend === 'above' ? '✅' : '❌'}`)
// 指数在 20 日线下方
const belowK = mk(Array.from({ length: 30 }, (_, i) => 3000 - i * 3), [])
const t2 = computeMarketTiming(belowK)!
console.log(`  指数下行: trend=${t2.trend} ${t2.trend === 'below' ? '✅' : '❌'}`)

console.log('\n=== 3. 高位风险预警（limit_up 因子） ===')
const limitUpFactor = [
  { key: 'limit_up', name: '连板高度', group: 'technical', weight: 1, enabled: true },
] as const
// 5 连板：连续 5 天涨停
const base = Array(65).fill(10)
const fiveBoard = [...base, 11, 12.1, 13.31, 14.64, 16.1]
const r1 = scoreStocks([{ info: { code: '600001', name: '五连板', market: 'sh' }, kline: mk(fiveBoard, []) }], [...limitUpFactor])
const s1r = r1[0]
console.log(`  五连板: highRisk=${s1r.highRisk} ${s1r.highRisk ? '✅ 触发预警' : '❌'} 连板分=${s1r.factorScores[0]?.score}`)
// 2 连板：正常
const twoBoard = [...base, 11, 12.1]
const r2 = scoreStocks([{ info: { code: '600002', name: '两连板', market: 'sh' }, kline: mk(twoBoard, []) }], [...limitUpFactor])
console.log(`  两连板: highRisk=${r2[0].highRisk} ${r2[0].highRisk ? '❌ 不应触发' : '✅ 正常'}`)

const pass =
  s1.breakout &&
  (s2.squeeze ?? 1) > 0.05 &&
  t1.trend === 'above' &&
  t2.trend === 'below' &&
  s1r.highRisk === true &&
  r2[0].highRisk === false
console.log(pass ? '\n✅ 三项量化规则验证通过' : '\n❌ 验证失败')
if (!pass) process.exit(1)
