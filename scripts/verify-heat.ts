/**
 * 板块热度持续性追踪验证（纯函数，无网络）
 * 运行：npm run verify:heat
 */
import { computePersistence } from '../src/engine/heatHistory'
import type { SectorHeat } from '../src/engine/sectorHeat'

const mk = (sector: string, heatScore = 80): SectorHeat => ({
  sector,
  avgChangePct: 3,
  limitUpCount: 2,
  limitUpRatio: 0.1,
  upRatio: 0.9,
  heatScore,
  stockCount: 20,
  leaders: [],
})

console.log('=== 板块持续性追踪 ===')

// 第 1 天：光模块、算力在榜
const day1 = computePersistence([mk('光模块'), mk('算力')], null, '2026-08-31')
console.log(`  首日: 光模块=${day1.sectors['光模块'].days} 算力=${day1.sectors['算力'].days}`)

// 同一天刷新：天数不应累加
const day1Refresh = computePersistence([mk('光模块', 90), mk('算力', 85)], day1, '2026-08-31')
console.log(`  同日刷新: 光模块=${day1Refresh.sectors['光模块'].days}（应仍为 1）`)

// 第 2 天：光模块仍在榜，算力掉榜，食品加工新上榜
const day2 = computePersistence([mk('光模块'), mk('食品加工')], day1Refresh, '2026-09-01')
console.log(`  次日: 光模块=${day2.sectors['光模块'].days}（应=2） 食品加工=${day2.sectors['食品加工'].days}（应=1，新上榜）`)

// 第 3 天：光模块连榜
const day3 = computePersistence([mk('光模块'), mk('食品加工'), mk('造纸')], day2, '2026-09-02')
console.log(`  三日: 光模块=${day3.sectors['光模块'].days}（应=3） 造纸=${day3.sectors['造纸'].days}（应=1）`)

const asserts: Array<[string, boolean]> = [
  ['首日板块天数=1', day1.sectors['光模块'].days === 1 && day1.sectors['算力'].days === 1],
  ['同日刷新天数不累加', day1Refresh.sectors['光模块'].days === 1],
  ['连续上榜天数累加（光模块 2→3）', day2.sectors['光模块'].days === 2 && day3.sectors['光模块'].days === 3],
  ['掉榜后重新上榜回退首日（算力缺席）', !('算力' in day2.sectors)],
  ['新上榜板块=首日（食品加工/造纸）', day2.sectors['食品加工'].days === 1 && day3.sectors['造纸'].days === 1],
]

console.log('\n=== 断言 ===')
let pass = true
for (const [name, ok] of asserts) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (!ok) pass = false
}
console.log(pass ? '\n✅ 板块持续性验证通过' : '\n❌ 验证失败')
if (!pass) process.exit(1)
