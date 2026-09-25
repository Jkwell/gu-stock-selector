/**
 * 检查：真实票里有多少会被识别为"已突破箱体"（非当日突破）
 * 目的：确认判定是否过松，导致大量票显示突破标识
 */
import { detectBoxBreakout } from '../src/engine/tradingSignals'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const makeFetchInit = (ref: string) => ({
  headers: { 'User-Agent': UA, Referer: ref, Accept: '*/*' },
  signal: AbortSignal.timeout(15000),
})

async function klineEastmoney(market: string, code: string, lmt = 200) {
  const secid = `${market === 'sh' ? '1' : '0'}.${code}`
  const params = new URLSearchParams({
    secid, ut: 'fa5fd1943c7b386f172d6893dbfba10b', klt: '101', fqt: '1',
    lmt: String(lmt), end: '20500101',
    fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57',
  })
  for (const host of ['https://push2his.eastmoney.com/api/qt/stock/kline/get', 'https://push2delay.eastmoney.com/api/qt/stock/kline/get']) {
    try {
      const resp = await fetch(`${host}?${params}`, makeFetchInit('https://quote.eastmoney.com/'))
      if (!resp.ok) continue
      const json = await resp.json()
      const ks = json?.data?.klines
      if (Array.isArray(ks) && ks.length) return ks.map((l) => String(l).split(',').slice(0, 7))
    } catch { /* next */ }
  }
  return null
}

async function klineSina(market: string, code: string, lmt = 200) {
  const symbol = `${market === 'sh' ? 'sh' : 'sz'}${code}`
  const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${lmt}`
  try {
    const resp = await fetch(url, makeFetchInit('https://finance.sina.com.cn/'))
    if (!resp.ok) return null
    const text = await resp.text()
    const m = text.match(/\[[\s\S]*\]/)
    if (!m) return null
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr) || !arr.length) return null
    return arr.map((r: any) => [r.day, String(r.open), String(r.close), String(r.high), String(r.low), String(r.volume), '0'])
  } catch { return null }
}

const testCodes = [
  ['603268', 'sh'], ['000070', 'sz'], ['600519', 'sh'], ['002594', 'sz'],
  ['600036', 'sh'], ['000858', 'sz'], ['601318', 'sh'], ['300750', 'sz'],
]

let hit = 0
for (const [code, market] of testCodes) {
  const kline = (await klineEastmoney(market, code, 200)) ?? (await klineSina(market, code, 200))
  if (!kline) { console.log(`${code}: 失败`); continue }
  const k = kline.map((p: string[]) => ({
    date: p[0], open: Number(p[1]), close: Number(p[2]),
    high: Number(p[3]), low: Number(p[4]), volume: Number(p[5]), amount: 0,
  }))
  const box = detectBoxBreakout(k)
  if (box && box.active) {
    hit++
    console.log(`${code}: 🔥 识别为突破（当日=${box.breakoutDay} 天数=${box.boxDays} 空间比=${box.riskReward}）`)
  } else {
    console.log(`${code}: 无突破`)
  }
}
console.log(`\n${testCodes.length} 只中 ${hit} 只被识别为突破`)
