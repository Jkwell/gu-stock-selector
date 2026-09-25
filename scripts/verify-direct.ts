/**
 * 前端直连数据源验证（不依赖代理，模拟生产环境）
 * 运行：npx tsx scripts/verify-direct.ts
 */
import {
  fetchKline,
  fetchRealtimeQuotes,
  fetchMinuteData,
  fetchFinancials,
} from '../src/data/api'

console.log('=== 直连数据源验证（生产模式） ===')

// K线（腾讯 UTF-8）
try {
  const kline = await fetchKline('sh', '600519', 5)
  console.log(`  K线: ${kline.length} 根，最新 ${kline[kline.length - 1]?.date} 收盘 ${kline[kline.length - 1]?.close} ${kline.length > 0 ? '✅' : '❌'}`)
} catch (e) {
  console.log(`  K线 ❌: ${(e as Error).message}`)
}

// 实时行情（腾讯 GBK）
try {
  const quotes = await fetchRealtimeQuotes(['600519', '000858'])
  const q = quotes[0]
  console.log(`  行情: ${q?.name} 价${q?.price} 涨${q?.changePct}% 换手${q?.turnover} ${q?.name === '贵州茅台' ? '✅ GBK解码正确' : '❌'}`)
} catch (e) {
  console.log(`  行情 ❌: ${(e as Error).message}`)
}

// 分时（腾讯 UTF-8）
try {
  const minute = await fetchMinuteData('600519')
  console.log(`  分时: ${minute.length} 点 ${minute.length > 0 ? '✅' : '❌'}`)
} catch (e) {
  console.log(`  分时 ❌: ${(e as Error).message}`)
}

// 财务（东财 datacenter UTF-8）
try {
  const fin = await fetchFinancials('600519')
  console.log(`  财务: ROE=${fin?.roe} 报告期=${fin?.reportDate?.slice(0, 7)} ${fin ? '✅' : '❌'}`)
} catch (e) {
  console.log(`  财务 ❌: ${(e as Error).message}`)
}

console.log('\n=== 验证完成 ===')
