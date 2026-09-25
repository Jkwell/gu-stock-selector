import { detectBoxBreakout, computeTradingSignal } from '../src/engine/tradingSignals'

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

const codes = ['603268', '000070', '600519']
for (const code of codes) {
  const market = code.startsWith('6') ? 'sh' : 'sz'
  const kline = (await klineEastmoney(market, code, 200)) ?? (await klineSina(market, code, 200))
  if (!kline) { console.log(`${code}: K线失败`); continue }
  const k = kline.map((p: string[]) => ({
    date: p[0], open: Number(p[1]), close: Number(p[2]),
    high: Number(p[3]), low: Number(p[4]), volume: Number(p[5]), amount: 0,
  }))
  const box = detectBoxBreakout(k)
  const sig = computeTradingSignal(k)
  console.log(`\n=== ${code} (${k.length}根K线) 最后日期 ${k[k.length-1].date} ===`)
  if (box) {
    console.log(`  箱体突破: active=${box.active} 当日突破=${box.breakoutDay} 突破后${box.sinceBreakout}天`)
    console.log(`  箱体 ${box.boxDays}日 ${box.boxLow}~${box.boxHigh} 高度${box.boxHeight}`)
    console.log(`  打开空间目标 ${box.measuredTarget} 空间比 ${box.riskReward}`)
  } else {
    console.log('  无箱体突破信号')
  }
  console.log(`  回踩信号: 买 ${sig?.buyLow}~${sig?.buyHigh} 止盈 ${sig?.takeProfit} 止损 ${sig?.stopLoss}`)
}
