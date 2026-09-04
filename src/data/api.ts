import type {
  AIJobInfo,
  AIReport,
  Financials,
  Kline,
  MoneyFlow,
  StockInfo,
} from '../types'

/**
 * 数据获取模块
 * 东财接口：浏览器 JSONP 优先，绕过跨域 fetch 的 CORS 限制。
 * 本地开发：JSONP 失败时回退 /api/* 代理（Vite proxy → proxy/index.mjs）。
 */

// ---- 数据源直连 URL（生产环境） ----
const TEN_QUOTE = 'https://qt.gtimg.cn/q=' // 腾讯实时行情（GBK）
// 注意：用 ifzq.gtimg.cn（不带 web. 前缀）。web.ifzq.gtimg.cn 被腾讯 WAF 拦截（跨域 501 跳 waf.tencent.com）。
// ifzq.gtimg.cn 正常时返回 Access-Control-Allow-Origin:* 可直连，但批量请求会触发按 IP 的 burst 限流
// （评分类日 K 有上千根，量一大就全部 501）。TEN_KLINE_MIRROR（proxy.finance.qq.com 的 newfqkline）同为
// 腾讯 K 线、返回相同 JSON 结构且 CORS 开放，作为降级镜像：主源被限流时自动切换。
const TEN_KLINE = 'https://ifzq.gtimg.cn/appstock/app/fqkline/get'
const TEN_KLINE_MIRROR =
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get'
const TEN_MINUTE = 'https://ifzq.gtimg.cn/appstock/app/minute/query'
const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
const EM_FFLOW = 'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get'
const EM_FFLOW_HIS = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get'
const EM_DATA = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const SINA_LIST =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 本地开发用代理 */
const dev = (path: string) => (isDev() ? `/api${path}` : path)
const isDev = () => {
  try {
    return (import.meta.env?.DEV as boolean) === true
  } catch {
    return false // tsx 脚本等无 Vite env 环境 → 走直连
  }
}

// 会话内标记：东财 push2 主源已被封锁/不可达 → 后续请求直接走 push2delay 镜像，
// 避免批量请求每页都在主源上空等超时。
let eastmoneyPrimaryDown = false
// 腾讯 K 线主源（ifzq.gtimg.cn）被 WAF 限流(501)后，本会话内直接改用镜像，
// 避免上千根 K 线里每一根都先撞一次 501 浪费超时。
let tencentKlinePrimaryDown = false

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fetchJsonp<T>(url: string, callbackName: string, timeoutMs = 12000): Promise<T> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('JSONP 只能在浏览器环境使用'))
  }
  return new Promise<T>((resolve, reject) => {
    const script = document.createElement('script')
    const scope = window as unknown as Record<string, (data: T) => void>
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      delete scope[callbackName]
      script.remove()
    }
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const timer = window.setTimeout(
      () => settle(() => reject(new Error('东财 JSONP 请求超时'))),
      timeoutMs,
    )
    scope[callbackName] = (data) => settle(() => resolve(data))
    script.onerror = () => settle(() => reject(new Error('东财 JSONP 网络请求失败')))
    script.src = url
    document.head.appendChild(script)
  })
}

function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  return fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(15000),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
    return res.json() as Promise<T>
  })
}

/**
 * 生产直连东财（CORS 直连，不走 JSONP）：EM 接口对任意 Origin 反射
 * Access-Control-Allow-Origin，浏览器可直接 fetch，从而让 pipeline 的
 * 并发(8)真正生效——JSONP 的全局 300ms 串行队列会把批量请求拖到几十分钟。
 * push2 主源不可达时切 push2delay 延迟镜像（约 15 分钟延迟，可接受降级）。
 */
