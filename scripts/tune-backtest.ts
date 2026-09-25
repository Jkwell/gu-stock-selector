/**
 * 回踩低吸策略：多参数回测对比（最近一年）
 * 运行：npx tsx scripts/tune-backtest.ts
 * 前提：proxy (8787) 已运行
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { runStartupBacktest } from '../src/engine/backtest-startup'
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

async function fetchMoneyFlow(
  market: 'sh' | 'sz',
  code: string,
  num: number,
): Promise<Map<string, number>> {
  const m = new Map<string, number>()
  try {
    const res = await fetch(`${BASE}/sina-moneyflow?market=${market}&code=${code}&num=${num}`)
    const arr = (await res.json()) as Array<{ opendate: string; netamount: string }>
    if (Array.isArray(arr)) for (const r of arr) m.set(String(r.opendate), Number(r.netamount))
  } catch {
    /* ignore */
  }
  return m
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

async function loadStocksAndMoney() {
  if (existsSync(CACHE)) {
    console.log('使用缓存数据…')
    const raw = JSON.parse(readFileSync(CACHE, 'utf8')) as {
      stocks: { code: string; name: string; kline: Kline[] }[]
      money: Array<[string, Array<[string, number]>]>
    }
    return {
      stocks: raw.stocks,
      moneyFlowByCode: new Map(raw.money.map(([c, arr]) => [c, new Map(arr)])),
    }
  }
  console.log('拉取股票列表…')
  const list = await fetchSinaList()
  // 固定股票池（按代码排序均匀采样，避免用"今日换手率"造成的未来函数与不稳定）
  const filtered = list
    .filter((s) => s.code && s.name && !/ST|退/.test(s.name))
    .filter((s) => {
      const p = Number(s.price)
      return p >= 3 && p <= 100
    })
    .sort((a, b) => a.code.localeCompare(b.code))
  const step = Math.max(1, Math.floor(filtered.length / 400))
  const candidates = filtered.filter((_, i) => i % step === 0).slice(0, 400)

  console.log(`候选 ${candidates.length} 只，拉取K线+资金流…`)

  const stocks: { code: string; name: string; kline: Kline[] }[] = []
  const moneyFlowByCode = new Map<string, Map<string, number>>()
  let done = 0
  await mapLimit(candidates, 10, async (s) => {
    const market: 'sh' | 'sz' = s.market ?? (s.code.startsWith('6') ? 'sh' : 'sz')
    const kline = await fetchKline(market, s.code, 600)
    if (kline.length >= 80) {
      stocks.push({ code: s.code, name: s.name, kline })
      const mf = await fetchMoneyFlow(market, s.code, 500)
      if (mf.size > 0) moneyFlowByCode.set(s.code, mf)
    }
    done++
    if (done % 25 === 0) console.log(`  ${done}/${candidates.length}`)
  })

  console.log(`\n有效股票 ${stocks.length} 只，资金流 ${moneyFlowByCode.size} 只\n`)
  writeFileSync(
    CACHE,
    JSON.stringify({
      stocks,
      money: [...moneyFlowByCode.entries()].map(([c, m]) => [c, [...m.entries()]]),
    }),
  )
  return { stocks, moneyFlowByCode }
}

async function runCombos(
  stocks: { code: string; name: string; kline: Kline[] }[],
  moneyFlowByCode: Map<string, Map<string, number>>,
) {
  const combos: Array<{ name: string; stop: number; tp: number; hold: number; topN: number }> = [
    { name: '基准 hold5 top10', stop: 8, tp: 15, hold: 5, topN: 10 },
    { name: 'hold5 top5', stop: 8, tp: 15, hold: 5, topN: 5 },
    { name: 'hold6 top5', stop: 8, tp: 15, hold: 6, topN: 5 },
    { name: 'hold6 top10', stop: 8, tp: 15, hold: 6, topN: 10 },
    { name: 'hold7 top5', stop: 8, tp: 15, hold: 7, topN: 5 },
    { name: 'hold7 top10', stop: 8, tp: 15, hold: 7, topN: 10 },
    { name: 'hold8 top5', stop: 8, tp: 15, hold: 8, topN: 5 },
    { name: 'hold8 top10', stop: 8, tp: 15, hold: 8, topN: 10 },
    { name: 'hold8 top8', stop: 8, tp: 15, hold: 8, topN: 8 },
    { name: 'hold6 top8', stop: 8, tp: 15, hold: 6, topN: 8 },
  ]

  console.log('参数组合 | 收益% | 胜率% | 回撤% | 笔数 | 平均每笔%')
  console.log('---')
  for (const c of combos) {
    const r = runStartupBacktest(stocks, {
      topN: c.topN,
      holdDays: c.hold,
      lookbackDays: 250,
      minScore: 50,
      stopLossPct: c.stop,
      takeProfitPct: c.tp,
      factorKey: 'pullback',
      requireMarketUp: true,
      moneyFlowByCode,
    })
    console.log(
      `${c.name} | ${r.totalReturn} | ${r.winRate} | ${r.maxDrawdown} | ${r.tradeCount} | ${r.avgReturn}`,
    )
  }
}

async function main() {
  const { stocks, moneyFlowByCode } = await loadStocksAndMoney()
  await runCombos(stocks, moneyFlowByCode)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
