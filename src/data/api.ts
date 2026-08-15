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
 * 本地开发：走 /api/* 代理（Vite proxy → proxy/index.mjs，有缓存/降级）
 * 生产部署：直连数据源（所有接口已验证 CORS 允许，无需代理）
 */

// ---- 数据源直连 URL（生产环境） ----
const TEN_QUOTE = 'https://qt.gtimg.cn/q=' // 腾讯实时行情（GBK）
const TEN_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const TEN_MINUTE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query'
const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
const EM_FFLOW = 'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get'
const EM_FFLOW_HIS = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get'
const EM_DATA = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const SINA_LIST =
  'http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'

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

function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  return fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(15000),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
    return res.json() as Promise<T>
  })
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
        concept: d.f128 ? String(d.f128) : undefined,
        price: toNum(d.f2),
        changePct: toNum(d.f3),
        totalMv: toNum(d.f20),
        floatMv: toNum(d.f21),
        pe: pe !== undefined && pe > 0 ? pe : undefined,
        pb: pb !== undefined && pb > 0 ? pb : undefined,
        turnoverRate: toNum(d.f8),
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
export async function fetchStockList(
  pool: 'all' | 'hs300' | 'zz500' = 'all',
): Promise<StockInfo[]> {
  const fs =
    pool === 'all'
      ? 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23' // 深主板+创业板+沪主板+科创板
      : pool === 'hs300'
        ? 'b:BK0500'
        : 'b:BK0701'
  const fields = 'f2,f3,f8,f9,f12,f13,f14,f20,f21,f23,f100,f128'
  const all: StockInfo[] = []
  const seen = new Set<string>() // 按代码去重，防止代理兜底缓存重复页导致候选池重复
  const pz = 100 // 东财 clist 单页上限 100
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
    if (!isDev()) params.set('ut', 'bd1d9ddb04089700cf9c27f6f7426281') // 板块查询需 ut
    const url = isDev()
      ? `/api/clist?${params.toString()}`
      : `${EM_CLIST}?${params.toString()}`
    const data = await fetchJson<ClistResponse>(url, {
      Referer: 'https://quote.eastmoney.com/',
    })
    const list = data.data?.diff ?? []
    for (const s of parseClistDiff(list)) {
      if (seen.has(s.code)) continue
      seen.add(s.code)
      all.push(s)
    }
    const total = Number(data.data?.total ?? 0)
    if (all.length >= total || list.length === 0 || page > 40) break
    page++
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
      const url = dev(`/sina-list?nodes=${nodes.join(',')}`)
      let rows: any[] = []
      if (isDev()) {
        const d = await fetchJson<any>(url)
        rows = d?.data?.diff ?? []
      } else {
        rows = await fetchJson<any>(`${SINA_LIST}?${params.toString()}`, {
          Referer: 'http://vip.stock.finance.sina.com.cn/',
        })
      }
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

/** 历史日 K 线（前复权），lmt 控制根数 */
export async function fetchKline(
  market: StockInfo['market'],
  code: string,
  lmt = 160,
): Promise<Kline[]> {
  const key = `${market === 'sh' ? 'sh' : 'sz'}${code}`
  const url = isDev()
    ? `/api/kline?market=${market}&code=${code}&lmt=${lmt}`
    : `${TEN_KLINE}?param=${encodeURIComponent(`${key},day,,,${lmt},qfq`)}`
  const data = await fetchJson<TencentKlineResponse>(url, { Referer: 'https://gu.qq.com/' })
  const node = data.data?.[key]
  const rows = node?.qfqday ?? node?.day ?? []
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
  const query = `secid=${secid}&lmt=1&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`
  const url = isDev() ? `/api/fflow?${query}` : `${EM_FFLOW}?${query}`
  const data = await fetchJson<FflowResponse>(url, { Referer: 'https://quote.eastmoney.com/' })
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
  const query = `lmt=${lmt}&klt=101&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`
  const url = isDev() ? `/api/fflow-history?${query}` : `${EM_FFLOW_HIS}?${query}`
  const data = await fetchJson<FflowResponse>(url, { Referer: 'https://quote.eastmoney.com/' })
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
  const url = isDev()
    ? `/api/financials?code=${encodeURIComponent(code)}${normalizedAsOf ? `&asOfDate=${normalizedAsOf}` : ''}`
    : `${EM_DATA}?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=${encodeURIComponent(
        filter,
      )}&pageNumber=1&pageSize=1&sortTypes=-1&sortColumns=${sortColumns}`
  const data = await fetchJson<FinancialsResponse>(url, {
    Referer: 'https://data.eastmoney.com/',
  })
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
