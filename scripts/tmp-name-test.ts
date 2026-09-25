import type { StockInfo } from '../src/types'

function searchStocks(list: StockInfo[], q: string): StockInfo[] {
  const norm = q.trim()
  if (!norm) return []
  const exact = list.filter((s) => s.name === norm)
  if (exact.length > 0) return exact.slice(0, 10)
  const starts = list.filter((s) => s.name.startsWith(norm))
  const contains = list.filter((s) => s.name.includes(norm) && !s.name.startsWith(norm))
  return [...starts, ...contains].slice(0, 10)
}

const list: StockInfo[] = [
  { code: '600519', name: '贵州茅台', market: 'sh' },
  { code: '000858', name: '五粮液', market: 'sz' },
  { code: '000001', name: '平安银行', market: 'sz' },
  { code: '601318', name: '中国平安', market: 'sh' },
  { code: '300750', name: '宁德时代', market: 'sz' },
  { code: '002594', name: '比亚迪', market: 'sz' },
  { code: '600036', name: '招商银行', market: 'sh' },
  { code: '688981', name: '中芯国际', market: 'sh' },
]

let pass = true
const cases: Array<[string, string]> = [
  ['茅台', '贵州茅台(600519)'],
  ['贵州茅台', '贵州茅台(600519)'],
  ['平安', '中国平安(601318)'], // 前缀优先于包含（平安银行）
  ['银行', '招商银行(600036)'], // 前缀优先
  ['600519', '无结果'], // 数字不走名称搜索
  ['不存在', '无结果'],
]
for (const [q, expect] of cases) {
  const r = searchStocks(list, q)
  const got = r.length ? `${r[0].name}(${r[0].code})` : '无结果'
  const ok = got === expect
  console.log(`查询「${q}」 → ${got} [期望 ${expect}] ${ok ? '✅' : '❌'}`)
  if (!ok) pass = false
}
// 前缀 vs 包含：搜「平安」应把「中国平安」(startsWith) 排在「平安银行」(startsWith) 前
const p = searchStocks(list, '平安')
console.log(`「平安」排序 → ${p.map((s) => s.name).join('、')}（中国平安 应在前）${p[0]?.name === '中国平安' ? '✅' : '❌'}`)
if (p[0]?.name !== '中国平安') pass = false
console.log(pass ? '\n名称搜索通过 ✅' : '\n失败 ❌')
process.exit(pass ? 0 : 1)
