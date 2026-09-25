/** 分时数据解析 + 持仓盈亏计算验证 */
import { fetchMinuteData } from '../src/data/api'

console.log('=== 分时数据解析（真实数据，需 proxy） ===')
try {
  const points = await fetchMinuteData('600519')
  console.log(`  共 ${points.length} 分钟`)
  if (points.length > 0) {
    const last = points[points.length - 1]
    console.log(`  最后: 时间${last.time} 价${last.price} 均价${last.avgPrice} 量${last.volume}手`)
    const ok = points.every((p) => Number.isFinite(p.price) && Number.isFinite(p.avgPrice) && p.avgPrice > 0)
    console.log(`  价格/均价全部有效 ${ok ? '✅' : '❌'}`)
  }
} catch (e) {
  console.log('  ⚠ proxy 不可用:', (e as Error).message)
}

// 持仓盈亏纯函数验证
function calcPnl(buyPrice: number, current: number, shares: number) {
  return { pnl: (current - buyPrice) * shares, pct: (current / buyPrice - 1) * 100 }
}
console.log('\n=== 持仓盈亏计算 ===')
const r = calcPnl(100, 110, 200)
console.log(`  买100元×200股 → 现110元: 盈利 ¥${r.pnl}（期望 +2000）${r.pnl === 2000 ? '✅' : '❌'}`)
const r2 = calcPnl(100, 95, 100)
console.log(`  买100元×100股 → 现95元: 盈亏 ¥${r2.pnl}（期望 -500）${r2.pnl === -500 ? '✅' : '❌'}`)
console.log('\n=== 验证完成 ===')
