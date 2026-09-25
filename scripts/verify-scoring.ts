/**
 * 引擎端到端验证脚本（真实数据）
 * 运行：npm run verify  或  npx tsx scripts/verify-scoring.ts
 * 前提：proxy (8787) 已运行
 */
import { scoreStocks, type ScoringInput } from '../src/engine/factors'
import { sma, macd, rsi } from '../src/engine/indicators'
import type { StockInfo } from '../src/types'

const BASE = 'http://127.0.0.1:8787'

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function loadPool(pool: 'b:BK0500' | 'b:BK0701' | string): Promise<StockInfo[]> {
  const fs = pool
  const url = `/clist?pn=1&pz=5000&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(
    fs,
  )}&fields=f2,f3,f9,f12,f13,f14,f20,f21,f23`
  const data = await jget<any>(url)
  const diff = data.data?.diff ?? []
  return diff
    .filter((d: any) => d.f12)
    .map((d: any) => ({
      code: String(d.f12),
      name: String(d.f14 ?? ''),
      market: (d.f13 === 1 ? 'sh' : 'sz') as StockInfo['market'],
      price: d.f2 === '-' ? undefined : Number(d.f2),
      changePct: d.f3 === '-' ? undefined : Number(d.f3),
      totalMv: d.f20 ? Number(d.f20) : undefined,
      floatMv: d.f21 ? Number(d.f21) : undefined,
      pe: d.f9 && d.f9 > 0 ? Number(d.f9) : undefined,
      pb: d.f23 && d.f23 > 0 ? Number(d.f23) : undefined,
    }))
}

async function loadKline(info: StockInfo) {
  const key = `${info.market === 'sh' ? 'sh' : 'sz'}${info.code}`
  const data = await jget<any>(
    `/kline?market=${info.market}&code=${info.code}&lmt=160`,
  )
  const node = data.data?.[key]
  const rows = node?.qfqday ?? node?.day ?? []
  return rows.map((p: string[]) => ({
    date: p[0],
    open: Number(p[1]),
    close: Number(p[2]),
    high: Number(p[3]),
    low: Number(p[4]),
    volume: Number(p[5]) || 0,
    amount: 0,
  }))
}

async function loadMoneyflow(info: StockInfo) {
  try {
    const data = await jget<any>(
      `/fflow?secid=${info.market === 'sh' ? 1 : 0}.${info.code}&lmt=1&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`,
    )
    const line = data.data?.klines?.[0]
    if (!line) return undefined
    const p = line.split(',')
    return {
      code: info.code,
      date: p[0],
      mainNetInflow: Number(p[1]),
      bigNetInflow: Number(p[4]),
      superNetInflow: Number(p[5]),
    }
  } catch {
    return undefined // push2 限流时降级，资金面因子缺席
  }
}

async function loadFinancials(info: StockInfo) {
  const data = await jget<any>(`/financials?code=${info.code}`)
  const row = data.result?.data?.[0]
  if (!row) return undefined
  return {
    code: info.code,
    reportDate: String(row.REPORTDATE ?? ''),
    roe: Number(row.WEIGHTAVG_ROE),
    revenueGrowth: Number(row.YSTZ),
    profitGrowth: Number(row.SJLTZ),
    grossMargin: Number(row.XSMLL),
  }
}

