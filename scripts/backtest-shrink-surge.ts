/**
 * 缩量蓄势突破策略回测
 * 测试"前期放量 → 缩量洗盘 → 突破启动主升浪"模式的选股效果
 * 运行：npx tsx scripts/backtest-shrink-surge.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { runOptimizedBacktest } from '../src/engine/backtest-optimized'
import type { Kline } from '../src/types'

const BASE = 'http://127.0.0.1:8787'
const CACHE = 'C:/Users/lenovo/AppData/Local/Temp/bt-cache.json'

interface SinaRow {
  code: string
  name: string
  market: 'sh' | 'sz'
  price: number
  changePct: number
  totalMv: number
  floatMv: number
  pe: number
  pb: number
  turnoverRate: number
}

async function fetchSinaList(): Promise<SinaRow[]> {
  const res = await fetch(`${BASE}/sina-list?nodes=sh_a,sz_a`)
  const data = await res.json()
  return (data?.data?.diff ?? []) as SinaRow[]
}

async function fetchKline(
  market: 'sh' | 'sz',
  code: string,
  lmt: number,
): Promise<Kline[]> {
  try {
    const res = await fetch(`${BASE}/kline?market=${market}&code=${code}&lmt=${lmt}`)
    const data = await res.json()
    const key = `${market}${code}`
    const node = data?.data?.[key]
    const rows: string[][] = node?.qfqday ?? node?.day ?? []
    return rows.map((p) => ({
      date: p[0],
      open: Number(p[1]),
      close: Number(p[2]),
      high: Number(p[3]),
      low: Number(p[4]),
      volume: Number(p[5]) || 0,
      amount: 0,
    }))
  } catch {
    return []
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let idx = 0
  const workers = Array.from({ length: limit }, async () => {
    while (idx < items.length) {
      const item = items[idx++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

async function loadStocks() {
  if (existsSync(CACHE)) {
    console.log('使用缓存数据…')
    const raw = JSON.parse(readFileSync(CACHE, 'utf8')) as {
      stocks: { code: string; name: string; kline: Kline[] }[]
    }
    return raw.stocks
  }

  console.log('拉取股票列表…')
  const list = await fetchSinaList()
  const filtered = list
    .filter((s) => s.code && s.name && !/ST|退/.test(s.name))
    .filter((s) => {
      const p = Number(s.price)
      return p >= 3 && p <= 100
    })
    .sort((a, b) => a.code.localeCompare(b.code))
  const step = Math.max(1, Math.floor(filtered.length / 400))
  const candidates = filtered.filter((_, i) => i % step === 0).slice(0, 400)

  console.log(`候选 ${candidates.length} 只，拉取K线…`)

  const stocks: { code: string; name: string; kline: Kline[] }[] = []
  let done = 0
  await mapLimit(candidates, 10, async (s) => {
    const market: 'sh' | 'sz' = s.market ?? (s.code.startsWith('6') ? 'sh' : 'sz')
    const kline = await fetchKline(market, s.code, 600)
    if (kline.length >= 80) {
      stocks.push({ code: s.code, name: s.name, kline })
    }
    done++
    if (done % 25 === 0) console.log(`  ${done}/${candidates.length}`)
  })

  console.log(`\n有效股票 ${stocks.length} 只\n`)
  return stocks
}

async function main() {
  const stocks = await loadStocks()

  console.log('开始回测缩量蓄势突破策略（与界面同口径）…\n')
  const result = runOptimizedBacktest(stocks, {
    topN: 5,
    holdDays: 6,
    lookbackDays: 250,
    minScore: 85,
    stopLossPct: 8,
    takeProfitPct: 15,
    enableMineDetection: true,
    enableDynamicExit: false,
    costRate: 0.0015,
  })
  console.log('参数 | 收益% | 胜率% | 回撤% | 笔数 | 平均每笔%')
  console.log(`6天 / Top5 / 评分≥85 / 止损8% / 止盈15% / 排雷开启 | ${result.totalReturn} | ${result.winRate} | ${result.maxDrawdown} | ${result.tradeCount} | ${result.avgReturn}`)
  console.log(`日期范围 | ${result.startDate} ~ ${result.endDate}`)

  console.log('\n✅ 回测完成！')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
