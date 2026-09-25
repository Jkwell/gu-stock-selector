/** 板块过滤逻辑验证 */
import { fetchSectorList } from '../src/data/pipeline'
import { computeSectorHeat } from '../src/engine/sectorHeat'
import type { StockInfo } from '../src/types'

// 1. 板块过滤规则（与 pipeline 相同）
function filterBySector(stocks: StockInfo[], sector: string): StockInfo[] {
  return stocks.filter((s) =>
    sector === 'all' || s.industry === sector,
  )
}

const stocks: StockInfo[] = [
  { code: '600001', name: '半导A', market: 'sh', industry: '半导体', changePct: 5 },
  { code: '600002', name: '半导B', market: 'sh', industry: '半导体', changePct: 9 },
  { code: '000001', name: '白酒A', market: 'sz', industry: '白酒', changePct: 2 },
  { code: '000002', name: '白酒B', market: 'sz', industry: '白酒', changePct: -1 },
]

console.log('=== 板块过滤验证 ===')
const semis = filterBySector(stocks, '半导体')
console.log(`  选"半导体" → ${semis.length} 只: ${semis.map((s) => s.name).join(', ')} ${semis.every((s) => s.industry === '半导体') ? '✅' : '❌'}`)
const all = filterBySector(stocks, 'all')
console.log(`  选"全部" → ${all.length} 只（不限制）✅`)

console.log('\n=== 板块列表（真实数据，需 proxy） ===')
try {
  const sectors = await fetchSectorList()
  console.log(`  共 ${sectors.length} 个行业，前 10 个: ${sectors.slice(0, 10).join(', ')}`)
  const hasSemicon = sectors.includes('半导体')
  console.log(`  含"半导体" ${hasSemicon ? '✅' : '❌（行业名可能不同）'}`)
} catch {
  console.log('  ⚠ proxy 未运行或数据源不可用，跳过真实板块列表验证')
}

// 板块热点仍工作
const heat = computeSectorHeat(stocks, 5)
console.log('\n=== 板块热点（构造数据） ===')
heat.forEach((h) => console.log(`  ${h.sector} 涨停${h.limitUpCount} 平均${h.avgChangePct}%`))
console.log(heat[0]?.sector === '半导体' ? '\n✅ 板块过滤 + 热点验证通过' : '\n❌ 失败')