async function emDirect<T>(primary: string, params: URLSearchParams): Promise<T> {
  const mirror = primary.replace(/push2(his)?\.eastmoney\.com/, 'push2delay.eastmoney.com')
  const hasMirror = mirror !== primary
  const hosts = hasMirror && eastmoneyPrimaryDown ? [mirror] : hasMirror ? [primary, mirror] : [primary]
  let lastError: unknown
  for (const host of hosts) {
    try {
      return await fetchJson<T>(`${host}?${params.toString()}`, {
        Referer: 'https://quote.eastmoney.com/',
      })
    } catch (error) {
      lastError = error
      if (host === primary && hasMirror && !eastmoneyPrimaryDown) {
        eastmoneyPrimaryDown = true
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('东财接口直连失败')
}

/** 腾讯实时行情快照 */
export interface Quote {
  code: string
  name: string
  price?: number
  changePct?: number
  high?: number
  low?: number
  turnover?: number
}

const secidOf = (market: StockInfo['market'], code: string) =>
  `${market === 'sh' ? 1 : 0}.${code}`

/** 根据代码判断市场前缀（6开头=沪，其他=深） */
export function marketPrefixOf(code: string): string {
  return code.startsWith('6') ? `sh${code}` : `sz${code}`
}

/** 根据代码判断市场 */
export function marketOfCode(code: string): StockInfo['market'] {
  return code.startsWith('6') ? 'sh' : 'sz'
}

/** 东财 clist 字段解析 */
function parseClistDiff(diff: Array<Record<string, number | string | null>>): StockInfo[] {
  const toNum = (v: number | string | null | undefined) => {
    if (v === '-' || v === null || v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return diff
    .map((d) => {
      const code = String(d.f12 ?? '')
      if (!code) return null
      const pe = toNum(d.f9)
      const pb = toNum(d.f23)
      return {
        code,
        name: String(d.f14 ?? ''),
        market: (d.f13 === 1 ? 'sh' : 'sz') as StockInfo['market'],
        industry: d.f100 ? String(d.f100) : undefined,
        concept: d.f128 && d.f128 !== '-' ? String(d.f128) : undefined,
        price: toNum(d.f2),
        changePct: toNum(d.f3),
        totalMv: toNum(d.f20),
        floatMv: toNum(d.f21),
        pe: pe !== undefined && pe > 0 ? pe : undefined,
        pb: pb !== undefined && pb > 0 ? pb : undefined,
        turnoverRate: toNum(d.f8),
        amount: toNum(d.f6),
      } as StockInfo
    })
    .filter((x): x is StockInfo => x !== null)
}

/**
 * A 股快照（一次拉全）。pool 决定股票池：
 *  - all: 沪深全市场
 *  - hs300: 沪深300 成分
 *  - zz500: 中证500 成分
 */
/** 生产直连：单页 clist JSONP，主源失败即切延迟镜像并置会话标记 */
const EM_CLIST_MIRROR = 'https://push2delay.eastmoney.com/api/qt/clist/get'
const EM_CLIST_TIMEOUT_MS = 8000
const EM_CLIST_CONCURRENCY = 5

async function fetchClistJsonp(
  page: number,
  fs: string,
  fields: string,
  pz: number,
): Promise<ClistResponse> {
  const params = new URLSearchParams({
    pn: String(page),
    pz: String(pz),
    po: '1',
    np: '1',
    fltt: '2',
    invt: '2',
    fid: 'f12',
    fs,
    fields,
  })
  params.set('ut', 'bd1d9ddb04089700cf9c27f6f7426281')
  const hosts = eastmoneyPrimaryDown ? [EM_CLIST_MIRROR] : [EM_CLIST, EM_CLIST_MIRROR]
  let lastError: unknown
  for (const host of hosts) {
    const callbackName = `emcb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const query = new URLSearchParams(params)
    query.set('cb', callbackName)
    query.set('_', String(Date.now()))
    try {
      return await fetchJsonp<ClistResponse>(
        `${host}?${query.toString()}`,
        callbackName,
        EM_CLIST_TIMEOUT_MS,
      )
    } catch (error) {
      lastError = error
      // 主源不可达 → 本会话后续分页直接走镜像，避免每页 8s 空等
      if (host === EM_CLIST && !eastmoneyPrimaryDown) eastmoneyPrimaryDown = true
      await delay(200)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('东财 clist JSONP 请求失败')
}

export async function fetchStockList(
  pool: 'all' | 'hs300' | 'zz500' = 'all',
): Promise<StockInfo[]> {
  const fs =
    pool === 'all'
      ? 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23' // 深主板+创业板+沪主板+科创板
      : pool === 'hs300'
        ? 'b:BK0500'
        : 'b:BK0701'
  const fields = 'f2,f3,f6,f8,f9,f12,f13,f14,f20,f21,f23,f100,f128'
  const all: StockInfo[] = []
  const seen = new Set<string>() // 按代码去重，防止代理兜底缓存重复页导致候选池重复
  const pz = 100 // 东财 clist 单页上限 100
  const merge = (diff: Array<Record<string, number | string | null>> | undefined) => {
    if (!diff) return
    for (const s of parseClistDiff(diff)) {
      if (seen.has(s.code)) continue
      seen.add(s.code)
      all.push(s)
    }
  }
  if (isDev()) {
    // 本地开发优先走代理（代理内置 push2delay 镜像兜底），
    // 避免直连被封锁/限流的 push2 时每次 JSONP 都空等超时拖慢整条流水线
    let page = 1
    for (;;) {
      const params = new URLSearchParams({
        pn: String(page),
        pz: String(pz),
        po: '1',
        np: '1',
        fltt: '2',
        invt: '2',
        fid: 'f12',
        fs,
        fields,
      })
      params.set('ut', 'bd1d9ddb04089700cf9c27f6f7426281')
      const data = await fetchJson<ClistResponse>(`/api/clist?${params.toString()}`, {
        Referer: 'https://quote.eastmoney.com/',
      })
      merge(data.data?.diff ?? [])
      const total = Number(data.data?.total ?? 0)
      if (all.length >= total || (data.data?.diff?.length ?? 0) === 0 || page > 40) break
      page++
    }
    return all
  }
  // 生产直连：第 1 页既取数据也做主源健康探测（失败即刻切镜像会话）
  const first = await fetchClistJsonp(1, fs, fields, pz)
  merge(first.data?.diff)
  const total = Number(first.data?.total ?? 0)
  const totalPages = Math.min(Math.max(Math.ceil(total / pz), 1), 40)
  // 剩余分页并发拉取（主源已挂则全部直走镜像，6 页并发 ~几秒内完成）
  if (totalPages > 1) {
    const rest: number[] = []
    for (let page = 2; page <= totalPages; page++) rest.push(page)
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(EM_CLIST_CONCURRENCY, rest.length) },
      async () => {
        while (cursor < rest.length) {
          const page = rest[cursor++]
          try {
            const d = await fetchClistJsonp(page, fs, fields, pz)
            merge(d.data?.diff)
          } catch (error) {
            // 单页失败不致命，缺一两页由后续候选池容错
            console.warn(`⚠ clist 第 ${page}/${totalPages} 页失败，跳过:`, error)
          }
        }
      },
    )
    await Promise.all(workers)
  }
  return all
}

/**
 * 新浪全市场快照（东财 clist 的降级替代）
 * 注意：无行业/概念字段（东财独有），降级时缺失
 */
export async function fetchStockListSina(): Promise<StockInfo[]> {
  const nodes = ['sh_a', 'sz_a']
  const all: StockInfo[] = []
  const pageSize = 100
  const toNum = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  // 本地代理已一次取完全部节点；不能再按前端页码重复请求，否则会无限循环。
  if (isDev()) {
    const data = await fetchJson<any>(dev(`/sina-list?nodes=${nodes.join(',')}`))
    const rows = data?.data?.diff ?? []
    for (const r of rows) {
      const code = String(r.code ?? r.f12 ?? '')
      if (!code) continue
      all.push({
        code,
        name: String(r.name ?? r.f14 ?? code),
        market: (r.market ?? (code.startsWith('6') ? 'sh' : 'sz')) as StockInfo['market'],
        price: toNum(r.trade ?? r.f2),
        changePct: toNum(r.changepercent ?? r.f3),
        totalMv: toNum(r.mktcap) ? toNum(r.mktcap)! * 10000 : undefined,
        floatMv: toNum(r.nmc) ? toNum(r.nmc)! * 10000 : undefined,
        pe: toNum(r.per ?? r.f9),
        pb: toNum(r.pb ?? r.f23),
        turnoverRate: toNum(r.turnoverratio ?? r.f8),
      })
    }
    return all
  }
  for (const node of nodes) {
    let page = 1
    for (;;) {
      const params = new URLSearchParams({
        page: String(page),
        num: String(pageSize),
        sort: 'symbol',
        asc: '1',
        node,
      })
      const rows = await fetchJson<any>(`${SINA_LIST}?${params.toString()}`, {
        Referer: 'http://vip.stock.finance.sina.com.cn/',
      })
      if (!Array.isArray(rows) || rows.length === 0) break
      for (const r of rows) {
        const code = String(r.code ?? r.f12 ?? '')
        if (!code) continue
        all.push({
          code,
          name: String(r.name ?? r.f14 ?? code),
          market: (r.market ?? (code.startsWith('6') ? 'sh' : 'sz')) as StockInfo['market'],
          price: toNum(r.trade ?? r.f2),
          changePct: toNum(r.changepercent ?? r.f3),
          totalMv: toNum(r.mktcap) ? toNum(r.mktcap)! * 10000 : undefined,
          floatMv: toNum(r.nmc) ? toNum(r.nmc)! * 10000 : undefined,
          pe: toNum(r.per ?? r.f9),
          pb: toNum(r.pb ?? r.f23),
          turnoverRate: toNum(r.turnoverratio ?? r.f8),
        })
      }
      if (rows.length < pageSize) break
      page++
    }
  }
  return all
}

/**
 * 批量获取腾讯实时行情
 * @param codes 格式 "600519,000858"（无市场前缀，自动识别）
 */
export async function fetchRealtimeQuotes(codes: string[]): Promise<Quote[]> {
  if (codes.length === 0) return []
  const prefixed = codes.map(marketPrefixOf).join(',')
  if (isDev()) {
    return fetchJson<Quote[]>('/api/quote?codes=' + encodeURIComponent(prefixed))
  }
  // 生产直连：腾讯行情返回 GBK，用 TextDecoder('gbk') 解码
  const res = await fetch(TEN_QUOTE + prefixed, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(10000),
  })
  const buf = new Uint8Array(await res.arrayBuffer())
  const text = new TextDecoder('gbk').decode(buf)
  const quotes: Quote[] = []
  const re = /v_(\w+?)="([^"]+)"/g
  let m
  while ((m = re.exec(text)) !== null) {
    const fields = m[2].split('~')
    const num = (v: string) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    quotes.push({
      code: fields[2] ?? '',
      name: (fields[1] ?? '').replace(/\s/g, '') || (fields[2] ?? ''),
      price: num(fields[3]),
      changePct: num(fields[32]),
      high: num(fields[33]),
      low: num(fields[34]),
      turnover: num(fields[38]),
    })
  }
  return quotes
}

/** 分时图数据点 */
export interface MinutePoint {
  time: string // HHMM
  price: number
  avgPrice: number // 均价线
  volume: number // 每分钟成交量（手）
}

interface MinuteResponse {
  data?: Record<string, { data?: { data?: string[] } }>
}

/** 获取个股分时数据（腾讯分钟接口） */
export async function fetchMinuteData(code: string): Promise<MinutePoint[]> {
  const prefix = marketPrefixOf(code)
  const url = isDev()
    ? `/api/minute?code=${encodeURIComponent(prefix)}`
    : `${TEN_MINUTE}?code=${encodeURIComponent(prefix)}`
  const data = await fetchJson<MinuteResponse>(url, { Referer: 'https://gu.qq.com/' })
  const rows = data?.data?.[prefix]?.data?.data ?? []
  const points: MinutePoint[] = []
  let prevVol = 0
  for (const row of rows) {
    const p = row.split(' ')
    if (p.length < 4) continue
    const time = p[0]
    const price = Number(p[1])
    const cumVol = Number(p[2])
    const cumAmt = Number(p[3])
    if (!Number.isFinite(price) || !Number.isFinite(cumVol)) continue
    const avgPrice = cumVol > 0 ? cumAmt / (cumVol * 100) : price
    points.push({
      time,
      price,
      avgPrice: Number(avgPrice.toFixed(2)),
      volume: cumVol - prevVol,
    })
    prevVol = cumVol
  }
  return points
}

interface TencentKlineResponse {
  data?: Record<string, { qfqday?: string[][]; day?: string[][] }>
}

function toKlines(rows: string[][]): Kline[] {
  return rows.map((p) => ({
    date: p[0],
    open: Number(p[1]),
    close: Number(p[2]),
    high: Number(p[3]),
    low: Number(p[4]),
    volume: Number(p[5]) || 0,
    amount: 0,
  }))
}

/** 历史日 K 线（前复权），lmt 控制根数。
 *  生产直连：ifzq.gtimg.cn 批量触发 WAF 限流(501)时自动切 proxy.finance.qq.com 镜像（同结构），
 *  镜像也失败才抛错。两个腾讯源的数据格式一致（data[key].qfqday）。 */
export async function fetchKline(
  market: StockInfo['market'],
  code: string,
  lmt = 160,
): Promise<Kline[]> {
  const key = `${market === 'sh' ? 'sh' : 'sz'}${code}`
  if (isDev()) {
    const data = await fetchJson<TencentKlineResponse>(
      `/api/kline?market=${market}&code=${code}&lmt=${lmt}`,
    )
    const rows = data.data?.[key]?.qfqday ?? data.data?.[key]?.day ?? []
    return toKlines(rows)
  }
  const hosts = tencentKlinePrimaryDown ? [TEN_KLINE_MIRROR] : [TEN_KLINE, TEN_KLINE_MIRROR]
  let lastError: unknown
  for (const host of hosts) {
    try {
      const url = `${host}?param=${encodeURIComponent(`${key},day,,,${lmt},qfq`)}`
      const data = await fetchJson<TencentKlineResponse>(url, {
        Referer: 'https://gu.qq.com/',
      })
      const node = data.data?.[key]
      const rows = node?.qfqday ?? node?.day ?? []
      if (rows.length > 0) return toKlines(rows)
      lastError = new Error(`腾讯K线空数据: ${key}`)
    } catch (error) {
      lastError = error
      if (host === TEN_KLINE && !tencentKlinePrimaryDown) tencentKlinePrimaryDown = true
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`腾讯K线获取失败: ${key}`)
}

interface FflowResponse {
  data?: {
    klines?: string[]
  }
}

/** 最新一日主力资金流向。返回 null 表示无数据 */
export async function fetchMoneyFlow(
  market: StockInfo['market'],
  code: string,
): Promise<MoneyFlow | null> {
  const secid = secidOf(market, code)
  const query = new URLSearchParams({
    secid,
    lmt: '1',
    klt: '101',
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
  })
  let data: FflowResponse
  if (isDev()) {
    data = await fetchJson<FflowResponse>(`/api/fflow?${query.toString()}`, {
      Referer: 'https://quote.eastmoney.com/',
    })
  } else {
    data = await emDirect<FflowResponse>(EM_FFLOW, query)
  }
  const line = data.data?.klines?.[0]
  if (!line) return null
  const p = line.split(',')
  return {
    code,
    date: p[0] ?? '',
    mainNetInflow: Number(p[1] ?? 0),
    bigNetInflow: Number(p[4] ?? 0),
    superNetInflow: Number(p[5] ?? 0),
  }
}

/** 近 N 日主力净流入历史（识别吸筹/出货） */
export async function fetchMoneyFlowHistory(
  market: StockInfo['market'],
  code: string,
  lmt = 5,
): Promise<number[]> {
  const secid = secidOf(market, code)
  const query = new URLSearchParams({
    lmt: String(lmt),
    klt: '101',
    secid,
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
  })
  let data: FflowResponse
  if (isDev()) {
    data = await fetchJson<FflowResponse>(`/api/fflow-history?${query.toString()}`, {
      Referer: 'https://quote.eastmoney.com/',
    })
  } else {
    data = await emDirect<FflowResponse>(EM_FFLOW_HIS, query)
  }
  const klines = data.data?.klines ?? []
  return klines.map((line) => {
    const p = line.split(',')
    return Number(p[1] ?? 0)
  })
}

interface FinancialsResponse {
  result?: {
    data?: Array<Record<string, number | string | null>>
  }
}

function normalizeAsOfDate(value?: string): string | undefined {
  if (!value) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid asOfDate: ${value}`)
  }
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid asOfDate: ${value}`)
  }
  return value
}

/** 获取财务指标；指定 asOfDate 时只取披露日不晚于该日期的报告。 */
export async function fetchFinancials(code: string, asOfDate?: string): Promise<Financials | null> {
  const normalizedAsOf = normalizeAsOfDate(asOfDate)
  const filter = normalizedAsOf
    ? `(SECURITY_CODE="${code}")(NOTICE_DATE<='${normalizedAsOf}')`
    : `(SECURITY_CODE="${code}")`
  const sortColumns = normalizedAsOf ? 'NOTICE_DATE' : 'REPORTDATE'
  const query = new URLSearchParams({
    reportName: 'RPT_LICO_FN_CPD',
    columns: 'ALL',
    filter,
    pageNumber: '1',
    pageSize: '1',
    sortTypes: '-1',
    sortColumns,
  })
  let data: FinancialsResponse
  if (isDev()) {
    const path = `/api/financials?code=${encodeURIComponent(code)}${
      normalizedAsOf ? `&asOfDate=${normalizedAsOf}` : ''
    }`
    data = await fetchJson<FinancialsResponse>(path, {
      Referer: 'https://data.eastmoney.com/',
    })
  } else {
    data = await emDirect<FinancialsResponse>(EM_DATA, query)
  }
  const row = data.result?.data?.[0]
  if (!row) return null
  const num = (v: unknown) => {
    if (v === null || v === undefined || v === '-') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const dateOnly = (v: unknown) => {
    const value = String(v ?? '').slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
  }
  const disclosureDate = dateOnly(row.NOTICE_DATE ?? row.ANN_DATE ?? row.PUBLIC_DATE)
  // 上游接口若忽略时点过滤，宁可放弃该条数据，也不能把未来报告带入历史评分。
  if (normalizedAsOf && (!disclosureDate || disclosureDate > normalizedAsOf)) return null
  return {
    code,
    reportDate: String(row.REPORTDATE ?? ''),
    disclosureDate,
    asOfDate: normalizedAsOf,
    pointInTime: Boolean(normalizedAsOf),
    roe: num(row.WEIGHTAVG_ROE),
    revenueGrowth: num(row.YSTZ),
    profitGrowth: num(row.SJLTZ ?? row.SJLTZGC),
    debtRatio: num(row.ZCFZL),
    grossMargin: num(row.XSMLL),
  }
}

interface ClistResponse {
  data?: {
    total?: number
    diff?: Array<Record<string, number | string | null>>
  }
}

// ─────────────── AI 研报（FastAPI 后端直连，不走 node 代理）───────────────
// 后端地址从 location.hostname 推导：dev=localhost，手机局域网=电脑 IP。
// 端口 8000 对应 ai-server/main.py(FastAPI)。
const AI_BASE = () => {
  const h = location.hostname
  return `http://${h === 'localhost' || h === '127.0.0.1' ? 'localhost' : h}:8000`
}

/** 长超时 fetch(AI 分析单次要 1-3 分钟,默认 90s 等待结果) */
function fetchJsonLong<T>(
  url: string,
  init?: RequestInit,
  timeout = 90000,
): Promise<T> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeout),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
    return res.json() as Promise<T>
  })
}

/** 启动一次 AI 分析，返回 job_id */
export function startAIReport(code: string, date?: string): Promise<{ job_id: string }> {
  return fetchJsonLong<{ job_id: string }>(
    `${AI_BASE()}/api/ai-report`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, date }),
    },
    20000,
  )
}

/** 轮询任务进度 */
export function pollAIReportJob(jobId: string): Promise<AIJobInfo> {
  return fetchJsonLong<AIJobInfo>(`${AI_BASE()}/api/ai-report/${jobId}`, {}, 15000)
}

/** 任务完成后取完整研报 */
export function fetchAIReportResult(jobId: string): Promise<AIReport> {
  return fetchJsonLong<AIReport>(`${AI_BASE()}/api/ai-report/${jobId}/result`)
}