async function main() {
  console.log('=== 1. 指标计算单元验证（模拟数据） ===')
  const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
  const ma5 = sma(closes, 5)
  console.log('SMA5(1..15) 最后一个 =', ma5[14], '（期望 13）')
  const m = macd(closes)
  console.log('MACD 输出长度 =', m.dif.length, '（期望 15）')
  const r = rsi(closes)
  console.log('RSI14(单调递增序列) 最后 =', r[14]?.toFixed(2), '（单调涨→应接近 100）')

  console.log('\n=== 2. 真实数据打分验证 ===')
  // 尝试拉取沪深300（push2 可能限流，失败则用固定大盘股列表）
  let pool: StockInfo[] = []
  try {
    pool = await loadPool('b:BK0500')
    console.log(`   拉取沪深300，共 ${pool.length} 只`)
  } catch {
    console.log('   ⚠ clist(push2) 不可用，改用固定大盘股列表')
    pool = [
      { code: '600519', name: '贵州茅台', market: 'sh' },
      { code: '000858', name: '五粮液', market: 'sz' },
      { code: '601318', name: '中国平安', market: 'sh' },
      { code: '600036', name: '招商银行', market: 'sh' },
      { code: '000333', name: '美的集团', market: 'sz' },
      { code: '600900', name: '长江电力', market: 'sh' },
      { code: '002594', name: '比亚迪', market: 'sz' },
      { code: '601899', name: '紫金矿业', market: 'sh' },
      { code: '600309', name: '万华化学', market: 'sh' },
      { code: '300750', name: '宁德时代', market: 'sz' },
    ] as StockInfo[]
  }

  const top = [...pool].sort((a, b) => (b.totalMv ?? 0) - (a.totalMv ?? 0)).slice(0, 10)
  const inputs: ScoringInput[] = []
  for (const info of top) {
    const [kline, mf, fin] = await Promise.all([
      loadKline(info),
      loadMoneyflow(info),
      loadFinancials(info),
    ])
    inputs.push({ info, kline, moneyFlow: mf, financials: fin })
    console.log(`   ✔ ${info.name}(${info.code}) K线${kline.length}根`)
  }

  const factors = [
    { key: 'trend', name: '趋势强度', group: 'technical', weight: 0.15, enabled: true },
    { key: 'macd', name: 'MACD动量', group: 'technical', weight: 0.12, enabled: true },
    { key: 'rsi', name: 'RSI状态', group: 'technical', weight: 0.07, enabled: true },
    { key: 'volume', name: '成交量', group: 'technical', weight: 0.07, enabled: true },
    { key: 'momentum_1m', name: '动量1月', group: 'technical', weight: 0.09, enabled: true },
    { key: 'momentum_3m', name: '动量3月', group: 'technical', weight: 0.06, enabled: true },
    { key: 'reversal', name: '短期反转', group: 'technical', weight: 0.04, enabled: true },
    { key: 'volatility', name: '低波动', group: 'technical', weight: 0.04, enabled: true },
    { key: 'valuation', name: '估值', group: 'fundamental', weight: 0.16, enabled: true },
    { key: 'profitability', name: '盈利', group: 'fundamental', weight: 0.08, enabled: true },
    { key: 'growth', name: '成长', group: 'fundamental', weight: 0.08, enabled: true },
    { key: 'moneyflow', name: '主力净流入', group: 'money', weight: 0.04, enabled: true },
  ] as const

  const result = scoreStocks(inputs, [...factors])
  console.log('\n=== 打分结果（按总分排序，12 因子） ===')
  console.log('排名 代码   名称        总分   趋势  动量1 动量3 反转 波动 估值  盈利 成长 资金')
  result.forEach((s, i) => {
    const g = (k: string) =>
      s.factorScores.find((f) => f.key === k)?.score.toFixed(0) ?? '—'
    const pd = (v: string) => v.padStart(4)
    console.log(
      `${String(i + 1).padStart(2)}  ${s.code}  ${s.name.padEnd(8)}  ${String(
        s.totalScore.toFixed(1),
      ).padStart(5)}  ${pd(g('trend'))}  ${pd(g('momentum_1m'))}  ${pd(g('momentum_3m'))}  ${pd(g('reversal'))}  ${pd(g('volatility'))}  ${pd(g('valuation'))}  ${pd(g('profitability'))}  ${pd(g('growth'))}  ${pd(g('moneyflow'))}`,
    )
  })

  console.log('\n=== 4. 行业中性化验证 ===')
  const indResult = scoreStocks(inputs, [...factors])
  const bankVals = indResult.filter((s) => s.factorScores.find((f) => f.key === 'valuation'))
  const bankDetail = bankVals[0]?.factorScores.find((f) => f.key === 'valuation')?.detail
  console.log('   Top 股估值 detail:', bankDetail)
  console.log('   （应显示行业内分位，如"低于银行内 XX%"，而非全市场）')

  console.log('\n=== 3. 合理性检查 ===')
  const scores = result.map((s) => s.totalScore)
  const valid = scores.filter((v) => Number.isFinite(v))
  console.log(`   总分范围: ${Math.min(...valid).toFixed(1)} ~ ${Math.max(...valid).toFixed(1)}（应在 0~100）`)
  console.log(`   排序正确: ${scores.every((v, i) => i === 0 || scores[i - 1] >= v)}`)
  console.log('=== 验证完成 ===')
}

main().catch((e) => {
  console.error('验证失败:', e)
  process.exit(1)
})
