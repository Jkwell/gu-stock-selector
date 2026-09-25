/**
 * 策略表现追踪引擎验证脚本（纯合成数据，无需网络）
 * 运行：npx tsx scripts/verify-strategy.ts
 */
import { computeStrategyStats, LEGACY_KEY } from '../src/engine/strategyStats'
import type { SettleResult } from '../src/engine/settle'
import type { PickRecord } from '../src/data/records'

let pass = true
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) pass = false
}

const settle = (
  status: SettleResult['status'],
  pct: number,
): SettleResult => ({ status, exitPrice: 0, exitDate: 'x', pct, barsUsed: 1, windowDays: 5 })

/** 构造一条记录：date + 策略 + 每只票的结算结果 */
function rec(
  date: string,
  strategy: { key: string; name: string } | undefined,
  settledList: SettleResult[],
): { record: PickRecord; settled: Map<string, SettleResult> } {
  const picks = settledList.map((_, i) => ({
    code: `60000${i}`,
    name: `票${i}`,
    price: 10,
    buyLow: 0,
    buyHigh: 0,
    takeProfit: 0,
    stopLoss: 0,
    totalScore: 80,
  }))
  const settled = new Map<string, SettleResult>()
  picks.forEach((p, i) => settled.set(`${date}:${p.code}`, settledList[i]))
  return { record: { date, strategy, picks }, settled }
}

console.log('=== 1. 两个策略分组统计正确 ===')
{
  const a = rec('2026-08-10', { key: 'gentle_volume', name: '📈 温和放量' }, [
    settle('take_profit', 8), settle('take_profit', 5), settle('stop_loss', -4), settle('holding', 2),
  ])
  const b = rec('2026-08-11', { key: 'strong', name: '🔥 强势领涨' }, [
    settle('stop_loss', -6), settle('stop_loss', -5), settle('take_profit', 7), settle('pending', 0),
  ])
  const stats = computeStrategyStats([a.record, b.record], new Map([...a.settled, ...b.settled]))
  const g = stats.find((s) => s.key === 'gentle_volume')
  const s = stats.find((s) => s.key === 'strong')
  check('温和放量 样本=4（含 holding）', g?.sampleCount === 4, `n=${g?.sampleCount}`)
  check('温和放量 止盈率=50%', g?.tpRate === 50, `tpRate=${g?.tpRate}`)
  check('温和放量 止损率=25%', g?.slRate === 25, `slRate=${g?.slRate}`)
  check('温和放量 平均收益 = (8+5-4+2)/4 = 2.75', g?.avgPct === 2.75, `avg=${g?.avgPct}`)
  check('强势领涨 样本=3（pending 不计入）', s?.sampleCount === 3, `n=${s?.sampleCount}`)
  check('强势领涨 平均收益 = (-6-5+7)/3 = -1.33', s?.avgPct === -1.3333333333333333, `avg=${s?.avgPct}`)
  check('按平均收益降序（温和放量在前）', stats[0].key === 'gentle_volume')
  check('legacy 标志都为 false', !g?.legacy && !s?.legacy)
}

console.log('\n=== 2. 旧记录（无 strategy）归 legacy ===')
{
  const legacy = rec('2026-08-05', undefined, [settle('take_profit', 3), settle('stop_loss', -2)])
  const stats = computeStrategyStats([legacy.record], legacy.settled)
  check('无 strategy → 归 legacy 组', stats.length === 1 && stats[0].key === LEGACY_KEY && stats[0].legacy)
  check('legacy 组名为"历史（未记录策略）"', stats[0].name.includes('未记录策略'))
}

console.log('\n=== 3. pending 不计入样本 ===')
{
  const r = rec('2026-08-12', { key: 'momentum', name: '📈 动量追击' }, [
    settle('pending', null as unknown as number),
    settle('take_profit', 6),
  ])
  const stats = computeStrategyStats([r.record], r.settled)
  check('仅 1 个有效样本', stats[0].sampleCount === 1, `n=${stats[0].sampleCount}`)
}

console.log('\n=== 4. 空输入 → 空数组 ===')
{
  const stats = computeStrategyStats([], new Map())
  check('空数组', stats.length === 0)
}

console.log('\n=== 5. 缺失 settled（K线不可用）也安全 ===')
{
  const r = rec('2026-08-13', { key: 'value', name: '💎 价值精选' }, [
    settle('take_profit', 6),
  ])
  const stats = computeStrategyStats([r.record], new Map()) // 没有任何结算结果
  check('无结算结果 → 样本 0、无 crash', stats.length === 1 && stats[0].sampleCount === 0)
}

console.log('\n' + (pass ? '✅ 全部通过' : '❌ 存在失败'))
if (!pass) process.exit(1)
