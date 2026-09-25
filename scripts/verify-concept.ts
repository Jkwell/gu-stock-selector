/**
 * 概念题材龙头选股验证（构造数据，不依赖网络）
 * 运行：npm run verify:concept
 */
import { computeConceptHeat } from '../src/engine/sectorHeat'
import { pickConceptLeaders } from '../src/engine/conceptLeader'
import type { Kline, MoneyFlow, StockInfo } from '../src/types'

const mk = (code: string, name: string, concept: string, changePct: number, turnover = 3): StockInfo => ({
  code, name, market: code.startsWith('6') ? 'sh' : 'sz',
  concept, changePct, turnoverRate: turnover,
  floatMv: 80e8, // 80 亿流通市值，用于资金归一化
})

/** 由收盘价序列构造日 K 线 */
function mkKline(series: number[]): Kline[] {
  let prev = 10
  return series.map((close, i) => {
    const k: Kline = {
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: prev,
      close,
      high: Math.max(prev, close),
      low: Math.min(prev, close),
      volume: 1000,
      amount: 0,
    }
    prev = close
    return k
  })
}

/** 前 20 日缓慢爬升 ~10%（低位的初始形态） */
const steady = Array.from({ length: 20 }, (_, i) => 10 + i * 0.05)
const firstBoard = [...steady, steady[steady.length - 1] * 1.095] // 首板
let p = steady[steady.length - 1]
const highBoard5 = [...steady]
for (let i = 0; i < 5; i++) {
  p *= 1.1
  highBoard5.push(p)
}

const flow = (mainNetInflow: number): MoneyFlow => ({ code: '', mainNetInflow, superNetInflow: 0, bigNetInflow: 0, date: '2026-01-30' })

// 构造：光模块概念（亨通首板涨停、中际+5、旭创-1），算力（美利云高位5连板但资金净流出、曙光+3），造纸，冷门食品妖股
const stocks: StockInfo[] = [
  mk('600487', '亨通光电', '光模块', 9.5, 6),
  mk('300308', '中际旭创', '光模块', 5.2, 4),
  mk('688498', '源杰科技', '光模块', -1.5, 2),
  mk('000815', '美利云', '算力', 10, 8),
  mk('603019', '中科曙光', '算力', 3.1, 5),
  mk('600966', '博汇纸业', '造纸', 1, 1),
  mk('000488', '晨鸣纸业', '造纸', 0.5, 1),
  mk('605179', '一鸣食品', '食品加工', 8.8, 9), // 冷门题材但暴涨（独立逻辑/妖股）
]

// 各票的 K 线与资金流
const klineByCode: Record<string, Kline[]> = {
  '600487': mkKline(firstBoard),       // 首板，低位
  '300308': mkKline([...steady, steady[steady.length - 1] * 1.052]),
  '688498': mkKline([...steady, steady[steady.length - 1] * 0.985]),
  '000815': mkKline(highBoard5),       // 高位 5 连板
  '603019': mkKline([...steady, steady[steady.length - 1] * 1.031]),
  '600966': mkKline([...steady, steady[steady.length - 1] * 1.01]),
  '000488': mkKline([...steady, steady[steady.length - 1] * 1.005]),
  '605179': mkKline(firstBoard),       // 冷门首板
}
const flowByCode: Record<string, MoneyFlow> = {
  '600487': flow(2e8),   // 净流入
  '000815': flow(-3e8),  // 高位连板 + 净流出 → 双倍降级
  '605179': flow(2e8),
}

console.log('=== 概念题材热度榜 ===')
const heat = computeConceptHeat(stocks, 5)
heat.forEach((h, i) =>
  console.log(`  #${i + 1} ${h.sector} 平均=${h.avgChangePct}% 涨停=${h.limitUpCount} 领涨=${h.leaders.join(',')}`),
)

console.log('\n=== 题材龙头选股（精排 Top 4：首板优先 / 高位连板降级 / 资金确认） ===')
const leaders = await pickConceptLeaders(stocks, 4, {
  topK: 40,
  enrich: async (s) => ({
    kline: klineByCode[s.code] ?? [],
    moneyFlow: flowByCode[s.code],
  }),
})
leaders.forEach(({ stock: s, highRisk, reasons }, i) =>
  console.log(`  ${i + 1}. ${s.name}(${s.code}) 概念=${s.concept} 涨幅=${s.changePct}% ${highRisk ? '⚠️高位' : ''} [${reasons.join(',')}]`),
)

// 断言
const leaderCodes = leaders.map((x) => x.stock.code)
const conceptCount = new Map<string, number>()
for (const { stock } of leaders) {
  const c = stock.concept ?? ''
  conceptCount.set(c, (conceptCount.get(c) ?? 0) + 1)
}
const maxPerConcept = Math.max(0, ...conceptCount.values())
const asserts: Array<[string, boolean]> = [
  ['算力题材热度排第一（5连板推高单日热度）', heat[0]?.sector === '算力'],
  ['美利云被降级出局（高位5连板 + 资金净流出）', !leaderCodes.includes('000815')],
  ['亨通光电入选（首板 + 主力净流入 + 题材热）', leaderCodes.includes('600487')],
  ['一鸣食品入选（冷门题材但低位首板 + 净流入）', leaderCodes.includes('605179')],
  ['无高位风险票入选', leaders.every((x) => !x.highRisk)],
  ['同一题材最多 2 只（概念分散）', maxPerConcept <= 2],
]
console.log('\n=== 断言 ===')
let pass = true
for (const [name, ok] of asserts) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (!ok) pass = false
}
console.log(pass ? '\n✅ 概念题材龙头验证通过' : '\n❌ 验证失败')
if (!pass) process.exit(1)
