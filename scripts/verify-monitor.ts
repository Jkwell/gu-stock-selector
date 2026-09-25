/**
 * 监控状态引擎验证
 * 运行：npx tsx scripts/verify-monitor.ts
 */
import { watchStatus } from '../src/engine/monitor'
import type { WatchItem } from '../src/data/watchlist'

const item: WatchItem = {
  code: '600519',
  name: '贵州茅台',
  market: 'sh',
  buyLow: 1320,
  buyHigh: 1355,
  takeProfit: 1420,
  stopLoss: 1280,
  addedAt: '',
}

const cases: Array<[number, string]> = [
  [1275, 'stop_loss'], // 跌破止损
  [1280, 'stop_loss'], // 恰好止损
  [1420, 'take_profit'], // 到止盈
  [1350, 'buy_zone'], // 买点区间
  [1310, 'below_buy'], // 破买点下沿
  [1370, 'above_buy'], // 已超买点
]

console.log('=== 状态判断验证 ===')
let pass = true
for (const [price, expect] of cases) {
  const s = watchStatus(price, item)
  const ok = s.status === expect
  console.log(`  价格 ${price} → ${s.label.padEnd(10)} [期望 ${expect}] ${ok ? '✅' : '❌'}`)
  if (!ok) pass = false
}

// 无买卖点
const bare: WatchItem = { code: '000001', name: '平安银行', market: 'sz', addedAt: '' }
const s2 = watchStatus(10.5, bare)
console.log(`  无买卖点 → ${s2.label} [期望 no_signal] ${s2.status === 'no_signal' ? '✅' : '❌'}`)
if (s2.status !== 'no_signal') pass = false

console.log(pass ? '\n✅ 监控状态引擎验证通过' : '\n❌ 验证失败')
if (!pass) process.exit(1)
