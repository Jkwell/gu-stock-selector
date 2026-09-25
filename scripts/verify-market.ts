/**
 * 情绪引擎 + 板块引擎 + 一字板 验证
 * 运行：npx tsx scripts/verify-market.ts
 */
import { computeMarketSentiment } from '../src/engine/marketSentiment'
import { computeSectorHeat } from '../src/engine/sectorHeat'
import { isOneWordLimitUp } from '../src/engine/tradingSignals'
import type { Kline, StockInfo } from '../src/types'

const mk = (code: string, name: string, industry: string, changePct: number): StockInfo => ({
  code, name, market: code.startsWith('6') ? 'sh' : 'sz', industry, changePct,
})

console.log('=== 1. 情绪引擎 ===')
// 火热市：100 只里 60 涨 20 跌 10 涨停
const hot = [
  ...Array.from({ length: 60 }, (_, i) => mk(`6000${i}`, `涨${i}`, 'A', 1 + (i % 5))),
  ...Array.from({ length: 20 }, (_, i) => mk(`0000${i}`, `跌${i}`, 'B', -1 - (i % 3))),
  ...Array.from({ length: 10 }, (_, i) => mk(`6001${i}`, `板${i}`, 'C', 10)),
  ...Array.from({ length: 10 }, (_, i) => mk(`0001${i}`, `平${i}`, 'D', 0)),
]
const sHot = computeMarketSentiment(hot)
console.log(`  火热市: 温度=${sHot.temperature} 涨停=${sHot.limitUpCount} 涨跌=${sHot.upCount}/${sHot.downCount} level=${sHot.level}`)

// 冰点市：普跌，无涨停
const cold = [
  ...Array.from({ length: 20 }, (_, i) => mk(`6000${i}`, `涨${i}`, 'A', 0.5)),
  ...Array.from({ length: 80 }, (_, i) => mk(`0000${i}`, `跌${i}`, 'B', -2 - (i % 4))),
]
const sCold = computeMarketSentiment(cold)
console.log(`  冰点市: 温度=${sCold.temperature} 涨停=${sCold.limitUpCount} 涨跌=${sCold.upCount}/${sCold.downCount} level=${sCold.level}`)

console.log('\n=== 2. 板块热点引擎 ===')
const sectors = [
  ...['半导体', '半导体', '半导体', '半导体', '半导体'].map((s, i) =>
    mk(`6000${i}`, `半导${i}`, s, [6, 9.9, 10, 5, 3][i]),
  ),
  ...['白酒', '白酒', '白酒'].map((s, i) => mk(`0000${i}`, `白酒${i}`, s, [2, -1, 0][i])),
]
const heat = computeSectorHeat(sectors, 5)
heat.forEach((h, i) =>
  console.log(`  #${i + 1} ${h.sector} 平均=${h.avgChangePct}% 涨停=${h.limitUpCount} 领涨=${h.leaders.join(',')}`),
)

console.log('\n=== 3. 一字板判断 ===')
const oneWordKline: Kline[] = [
  { date: 'd1', open: 10, close: 10, high: 10, low: 10, volume: 100, amount: 0 },
  { date: 'd2', open: 11, close: 11, high: 11, low: 11, volume: 100, amount: 0 }, // 一字涨停
]
console.log(`  一字涨停(11/10=+10% open=close=high=low): ${isOneWordLimitUp(oneWordKline, 0.1) ? '✅ 判定一字板' : '❌'}`)

const normalKline: Kline[] = [
  { date: 'd1', open: 10, close: 10, high: 10, low: 10, volume: 100, amount: 0 },
  { date: 'd2', open: 10.5, close: 11, high: 11.2, low: 10.4, volume: 100, amount: 0 }, // 正常大涨
]
console.log(`  正常大涨(+10% 有波动): ${!isOneWordLimitUp(normalKline, 0.1) ? '✅ 判定非一字板' : '❌'}`)

// 断言
const asserts: Array<[string, boolean]> = [
  ['火热市温度 ≥ 70', sHot.temperature >= 70],
  ['冰点市温度 < 40', sCold.temperature < 40],
  ['冰点市 level = cold', sCold.level === 'cold'],
  ['半导体板块排第一', heat[0]?.sector === '半导体'],
  ['一字板正确识别', isOneWordLimitUp(oneWordKline, 0.1) === true],
]
console.log('\n=== 断言 ===')
let pass = true
for (const [name, ok] of asserts) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (!ok) pass = false
}
console.log(pass ? '\n✅ 市场引擎验证通过' : '\n❌ 验证失败')
if (!pass) process.exit(1)
