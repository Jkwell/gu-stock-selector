/**
 * 仓位建议 + 资金趋势因子验证
 * 运行：npx tsx scripts/verify-advice.ts
 */
import { positionAdvice } from '../src/engine/positionAdvice'
import { scoreStocks, type ScoringInput } from '../src/engine/factors'

console.log('=== 1. 仓位建议 ===')
const hot = positionAdvice(85)
console.log(`  温度85 → 仓位${hot.position}% ${hot.position === 80 ? '✅' : '❌'} ${hot.text}`)
const neutral = positionAdvice(50)
console.log(`  温度50 → 仓位${neutral.position}% ${neutral.position === 50 ? '✅' : '❌'} ${neutral.text}`)
const cold = positionAdvice(20)
console.log(`  温度20 → 仓位${cold.position}% ${cold.position === 0 ? '✅' : '❌'} ${cold.text}`)

console.log('\n=== 2. 资金趋势因子（moneyflow_5d） ===')
const mf5d = [
  { key: 'moneyflow_5d', name: '资金趋势', group: 'money', weight: 1, enabled: true },
] as const
// 连续净流入：5日主力净流入合计占流通市值 1%
const inflow: ScoringInput = {
  info: { code: '600001', name: '吸筹股', market: 'sh', floatMv: 100e8 },
  kline: [],
  moneyFlowHistory: [1e8, 1.2e8, 0.8e8, 1.5e8, 2e8], // 5日净流入 ~6.5亿
}
const r1 = scoreStocks([inflow], [...mf5d])
const s1 = r1[0].factorScores[0]
console.log(`  连续净流入: 得分=${s1?.score} ${(s1?.score ?? 0) >= 60 ? '✅ 高分' : '❌'}`)
console.log(`    ${s1?.detail}`)

// 净流出：5日主力净流出
const outflow: ScoringInput = {
  info: { code: '600002', name: '出货股', market: 'sh', floatMv: 100e8 },
  kline: [],
  moneyFlowHistory: [-2e8, -1.5e8, -1e8, -0.8e8, -1.2e8], // 5日净流出
}
const r2 = scoreStocks([outflow], [...mf5d])
const s2 = r2[0].factorScores[0]
console.log(`  持续净流出: 得分=${s2?.score} ${(s2?.score ?? 100) < 40 ? '✅ 低分' : '❌'}`)
console.log(`    ${s2?.detail}`)

// 无历史数据 → 因子缺席
const noHist: ScoringInput = {
  info: { code: '600003', name: '无数据', market: 'sh', floatMv: 100e8 },
  kline: [],
}
const r3 = scoreStocks([noHist], [...mf5d])
console.log(`  无历史数据: 因子缺席=${r3[0].factorScores.length === 0} ${r3[0].factorScores.length === 0 ? '✅' : '❌'}`)

const pass =
  hot.position === 80 && neutral.position === 50 && cold.position === 0 &&
  (s1?.score ?? 0) >= 60 && (s2?.score ?? 100) < 40 &&
  r3[0].factorScores.length === 0
console.log(pass ? '\n✅ 仓位建议 + 资金趋势验证通过' : '\n❌ 验证失败')
if (!pass) process.exit(1)
