/**
 * 温和放量规则（东财条件选股）验证
 * 运行：npx tsx scripts/verify-quickrules.ts
 */
import { filterByQuickRules, calcVolumeRatio } from '../src/engine/quickRules'
import type { Kline, StockInfo } from '../src/types'

const mk = (
  code: string,
  name: string,
  turnover: number,
  price = 20,
  amount = 5e8,
  market: 'sh' | 'sz' = 'sh',
): StockInfo => ({
  code, name, market, turnoverRate: turnover, price, amount,
})

console.log('=== 1. 快照粗筛（价格/换手/成交额/剔除） ===')
const stocks: StockInfo[] = [
  mk('600001', '放量好票', 8),                    // ✅ 全部满足
  mk('600002', '价格太低', 8, 2),                  // ❌ 价格<3
  mk('600003', '换手太高', 31),                    // ❌ 换手>30
  mk('600004', '成交额太低', 8, 20, 1e6),          // ❌ 成交额<3000万
  mk('688001', '科创板股', 8),                     // ❌ 688
  mk('600006', 'ST风险', 8),                       // ❌ ST
  mk('830001', '北交所股', 8, 20, 5e8, 'bj'),      // ❌ 北交所
]
const filtered = filterByQuickRules(stocks)
console.log(`  过滤后 ${filtered.length} 只（期望 1）:`, filtered.map((s) => s.name).join(', '))
console.log(filtered.length === 1 && filtered[0].name === '放量好票' ? '  ✅ 快筛正确' : '  ❌ 快筛错误')

console.log('\n=== 2. 量比计算 ===')
// 构造：前5日量 10000，当日量 20000 → 量比 2（满足1.2~5）
const kline: Kline[] = [
  ...Array.from({ length: 5 }, (_, i) => ({ date: `d${i}`, open: 10, close: 10, high: 10, low: 10, volume: 10000, amount: 0 })),
  { date: 'd6', open: 10, close: 10.5, high: 10.5, low: 10, volume: 20000, amount: 0 },
]
const ratio = calcVolumeRatio(kline)
console.log(`  放量2倍: 量比=${ratio?.toFixed(2)} ${ratio !== null && ratio >= 1.2 && ratio <= 5 ? '✅ 满足' : '❌'}`)

// 缩量：当日量 3000 / 前5日均量 10000 = 0.3
const shrink: Kline[] = [
  ...Array.from({ length: 5 }, (_, i) => ({ date: `d${i}`, open: 10, close: 10, high: 10, low: 10, volume: 10000, amount: 0 })),
  { date: 'd6', open: 10, close: 10, high: 10, low: 10, volume: 3000, amount: 0 },
]
const ratio2 = calcVolumeRatio(shrink)
console.log(`  缩量0.3倍: 量比=${ratio2?.toFixed(2)} ${ratio2 !== null && ratio2 >= 1.2 ? '❌ 不该满足' : '✅ 正确排除'}`)

// 天量：当日量 60000 / 10000 = 6（超过5）
const huge: Kline[] = [
  ...Array.from({ length: 5 }, (_, i) => ({ date: `d${i}`, open: 10, close: 10, high: 10, low: 10, volume: 10000, amount: 0 })),
  { date: 'd6', open: 10, close: 10, high: 10, low: 10, volume: 60000, amount: 0 },
]
const ratio3 = calcVolumeRatio(huge)
console.log(`  天量6倍: 量比=${ratio3?.toFixed(2)} ${ratio3 !== null && ratio3 > 5 ? '✅ 正确排除（>5）' : '❌'}`)

const pass = filtered.length === 1
  && ratio !== null && ratio >= 1.2 && ratio <= 5
  && (ratio2 === null || ratio2 < 1.2)
  && (ratio3 === null || ratio3 > 5)
console.log(pass ? '\n✅ 温和放量规则验证通过' : '\n❌ 验证失败')
if (!pass) process.exit(1)

// ===== 3. 上升趋势过滤验证 =====
console.log('\n=== 3. 上升趋势过滤（isUptrend） ===')
import { isUptrend } from '../src/engine/quickRules'

// 上升趋势：前50日10元，后20日逐步涨到12元
const uptrend: Kline[] = [
  ...Array.from({ length: 50 }, (_, i) => ({ date: `a${i}`, open: 10, close: 10 + i * 0.01, high: 10.2, low: 9.8, volume: 10000, amount: 0 })),
  ...Array.from({ length: 20 }, (_, i) => ({ date: `b${i}`, open: 10.5 + i * 0.05, close: 10.6 + i * 0.05, high: 10.8, low: 10.4, volume: 15000, amount: 0 })),
]
console.log(`  上升趋势: ${isUptrend(uptrend) ? '✅ 判定上升' : '❌ 误判'}`)

// 下跌趋势：持续阴跌
const downtrend: Kline[] = [
  ...Array.from({ length: 60 }, (_, i) => ({ date: `c${i}`, open: 12 - i * 0.05, close: 11.9 - i * 0.05, high: 12.1, low: 11.7, volume: 10000, amount: 0 })),
  { date: 'c60', open: 9, close: 8.9, high: 9.1, low: 8.8, volume: 10000, amount: 0 },
]
console.log(`  下跌趋势: ${!isUptrend(downtrend) ? '✅ 正确排除' : '❌ 误判'}`)

// 低位横盘：均线走平
const flat: Kline[] = Array.from({ length: 70 }, (_, i) => ({ date: `f${i}`, open: 10, close: 10 + (i % 3) * 0.1, high: 10.2, low: 9.8, volume: 10000, amount: 0 }))
console.log(`  低位横盘: ${!isUptrend(flat) ? '✅ 正确排除（拒绝抄底）' : '❌ 误判'}`)

const pass2 = isUptrend(uptrend) && !isUptrend(downtrend) && !isUptrend(flat)
console.log(pass2 ? '\n✅ 上升趋势过滤验证通过' : '\n❌ 验证失败')
if (!pass2) process.exit(1)
