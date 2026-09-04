/**
 * 个股买卖点分析引擎验证
 * 运行：npx tsx scripts/verify-stockanalysis.ts
 * 用带漂移的随机游走合成 K 线，分别验证：
 *   上升趋势→可买 / 空头→回避 / 一字板→回避 / 高位连板→回避 / 大盘冰点→降级 / 数据不足→null
 */
import { analyzeStock } from '../src/engine/stockAnalysis'
import { computeMarketSentiment } from '../src/engine/marketSentiment'
import type { Kline, StockInfo } from '../src/types'

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeKline(base: number, n: number, drift: number, vol: number, seed: number): Kline[] {
  const rnd = mulberry32(seed)
  const out: Kline[] = []
  let c = base
  const today = new Date('2026-08-15')
  for (let i = 0; i < n; i++) {
    const date = new Date(today)
    date.setDate(today.getDate() - (n - 1 - i))
    const open = c
    const ret = drift + (rnd() - 0.5) * 2 * vol
    const close = Number((c * (1 + ret)).toFixed(2))
    const high = Number((Math.max(open, close) * (1 + rnd() * 0.01)).toFixed(2))
    const low = Number((Math.min(open, close) * (1 - rnd() * 0.01)).toFixed(2))
    const volume = Math.round(5000 * (1 + (rnd() - 0.5) * 0.6))
    out.push({ date: date.toISOString().slice(0, 10), open, close, high, low, volume, amount: 0 })
    c = close
  }
  return out
}

/** 健康上升趋势：多头排列、RSI 适中、量价配合 */
const uptrend = makeKline(10, 120, 0.003, 0.012, 1)

/** 空头下跌：MA20<MA60，MACD 绿柱，RSI 低位 */
const downtrend = makeKline(20, 120, -0.008, 0.01, 7)

/** 一字板：最后一天开盘=最高=最低=收盘 且 +10% */
const oneWord = (() => {
  const base = makeKline(10, 119, 0.002, 0.008, 3)
  const last = base[base.length - 1]
  const close = Number((last.close * 1.1).toFixed(2))
  base.push({ date: '2026-08-18', open: close, close, high: close, low: close, volume: 800, amount: 0 })
  return base
})()

/** 高位 5 连板 */
const highBoard = (() => {
  const base = makeKline(10, 120, 0.002, 0.008, 5)
  for (let i = 0; i < 5; i++) {
    const prev = base[base.length - 1].close
    const c = Number((prev * 1.1).toFixed(2))
    base.push({
      date: `2026-08-2${i}`,
      open: Number((prev * 0.99).toFixed(2)),
      close: c,
      high: c,
      low: Number((prev * 0.99).toFixed(2)),
      volume: 9000,
      amount: 0,
    })
  }
  return base
})()

// 大盘情绪：冰点（普跌、无涨停） vs 火热（普涨 + 20 家 20cm 涨停）
const coldStocks: StockInfo[] = []
const hotStocks: StockInfo[] = []
for (let i = 0; i < 50; i++) {
  coldStocks.push({ code: String(600000 + i), name: 'x', market: 'sh', changePct: -2 })
  hotStocks.push({ code: String(600000 + i), name: 'x', market: 'sh', changePct: 2 })
}
for (let i = 0; i < 20; i++) hotStocks.push({ code: String(300000 + i), name: 'x', market: 'sz', changePct: 20 })
const cold = computeMarketSentiment(coldStocks)
const hot = computeMarketSentiment(hotStocks)

let pass = true

function report(label: string, a: { verdict: string; score: number } | null, expect: string) {
  const ok = a !== null && a.verdict === expect
  console.log(`  ${label.padEnd(14)} → ${a ? `${a.verdict}(${a.score})` : 'null'} [期望 ${expect}] ${ok ? '✅' : '❌'}`)
  if (!ok) pass = false
}

console.log('=== 个股买卖点分析验证 ===')
report('上升趋势(火热)', analyzeStock('600000', '测试', uptrend, undefined, hot), 'buy')
report('上升趋势(冰点)', analyzeStock('600000', '测试', uptrend, undefined, cold), 'watch')
report('空头下跌', analyzeStock('600000', '测试', downtrend, undefined, hot), 'avoid')
report('一字板', analyzeStock('600000', '测试', oneWord, undefined, hot), 'avoid')
report('高位5连板', analyzeStock('600000', '测试', highBoard, undefined, hot), 'avoid')

// 数据不足 → null
const tooShort = analyzeStock('600000', '测试', uptrend.slice(0, 20), undefined, hot)
console.log(`  数据不足30根  → ${tooShort === null ? 'null' : '非null'} [期望 null] ${tooShort === null ? '✅' : '❌'}`)
if (tooShort !== null) pass = false

// 买卖点结构合理性
const good = analyzeStock('600000', '测试', uptrend, undefined, hot)
if (good && good.signal) {
  const s = good.signal
  const sensible = s.buyLow > 0 && s.buyHigh >= s.buyLow && s.stopLoss < s.buyLow && s.takeProfit > s.buyHigh
  console.log(`  买卖点结构(${s.buyLow}/${s.buyHigh}/止盈${s.takeProfit}/止损${s.stopLoss}) ${sensible ? '✅' : '❌'}`)
  if (!sensible) pass = false
  console.log(`  检查项 ${good.checks.length} 项，通过 ${good.checks.filter((c) => c.pass).length} 项`)
  console.log(`  摘要：${good.summary}`)
} else {
  console.log('  买卖点结构 ❌（无信号）')
  pass = false
}

// 冰点降级：同只票在冰点应把结论从「适合买入」降为「观望」
const aHot = analyzeStock('600000', '测试', uptrend, undefined, hot)
const aCold = analyzeStock('600000', '测试', uptrend, undefined, cold)
if (aHot && aCold) {
  const downgraded = aHot.verdict === 'buy' && aCold.verdict === 'watch'
  console.log(`  冰点降级(热${aHot.verdict} → 冰${aCold.verdict}) ${downgraded ? '✅' : '❌'}`)
  if (!downgraded) pass = false
}

console.log(pass ? '\n全部通过 ✅' : '\n存在失败 ❌')
process.exit(pass ? 0 : 1)
