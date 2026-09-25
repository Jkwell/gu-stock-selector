/**
 * 短线强势因子验证
 * 运行：npx tsx scripts/verify-strong.ts
 * 验证 short_momentum（3日爆发力）与 breakout（创新高）能正确识别强势股
 */
import { scoreStocks, type ScoringInput } from '../src/engine/factors'
import type { Kline } from '../src/types'

/** 生成一段 K 线：前 60 根横盘，最后 3 根按给定涨跌幅 */
function makeKline(closeSeries: number[]): Kline[] {
  return closeSeries.map((c, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: c * 0.99,
    close: c,
    high: c * 1.02,
    low: c * 0.98,
    volume: 10000,
    amount: 0,
  }))
}

const strongFactors = [
  { key: 'short_momentum', name: '3日爆发力', group: 'technical', weight: 1, enabled: true },
  { key: 'breakout', name: '创新高', group: 'technical', weight: 1, enabled: true },
] as const

function scoreOne(name: string, closes: number[]): { short_momentum: number; breakout: number } {
  const input: ScoringInput = { info: { code: name, name, market: 'sh' }, kline: makeKline(closes) }
  const res = scoreStocks([input], [...strongFactors])
  const s = res[0]
  const get = (k: string) => s.factorScores.find((f) => f.key === k)?.score ?? -1
  return { short_momentum: get('short_momentum'), breakout: get('breakout') }
}

async function main() {
  console.log('=== 短线强势因子验证 ===\n')

  // 强势股：前 67 根横盘 10 元，最后 3 天连涨 15%（3日爆发力强 + 创新高）
  const strongCloses = [
    ...Array(67).fill(10),
    10.5, 11, 11.5, // 3日涨 15%
  ]
  const strong = scoreOne('强势股', strongCloses)
  console.log('强势股（横盘后3日涨15%创新高）:')
  console.log(`  3日爆发力 = ${strong.short_momentum}（期望 ≥ 90）`)
  console.log(`  创新高 = ${strong.breakout}（期望 ≥ 85）`)

  // 弱势股：持续阴跌
  const weakCloses = [
    ...Array(67).fill(10),
    9.5, 9.2, 9.0, // 3日跌 10%
  ]
  const weak = scoreOne('弱势股', weakCloses)
  console.log('\n弱势股（持续阴跌）:')
  console.log(`  3日爆发力 = ${weak.short_momentum}（期望 ≤ 30）`)
  console.log(`  创新高 = ${weak.breakout}（期望 ≤ 30）`)

  // 横盘股：不涨不跌
  const flat = scoreOne('横盘股', Array(70).fill(10))
  console.log('\n横盘股（不涨不跌）:')
  console.log(`  3日爆发力 = ${flat.short_momentum}（期望约 50）`)
  console.log(`  创新高 = ${flat.breakout}（期望约 70，因现价略低于前高）`)

  // 断言
  const asserts: Array<[string, boolean]> = [
    ['强势股 3日爆发力 ≥ 90', strong.short_momentum >= 90],
    ['强势股 创新高 ≥ 85', strong.breakout >= 85],
    ['弱势股 3日爆发力 ≤ 30', weak.short_momentum <= 30],
    ['弱势股 创新高 ≤ 30', weak.breakout <= 30],
    ['强势股得分 > 弱势股', strong.short_momentum > weak.short_momentum],
  ]
  console.log('\n=== 断言 ===')
  let pass = true
  for (const [name, ok] of asserts) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`)
    if (!ok) pass = false
  }
  console.log(pass ? '\n✅ 短线强势因子验证通过' : '\n❌ 验证失败')
  if (!pass) process.exit(1)
}

main().catch((e) => {
  console.error('验证失败:', e)
  process.exit(1)
})
