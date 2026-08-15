/**
 * IC 分析与回测引擎验证脚本
 * 运行：npx tsx scripts/verify-ic-backtest.ts
 * 前提：proxy (8787) 已运行
 */
import { computeFactorICs } from '../src/engine/icAnalysis'
import { runBacktest } from '../src/engine/backtest'
import { DEFAULT_FACTORS } from '../src/config/factors'

const BASE = 'http://127.0.0.1:8787'

const STOCKS = [
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
  { code: '000651', name: '格力电器', market: 'sz' },
  { code: '600030', name: '中信证券', market: 'sh' },
  { code: '601398', name: '工商银行', market: 'sh' },
  { code: '600276', name: '恒瑞医药', market: 'sh' },
  { code: '000725', name: '京东方A', market: 'sz' },
  { code: '002415', name: '海康威视', market: 'sz' },
  { code: '600887', name: '伊利股份', market: 'sh' },
  { code: '601888', name: '中国中免', market: 'sh' },
  { code: '600028', name: '中国石化', market: 'sh' },
  { code: '601601', name: '中国太保', market: 'sh' },
]

async function loadKline(market: string, code: string) {
  const key = `${market === 'sh' ? 'sh' : 'sz'}${code}`
  const res = await fetch(
    `${BASE}/kline?market=${market}&code=${code}&lmt=160`,
  )
  const data = await res.json()
  const rows = data?.data?.[key]?.qfqday ?? data?.data?.[key]?.day ?? []
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

async function main() {
  console.log('=== 1. 加载 K 线 ===')
  const stocks = []
  for (const s of STOCKS) {
    const kline = await loadKline(s.market, s.code)
    stocks.push({ code: s.code, name: s.name, kline })
    console.log(`  ✔ ${s.name} ${kline.length}根`)
  }

  console.log('\n=== 2. IC 分析（forward=5日） ===')
  const ics = computeFactorICs(stocks, 5, 8)
  console.log('因子          平均IC     IR      t值     胜率   IC样本')
  ics.forEach((f) => {
    console.log(
      `${f.name.padEnd(8)}  ${f.meanIC.toFixed(3).padStart(7)}  ${f.ir
        .toFixed(2)
        .padStart(6)}  ${f.tStat.toFixed(2).padStart(6)}  ${(f.winRate * 100)
        .toFixed(0)
        .padStart(3)}%  ${f.icSeries.length}`,
    )
  })

  console.log('\n=== 3. 回测（Top 5, 每20日调仓） ===')
  const result = runBacktest(stocks, {
    startDate: '0000-01-01',
    endDate: '2050-01-01',
    topN: 5,
    rebalanceDays: 20,
    factors: DEFAULT_FACTORS,
  })
  console.log(`  累计收益: ${result.totalReturn.toFixed(2)}%  基准: ${((result.benchmark[result.benchmark.length-1] - 1) * 100).toFixed(2)}%`)
  console.log(`  年化收益: ${result.annualReturn.toFixed(2)}%  夏普: ${result.sharpe.toFixed(2)}  最大回撤: ${result.maxDrawdown.toFixed(2)}%`)
  console.log(`  调仓 ${result.trades.length} 期，胜率 ${result.winRate.toFixed(0)}%`)
  console.log(`  净值序列长度: ${result.portfolio.length}（应有交易日数量）`)
  if (result.trades.length > 0) {
    console.log(`  首期持仓: ${result.trades[0].codes.join(', ')}`)
    console.log(`  首期收益: ${result.trades[0].periodReturn.toFixed(2)}% vs 基准 ${result.trades[0].benchmarkReturn.toFixed(2)}%`)
  }
  console.log('=== 验证完成 ===')
}

main().catch((e) => {
  console.error('验证失败:', e)
  process.exit(1)
})
