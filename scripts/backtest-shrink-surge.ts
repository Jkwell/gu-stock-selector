/**
 * 缩量蓄势突破策略回测
 * 测试"前期放量 → 缩量洗盘 → 突破启动主升浪"模式的选股效果
 * 运行：npx tsx scripts/backtest-shrink-surge.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { calcShrinkSurgeScore } from '../src/engine/shrink-surge-factor'
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

/**
 * 回测引擎：每 holdDays 天调仓，选 topN 只评分最高的票持有
 */
function runBacktest(
  stocks: { code: string; name: string; kline: Kline[] }[],
  config: {
    topN: number
    holdDays: number
    lookbackDays: number
    minScore: number
  }
) {
  const { topN, holdDays, lookbackDays, minScore } = config

  // 找最短K线长度
  const minLen = Math.min(...stocks.map((s) => s.kline.length))
  const totalDays = Math.min(lookbackDays, minLen)
  if (totalDays < 70 + holdDays) {
    return {
      totalReturn: 0,
      avgReturn: 0,
      winRate: 0,
      maxDrawdown: 0,
      tradeCount: 0,
      trades: [],
    }
  }

  // 预计算每只股票的评分序列
  const scoreByStock = stocks.map((s) => calcShrinkSurgeScore(s.kline))

  const trades: Array<{
    date: string
    code: string
    name: string
    score: number
    entryPrice: number
    exitPrice: number
    exitDate: string
    returnPct: number
  }> = []

  let equity = 1
  let peak = 1
  let maxDD = 0

  // 从第70天开始，每隔holdDays天调仓
  for (let day = 70; day < totalDays - holdDays; day += holdDays) {
    // 对所有候选票打分
    const scored = stocks
      .map((s, idx) => {
        const score = scoreByStock[idx][day]
        return { ...s, score: score ?? 0 }
      })
      .filter((s) => s.score >= minScore / 100) // 转换为0-1区间
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)

    if (scored.length === 0) continue

    // 等权持有holdDays天
    const entryDate = stocks[0].kline[day]?.date ?? ''
    const exitDayIdx = Math.min(day + holdDays, totalDays - 1)
    const exitDate = stocks[0].kline[exitDayIdx]?.date ?? ''

    for (const s of scored) {
      const entryPrice = s.kline[day]?.close
      const exitPrice = s.kline[exitDayIdx]?.close
      if (!entryPrice || !exitPrice || entryPrice <= 0) continue

      const returnPct = ((exitPrice / entryPrice) - 1) * 100
      equity *= (1 + returnPct / 100)

      trades.push({
        date: entryDate,
        code: s.code,
        name: s.name,
        score: Math.round(s.score * 100),
        entryPrice,
        exitPrice,
        exitDate,
        returnPct: Number(returnPct.toFixed(2)),
      })
    }

    // 更新最大回撤
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak
    if (dd > maxDD) maxDD = dd
  }

  if (trades.length === 0) {
    return {
      totalReturn: 0,
      avgReturn: 0,
      winRate: 0,
      maxDrawdown: 0,
      tradeCount: 0,
      trades: [],
    }
  }

  const returns = trades.map((t) => t.returnPct)
  const wins = returns.filter((r) => r > 0).length
  const totalReturn = (equity - 1) * 100

  return {
    totalReturn: Number(totalReturn.toFixed(2)),
    avgReturn: Number((returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2)),
    winRate: Number(((wins / returns.length) * 100).toFixed(1)),
    maxDrawdown: Number((maxDD * 100).toFixed(2)),
    tradeCount: trades.length,
    trades: trades.slice(-10), // 最近10笔
  }
}

async function main() {
  const stocks = await loadStocks()

  console.log('开始回测缩量蓄势突破策略…\n')
  console.log('参数组合 | 收益% | 胜率% | 回撤% | 笔数 | 平均每笔%')
  console.log('---')

  const combos = [
    { name: 'hold5 top5 score50', hold: 5, topN: 5, minScore: 50 },
    { name: 'hold5 top8 score50', hold: 5, topN: 8, minScore: 50 },
    { name: 'hold5 top10 score50', hold: 5, topN: 10, minScore: 50 },
    { name: 'hold6 top5 score50', hold: 6, topN: 5, minScore: 50 },
    { name: 'hold6 top8 score50', hold: 6, topN: 8, minScore: 50 },
    { name: 'hold6 top10 score50', hold: 6, topN: 10, minScore: 50 },
    { name: 'hold5 top8 score60', hold: 5, topN: 8, minScore: 60 },
    { name: 'hold6 top8 score60', hold: 6, topN: 8, minScore: 60 },
    { name: 'hold5 top8 score55', hold: 5, topN: 8, minScore: 55 },
    { name: 'hold6 top5 score55', hold: 6, topN: 5, minScore: 55 },
  ]

  for (const c of combos) {
    const result = runBacktest(stocks, {
      topN: c.topN,
      holdDays: c.hold,
      lookbackDays: 250,
      minScore: c.minScore,
    })
    console.log(
      `${c.name} | ${result.totalReturn} | ${result.winRate} | ${result.maxDrawdown} | ${result.tradeCount} | ${result.avgReturn}`
    )
  }

  console.log('\n✅ 回测完成！')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
