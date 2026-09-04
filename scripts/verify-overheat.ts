/**
 * 追高修复验证：动量过热钳制 + 高位降分
 * 运行：npx tsx scripts/verify-overheat.ts
 */
import { scoreStocks } from '../src/engine/factors'
import type { Kline } from '../src/types'

const mk = (closes: number[]): Kline[] =>
  closes.map((c, i) => ({
    date: `d${i}`,
    open: c,
    close: c,
    high: c * 1.01,
    low: c * 0.99,
    volume: 10000,
    amount: 0,
  }))

const momentum1m = [{ key: 'momentum_1m', name: '动量1月', group: 'technical', weight: 1, enabled: true }] as const
const shortMomentum = [{ key: 'short_momentum', name: '3日爆发力', group: 'technical', weight: 1, enabled: true }] as const
const trendOnly = [{ key: 'trend', name: '趋势', group: 'technical', weight: 1, enabled: true }] as const

function oneScore(factors: readonly { key: string; weight: number; enabled: boolean }[], closes: number[]) {
  const r = scoreStocks([{ info: { code: 'T', name: 'T', market: 'sh' }, kline: mk(closes) }], [...factors])
  return r[0]
}

console.log('=== 1. 动量过热钳制 ===')
// 温和强势：20日涨 10%
const mild = oneScore(momentum1m, [...Array(49).fill(10), ...Array.from({ length: 21 }, (_, i) => 10 * (1 + 0.1 * (i / 20)))])
// 妖股：20日涨 60%
const hot = oneScore(momentum1m, [...Array(49).fill(10), ...Array.from({ length: 21 }, (_, i) => 10 * (1 + 0.6 * (i / 20)))])
console.log(`  20日+10%（温和强势）= ${mild.factorScores[0]?.score}（应 ≥75）`)
console.log(`  20日+60%（妖股）= ${hot.factorScores[0]?.score}（应 ≤60，被过热钳制）`)

// 短线：3日涨 12% vs 3日涨 60%
const shortMild = oneScore(shortMomentum, [...Array(67).fill(10), 10, 10.6, 11.2])
const shortHot = oneScore(shortMomentum, [...Array(67).fill(10), 10, 12.5, 16])
console.log(`  3日+12%（温和启动）= ${shortMild.factorScores[0]?.score}（应 ≥70）`)
console.log(`  3日+60%（短线妖股）= ${shortHot.factorScores[0]?.score}（应 ≤60）`)

console.log('\n=== 2. 高位降分（通用风控 7 折） ===')
const fiveBoard = [...Array(65).fill(10), 11, 12.1, 13.31, 14.64, 16.1]
const normalBoard = [...Array(67).fill(10), 11, 12.1, 13.31]
const r5 = oneScore(trendOnly, fiveBoard)
const rN = oneScore(trendOnly, normalBoard)
console.log(`  仅 trend 因子：5连板 highRisk=${r5.highRisk} 总分=${r5.totalScore}；3连板 highRisk=${rN.highRisk} 总分=${rN.totalScore}`)
console.log(`  5连板总分/3连板总分 = ${(r5.totalScore / rN.totalScore).toFixed(2)}（应 ≤0.75，高位被降分）`)

const asserts: Array<[string, boolean]> = [
  ['温和强势动量不被误伤（≥75）', (mild.factorScores[0]?.score ?? 0) >= 75],
  ['妖股动量被过热钳制（≤60）', (hot.factorScores[0]?.score ?? 100) <= 60],
  ['温和短线启动分高（≥70）', (shortMild.factorScores[0]?.score ?? 0) >= 70],
  ['短线妖股被钳制（≤60）', (shortHot.factorScores[0]?.score ?? 100) <= 60],
  ['5连板触发高位风控', r5.highRisk === true],
  ['3连板不误报', rN.highRisk === false],
  ['高位票总分被打 7 折（≤75%）', r5.highRisk && rN.totalScore > 0 && r5.totalScore / rN.totalScore <= 0.75],
]

console.log('\n=== 断言 ===')
let pass = true
for (const [name, ok] of asserts) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (!ok) pass = false
}
console.log(pass ? '\n✅ 追高修复验证通过' : '\n❌ 验证失败')
if (!pass) process.exit(1)
