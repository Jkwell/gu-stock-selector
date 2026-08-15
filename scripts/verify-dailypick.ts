/**
 * 买卖点计算验证脚本
 * 运行：npx tsx scripts/verify-dailypick.ts
 * 1) 构造 K 线验证买卖点合理区间
 * 2) 拉真实 K 线验证（需 proxy 运行）
 */
import { computeTradingSignal } from '../src/engine/tradingSignals'
import type { Kline } from '../src/types'

function makeKline(closes: number[]): Kline[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: c,
    close: c,
    high: c * 1.02,
    low: c * 0.98,
    volume: 10000,
    amount: 0,
  }))
}

async function main() {
  console.log('=== 1. 构造数据验证买卖点 ===')
  // 上升趋势：从 100 涨到 110，最后回调到 108
  const uptrend = makeKline([
    ...Array.from({ length: 30 }, (_, i) => 100 + i * 0.3), // 100 -> 108.7
    ...Array.from({ length: 10 }, (_, i) => 108.7 - i * 0.1), // 回调到 107.8
  ])
  const sig1 = computeTradingSignal(uptrend, 108)
  if (!sig1) throw new Error('上升趋势信号为 null')
  console.log(`  现价 ${sig1.currentPrice}`)
  console.log(`  买入区间 ${sig1.buyLow} ~ ${sig1.buyHigh}`)
  console.log(`  止盈 ${sig1.takeProfit}  止损 ${sig1.stopLoss}  风险回报比 ${sig1.riskReward}`)
  console.log(`  理由: ${sig1.reasons.join(' | ')}`)

  // 断言
  const asserts: Array<[string, boolean]> = [
    ['止损 < 现价', sig1.stopLoss < sig1.currentPrice],
    ['止盈 > 现价', sig1.takeProfit > sig1.currentPrice],
    ['风险回报比 > 0', sig1.riskReward > 0],
    ['买入区间包含现价', sig1.buyLow <= sig1.currentPrice && sig1.currentPrice <= sig1.buyHigh],
  ]
  let pass = true
  for (const [name, ok] of asserts) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`)
    if (!ok) pass = false
  }

  console.log('\n=== 2. K 线不足返回 null ===')
  const short = makeKline([100, 101, 102])
  console.log(`  短 K 线(<30根) => ${computeTradingSignal(short) === null ? '✅ null' : '❌ 非 null'}`)

  console.log('\n=== 3. 真实数据验证（腾讯行情） ===')
  try {
    const key = 'sh600519'
    const res = await fetch(
      `http://127.0.0.1:8787/kline?market=sh&code=600519&lmt=160`,
    )
    if (!res.ok) {
      console.log('  ⚠ proxy 返回非 200，跳过真实数据验证')
    } else {
      const data = await res.json()
      const rows = data?.data?.[key]?.qfqday ?? data?.data?.[key]?.day ?? []
      const kline: Kline[] = rows.map((p: string[]) => ({
        date: p[0],
        open: Number(p[1]),
        close: Number(p[2]),
        high: Number(p[3]),
        low: Number(p[4]),
        volume: Number(p[5]) || 0,
        amount: 0,
      }))
      const sig2 = computeTradingSignal(kline)
      if (sig2) {
        console.log(`  贵州茅台 现价 ${sig2.currentPrice}`)
        console.log(`  买入 ${sig2.buyLow}~${sig2.buyHigh}  止盈 ${sig2.takeProfit}  止损 ${sig2.stopLoss}  RR ${sig2.riskReward}`)
        console.log(`  理由: ${sig2.reasons.join(' | ')}`)
      } else {
        console.log('  ⚠ 真实数据信号为 null')
      }
    }
  } catch {
    console.log('  ⚠ proxy 未运行，跳过真实数据验证（不影响单元验证）')
  }

  console.log('\n=== 验证完成 ===')
  if (!pass) process.exit(1)
}

main().catch((e) => {
  console.error('验证失败:', e)
  process.exit(1)
})
