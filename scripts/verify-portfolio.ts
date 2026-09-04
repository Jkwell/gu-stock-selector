/**
 * 组合透视引擎验证脚本（纯合成数据，无需网络）
 * 运行：npx tsx scripts/verify-portfolio.ts
 */
import { analyzePortfolio } from '../src/engine/portfolioView'
import type { DailyPick } from '../src/types'

let pass = true
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) pass = false
}

const mk = (
  code: string,
  name: string,
  industry?: string,
  concept?: string,
): DailyPick => ({
  code,
  name,
  market: code.startsWith('6') ? 'sh' : 'sz',
  industry,
  concept,
  totalScore: 80,
  buyLow: 0,
  buyHigh: 0,
  takeProfit: 0,
  stopLoss: 0,
  riskReward: 0,
  reasons: [],
})

console.log('=== 1. 4 只同行业 → high ===')
{
  const v = analyzePortfolio([
    mk('600001', '甲', '通信设备', '光模块,算力'),
    mk('600002', '乙', '通信设备', '光模块'),
    mk('600003', '丙', '通信设备', '5G'),
    mk('600004', '丁', '通信设备', '物联网'),
  ])
  check('riskLevel = high', v.riskLevel === 'high', v.riskLevel)
  check('行业分组合并为 1 组 count=4', v.industryGroups.length === 1 && v.industryGroups[0].count === 4)
  check('光模块被 2 只共有', v.sharedConcepts.some((c) => c.concept === '光模块' && c.count === 2))
  check('advice 含具体行业名', v.advice.includes('通信设备'))
}

console.log('\n=== 2. 3 只共有某概念（含通用概念应过滤）→ high ===')
{
  const v = analyzePortfolio([
    mk('300001', '甲', '半导体', '融资融券,光模块,算力'),
    mk('300002', '乙', '光学', '融资融券,光模块,MSCI中国'),
    mk('300003', '丙', '消费电子', '融资融券,光模块'),
    mk('300004', '丁', '银行', '融资融券,沪股通'),
  ])
  check('riskLevel = high', v.riskLevel === 'high', v.riskLevel)
  check('光模块被 3 只共有', v.sharedConcepts.some((c) => c.concept === '光模块' && c.count === 3))
  check('通用概念被过滤（无 融资融券/MSCI中国/沪股通）', !v.sharedConcepts.some((c) => ['融资融券', 'MSCI中国', '沪股通'].includes(c.concept)))
}

console.log('\n=== 3. 2 只同行业其余不同 → medium ===')
{
  const v = analyzePortfolio([
    mk('600001', '甲', '银行', ''),
    mk('600002', '乙', '银行', ''),
    mk('600003', '丙', '半导体', '光模块'),
    mk('600004', '丁', '白酒', ''),
  ])
  check('riskLevel = medium', v.riskLevel === 'medium', v.riskLevel)
  check('银行 count=2', v.industryGroups.some((g) => g.industry === '银行' && g.count === 2))
}

console.log('\n=== 4. 全不同行业且无共有概念 → low ===')
{
  const v = analyzePortfolio([
    mk('600001', '甲', '银行', ''),
    mk('600002', '乙', '半导体', '光模块'),
    mk('600003', '丙', '白酒', ''),
    mk('600004', '丁', '医药', ''),
  ])
  check('riskLevel = low', v.riskLevel === 'low', v.riskLevel)
  check('无 sharedConcepts', v.sharedConcepts.length === 0)
  check('advice 含"分散良好"', v.advice.includes('分散良好'))
}

console.log('\n=== 5. concept undefined / 全通用概念 → 不误报 ===')
{
  const v1 = analyzePortfolio([
    mk('600001', '甲', '银行'),
    mk('600002', '乙', '半导体'),
    mk('600003', '丙', '白酒'),
    mk('600004', '丁', '医药'),
  ])
  check('无 concept 不误报 → low', v1.riskLevel === 'low', v1.riskLevel)

  const v2 = analyzePortfolio([
    mk('600001', '甲', '银行', '融资融券,沪股通'),
    mk('600002', '乙', '银行', '融资融券,深股通'),
    mk('600003', '丙', '银行', '融资融券'),
    mk('600004', '丁', '银行', '融资融券'),
  ])
  check('同行业 high 但概念维度不误报（全通用）', v2.riskLevel === 'high' && v2.sharedConcepts.length === 0)
}

console.log('\n=== 6. 概念串 split/trim/去空 边界 ===')
{
  const v = analyzePortfolio([
    mk('600001', '甲', '银行', ' 光模块 , 算力 ,'),
    mk('600002', '乙', '银行', '光模块'),
    mk('600003', '丙', '半导体', ' 算力 '),
    mk('600004', '丁', '白酒', ''),
  ])
  check('split/trim/去空后 光模块 count=2', v.sharedConcepts.some((c) => c.concept === '光模块' && c.count === 2))
  check('算力 count=2', v.sharedConcepts.some((c) => c.concept === '算力' && c.count === 2))
}

console.log('\n=== 7. 部分扎堆时文案不误报全部同向（3 半导体 + 1 煤炭） ===')
{
  const v = analyzePortfolio([
    mk('688001', '中芯国际', '半导体', ''),
    mk('688002', '长鑫科技', '半导体', ''),
    mk('688003', '华虹公司', '半导体', ''),
    mk('601088', '中国神华', '煤炭开采', ''),
  ])
  check('riskLevel = high', v.riskLevel === 'high', v.riskLevel)
  check('文案指明扎堆 3 只', v.advice.includes('3 只') && v.advice.includes('半导体'))
  check('文案指出其余 1 只是不同方向', v.advice.includes('其余 1 只') && v.advice.includes('中国神华'))
  check('不再说"4 只全部同涨同跌"', !v.advice.includes('4 只实际是同涨同跌'))
}

console.log('\n=== 8. 行业归一化：银行Ⅱ/银行Ⅲ 归并为 银行 ===')
{
  const v = analyzePortfolio([
    mk('600001', '工行', '银行Ⅱ', ''),
    mk('600002', '建行', '银行Ⅱ', ''),
    mk('600003', '招行', '银行Ⅲ', ''),
    mk('600004', '茅台', '白酒Ⅱ', ''),
  ])
  check('银行Ⅱ+银行Ⅲ 归并为 银行 ×3 → high', v.riskLevel === 'high', v.riskLevel)
  check('分组显示为"银行"而非"银行Ⅱ"', v.industryGroups.some((g) => g.industry === '银行' && g.count === 3))
  check('白酒Ⅱ 归一为 白酒 ×1', v.industryGroups.some((g) => g.industry === '白酒' && g.count === 1))
}

console.log('\n=== 9. industry 为 undefined → 归入"未知"且不参与集中度 ===')
{
  const v = analyzePortfolio([
    mk('600001', '甲', undefined, ''),
    mk('600002', '乙', undefined, ''),
    mk('600003', '丙', undefined, ''),
    mk('600004', '丁', undefined, ''),
  ])
  check('全部未知行业 → low（未知不参与集中度判定）', v.riskLevel === 'low', v.riskLevel)
  check('industryGroups 有"未知"组', v.industryGroups.some((g) => g.industry === '未知' && g.count === 4))
}

console.log('\n' + (pass ? '✅ 全部通过' : '❌ 存在失败'))
if (!pass) process.exit(1)
