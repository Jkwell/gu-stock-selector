/**
 * 概念题材龙头选股验证（构造数据，不依赖网络）
 * 运行：npx tsx scripts/verify-concept.ts
 */
import { computeConceptHeat } from '../src/engine/sectorHeat'
import { pickConceptLeaders } from '../src/engine/conceptLeader'
import type { StockInfo } from '../src/types'

const mk = (code: string, name: string, concept: string, changePct: number, turnover = 3): StockInfo => ({
  code, name, market: code.startsWith('6') ? 'sh' : 'sz',
  concept, changePct, turnoverRate: turnover,
})

// 构造：光模块概念 3 只（亨通涨停+9、中际+5、旭创-1），算力概念 2 只（美利云涨停、曙光+3），造纸 2 只
const stocks: StockInfo[] = [
  mk('600487', '亨通光电', '光模块', 9.5, 6),
  mk('300308', '中际旭创', '光模块', 5.2, 4),
  mk('688498', '源杰科技', '光模块', -1.5, 2),
  mk('000815', '美利云', '算力', 10, 8),
  mk('603019', '中科曙光', '算力', 3.1, 5),
  mk('600966', '博汇纸业', '造纸', 1, 1),
  mk('000488', '晨鸣纸业', '造纸', 0.5, 1),
]

console.log('=== 概念题材热度榜 ===')
const heat = computeConceptHeat(stocks, 5)
heat.forEach((h, i) =>
  console.log(`  #${i + 1} ${h.sector} 平均=${h.avgChangePct}% 涨停=${h.limitUpCount} 领涨=${h.leaders.join(',')}`),
)

// 增加一只"冷门题材但暴涨"的票（模拟一鸣）：独立逻辑，无概念涨停
stocks.push(mk('605179', '一鸣食品', '食品加工', 8.8, 9))

console.log('\n=== 题材龙头选股（加权排序 Top 4，不排除冷门） ===')
const leaders = pickConceptLeaders(stocks, 4)
leaders.forEach((s, i) =>
  console.log(`  ${i + 1}. ${s.name}(${s.code}) 概念=${s.concept} 涨幅=${s.changePct}%`),
)

// 断言
const leaderCodes = leaders.map((s) => s.code)
const asserts: Array<[string, boolean]> = [
  ['算力题材排第一（涨停相同+平均涨幅更高）', heat[0]?.sector === '算力'],
  ['亨通光电入选（光模块涨停龙头）', leaderCodes.includes('600487')],
  ['美利云入选（算力涨停龙头）', leaderCodes.includes('000815')],
  ['一鸣食品入选（冷门题材但暴涨）', leaderCodes.includes('605179')],
]
console.log('\n=== 断言 ===')
let pass = true
for (const [name, ok] of asserts) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (!ok) pass = false
}
console.log(pass ? '\n✅ 概念题材龙头验证通过' : '\n❌ 验证失败')
if (!pass) process.exit(1)
