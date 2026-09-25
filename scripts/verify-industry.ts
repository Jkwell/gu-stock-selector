/** 行业中性化离线验证（不依赖网络，构造数据测试） */
import { scoreStocks, type ScoringInput } from '../src/engine/factors'

const mk = (code: string, name: string, industry: string, pe: number): ScoringInput => ({
  info: { code, name, market: 'sh', industry, pe, totalMv: 1e10 },
  kline: [],
})
const banks = ['5', '6', '7', '8', '9'].map((p, i) =>
  mk(`60000${i}`, `银行${i}`, '银行', Number(p)),
)
const chips = ['30', '40', '50', '60', '70'].map((p, i) =>
  mk(`68800${i}`, `芯片${i}`, '半导体', Number(p)),
)
const inputs = [...banks, ...chips]

const valuationOnly = [
  { key: 'valuation', name: '估值', group: 'fundamental', weight: 1, enabled: true },
] as const

const res = scoreStocks(inputs, [...valuationOnly])
console.log('代码     名称    行业     PE    估值分')
res.sort((a, b) => a.code.localeCompare(b.code)).forEach((s) => {
  const v = s.factorScores[0]
  console.log(
    `${s.code}  ${s.name.padEnd(4)}  ${(s.industry ?? '').padEnd(4)}  ${String(s.info?.pe).padStart(4)}  ${String(v?.score).padStart(5)}  ${v?.detail}`,
  )
})

// 行业中性化的本质：行业内相对估值，跨行业均值趋同
const bankAvg =
  res.filter((s) => s.industry === '银行').reduce((a, s) => a + s.totalScore, 0) / 5
const chipAvg =
  res.filter((s) => s.industry === '半导体').reduce((a, s) => a + s.totalScore, 0) / 5
const diff = Math.abs(bankAvg - chipAvg)
// 检查行业内单调性：行业内 PE 最低应拿最高分
const bankSorted = res
  .filter((s) => s.industry === '银行')
  .sort((a, b) => (a.info?.pe ?? 0) - (b.info?.pe ?? 0))
  .map((s) => s.totalScore)
const monotonic = bankSorted.every((v, i) => i === 0 || bankSorted[i - 1] >= v)
// 检查 detail 是否包含行业名（而非"全市场"）
const hasIndDetail = res.every((s) => s.factorScores[0]?.detail?.includes(s.industry ?? ''))
console.log(`\n银行平均分: ${bankAvg.toFixed(1)}  半导体平均分: ${chipAvg.toFixed(1)}  差值: ${diff.toFixed(1)}`)
console.log(`行业内 PE→分数单调: ${monotonic}`)
console.log(`detail 含行业名: ${hasIndDetail}`)
const ok = diff < 10 && monotonic && hasIndDetail
console.log(ok ? '✅ 行业中性化验证通过' : '❌ 行业中性化未生效')
