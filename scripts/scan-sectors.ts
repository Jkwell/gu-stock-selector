import { computeMarketSentiment } from '../src/engine/marketSentiment'
import { computeSectorHeat, computeConceptHeat } from '../src/engine/sectorHeat'
import type { StockInfo } from '../src/types'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'
const HOST = 'https://push2delay.eastmoney.com/api/qt/clist/get'
const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'
const fields = 'f2,f3,f8,f9,f12,f13,f14,f20,f21,f23,f100,f128'
const toNum = (v: unknown) => {
  if (v === '-' || v === null || v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const stocks: StockInfo[] = []
let pn = 1
for (;;) {
  const url = `${HOST}?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(fs)}&fields=${fields}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const diff = data?.data?.diff
  if (!Array.isArray(diff) || diff.length === 0) break
  for (const d of diff) {
    const code = String(d?.f12 ?? '')
    if (!code) continue
    const pe = toNum(d?.f9)
    const pb = toNum(d?.f23)
    stocks.push({
      code,
      name: String(d?.f14 ?? ''),
      market: (d?.f13 === 1 ? 'sh' : 'sz') as StockInfo['market'],
      industry: d?.f100 ? String(d.f100) : undefined,
      concept: d?.f128 ? String(d.f128) : undefined,
      price: toNum(d?.f2),
      changePct: toNum(d?.f3),
      totalMv: toNum(d?.f20),
      floatMv: toNum(d?.f21),
      pe: pe !== undefined && pe > 0 ? pe : undefined,
      pb: pb !== undefined && pb > 0 ? pb : undefined,
      turnoverRate: toNum(d?.f8),
    })
  }
  if (stocks.length >= (data?.data?.total ?? 0)) break
  pn++
  await new Promise((r) => setTimeout(r, 200))
}

console.log(`拉取 ${stocks.length} 只\n`)
const s = computeMarketSentiment(stocks)
console.log(`情绪: ${s.level} 温度=${s.temperature} 涨停=${s.limitUpCount} 跌停=${s.limitDownCount} 上涨=${s.upCount}/${stocks.length}`)

const concepts = computeConceptHeat(stocks, 12)
console.log('\n=== 概念题材热度榜 Top12 ===')
concepts.forEach((h, i) =>
  console.log(
    `  #${i + 1} ${h.sector.padEnd(10)} 平均=${h.avgChangePct}% 涨停=${h.limitUpCount} 涨家占比=${(h.upRatio * 100).toFixed(0)}% 领涨: ${h.leaders.join(',')}`,
  ),
)

const sectors = computeSectorHeat(stocks, 12)
console.log('\n=== 行业热度榜 Top12 ===')
sectors.forEach((h, i) =>
  console.log(
    `  #${i + 1} ${h.sector.padEnd(8)} 平均=${h.avgChangePct}% 涨停=${h.limitUpCount} 涨家占比=${(h.upRatio * 100).toFixed(0)}% 领涨: ${h.leaders.join(',')}`,
  ),
)
