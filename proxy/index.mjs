/**
 * 本地代理服务（Node 原生实现，零依赖）
 * 作用：转发东方财富接口，加 CORS 头，解决浏览器跨域限制。
 * 启动：npm run proxy  →  监听 127.0.0.1:8787
 * 前端开发环境通过 Vite proxy 将 /api/* 转发到这里。
 *
 * 部署到 Cloudflare Worker / Vercel Edge 时，
 * 将本文件的路由与 CORS 逻辑平移即可（使用 fetch + Request/Response）。
 */

import http from 'node:http'
import { URL } from 'node:url'

const PORT = 8787

/** 路由表：前端路径 → 上游接口 */
const ROUTES = {
  '/clist': 'https://push2.eastmoney.com/api/qt/clist/get',
  '/kline': 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
  '/fflow': 'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get',
  '/fflow-history': 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get',
  '/financials': 'https://datacenter-web.eastmoney.com/api/data/v1/get',
  '/minute': 'https://web.ifzq.gtimg.cn/appstock/app/minute/query',
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// 内存缓存（push2 偶发限流时降级，股票列表变化不大）
const memCache = new Map()

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const path = url.pathname

  // 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  // ---- /quote：腾讯实时行情（批量、GBK 解码、返回 JSON） ----
  if (path === '/quote' && req.method === 'GET') {
    await handleQuote(url, res)
    return
  }

  // ---- /sina-list：新浪全市场快照（东财 clist 的降级替代） ----
  if (path === '/sina-list' && req.method === 'GET') {
    await handleSinaList(url, res)
    return
  }

  const target = ROUTES[path]
  if (!target || req.method !== 'GET') {
    res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 404, msg: 'not found' }))
    return
  }

  try {
    let upstream

    if (path === '/financials') {
      // 构造东方财富 datacenter 财务接口
      const code = url.searchParams.get('code') ?? ''
      const asOfDate = url.searchParams.get('asOfDate') ?? ''
      const parsedAsOf = asOfDate ? new Date(`${asOfDate}T00:00:00Z`) : null
      const validAsOf = !asOfDate || (
        /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) &&
        !Number.isNaN(parsedAsOf?.getTime()) &&
        parsedAsOf?.toISOString().slice(0, 10) === asOfDate
      )
      if (!/^\d{6}$/.test(code) || !validAsOf) {
        res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 400, msg: 'invalid financials query' }))
        return
      }
      const filter = asOfDate
        ? `(SECURITY_CODE="${code}")(NOTICE_DATE<='${asOfDate}')`
        : `(SECURITY_CODE="${code}")`
      const params = new URLSearchParams({
        reportName: 'RPT_LICO_FN_CPD',
        columns: 'ALL',
        filter,
        pageNumber: '1',
        pageSize: '1',
        sortTypes: '-1',
        sortColumns: asOfDate ? 'NOTICE_DATE' : 'REPORTDATE',
      })
      upstream = `${target}?${params.toString()}`
    } else if (path === '/kline') {
      // 构造腾讯日K线接口（前复权）
      const market = url.searchParams.get('market') ?? 'sh'
      const code = url.searchParams.get('code') ?? ''
      const lmt = url.searchParams.get('lmt') ?? '160'
      const prefix = market === 'sh' ? 'sh' : 'sz'
      const param = `${prefix}${code},day,,,${lmt},qfq`
      upstream = `${target}?param=${encodeURIComponent(param)}`
    } else if (path === '/minute') {
      // 腾讯分时图：code=sh600519
      const code = url.searchParams.get('code') ?? ''
      upstream = `${target}?code=${encodeURIComponent(code)}`
    } else if (path === '/clist') {
      // 透传 + 附加网页端 ut token（板块查询必需）
      const params = new URLSearchParams(url.searchParams)
      if (!params.has('ut')) {
        params.set('ut', 'bd1d9ddb04089700cf9c27f6f7426281')
      }
      upstream = `${target}?${params.toString()}`
    } else {
      // 透传 query
      upstream = `${target}?${url.searchParams.toString()}`
    }

    const resp = await fetch(upstream, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://quote.eastmoney.com/',
        Accept: 'application/json, text/plain, */*',
      },
      signal: AbortSignal.timeout(15000),
    })

    const text = await resp.text()
    // 缓存 clist 响应（push2 偶发限流时降级）
    // 按完整请求参数区分，避免不同页/不同查询共用同一缓存
    if (path === '/clist' && resp.ok) {
      memCache.set(`clist:${url.search}`, { text, time: Date.now() })
    }
    res.writeHead(resp.status, {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
    })
    res.end(text)
  } catch (err) {
    // clist 降级：返回该请求对应参数的缓存（push2 限流时，10 分钟内可用）
    if (path === '/clist') {
      const cached = memCache.get(`clist:${url.search}`)
      if (cached && Date.now() - cached.time < 600000) {
        res.writeHead(200, {
          ...corsHeaders(),
          'Content-Type': 'application/json; charset=utf-8',
        })
        res.end(cached.text)
        return
      }
    }
    res.writeHead(502, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 502, msg: String(err) }))
  }
})

/**
 * 腾讯实时行情：qt.gtimg.cn/q=sh600519,sz000858
 * 返回 GBK 编码、~ 分隔，解析后输出 JSON。
 * 字段索引：1=名称 2=代码 3=当前价 32=涨跌幅% 33=最高 34=最低 38=换手率
 */
async function handleQuote(url, res) {
  try {
    const codes = url.searchParams.get('codes') ?? ''
    if (!codes) {
      res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 400, msg: 'missing codes' }))
      return
    }
    // 限制批量数量，防止滥用
    const codeList = codes.split(',').slice(0, 50)
    const resp = await fetch(
      `https://qt.gtimg.cn/q=${codeList.join(',')}`,
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://gu.qq.com/',
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(10000),
      },
    )
    const buf = new Uint8Array(await resp.arrayBuffer())
    // Node 完整 ICU 支持 GBK 解码
    let text
    try {
      text = new TextDecoder('gbk').decode(buf)
    } catch {
      text = new TextDecoder('utf-8').decode(buf) // 降级
    }
    const quotes = []
    const re = /v_(\w+?)="([^"]+)"/g
    let m
    while ((m = re.exec(text)) !== null) {
      const fields = m[2].split('~')
      const code = fields[2]
      const num = (v) => {
        const n = Number(v)
        return Number.isFinite(n) ? n : undefined
      }
      quotes.push({
        code,
        name: fields[1] || code,
        price: num(fields[3]),
        changePct: num(fields[32]),
        high: num(fields[33]),
        low: num(fields[34]),
        turnover: num(fields[38]),
      })
    }
    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(quotes))
  } catch (err) {
    res.writeHead(502, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 502, msg: String(err) }))
  }
}

/**
 * 新浪全市场快照（东财 clist 降级替代）
 * 分页拉沪A(sh_a)/深A(sz_a)/北交所(bj_a)，返回统一 JSON
 * 字段：code name price changePct turnover pe pb totalMv floatMv
 */
async function handleSinaList(url, res) {
  try {
    const nodes = url.searchParams.get('nodes')?.split(',') ?? ['sh_a', 'sz_a']
    const pageSize = 100
    const all = []
    for (const node of nodes) {
      let page = 1
      for (;;) {
        const api = `http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=${pageSize}&sort=symbol&asc=1&node=${node}`
        const resp = await fetch(api, {
          headers: {
            'User-Agent': UA,
            Referer: 'http://vip.stock.finance.sina.com.cn/',
            Accept: '*/*',
          },
          signal: AbortSignal.timeout(15000),
        })
        if (!resp.ok) throw new Error(`sina ${node} page ${page} HTTP ${resp.status}`)
        const text = await resp.text()
        let rows
        try {
          rows = JSON.parse(text)
        } catch {
          rows = []
        }
        if (!Array.isArray(rows) || rows.length === 0) break
        for (const r of rows) {
          const code = String(r.code ?? '')
          if (!code) continue
          const num = (v) => {
            const n = Number(v)
            return Number.isFinite(n) ? n : undefined
          }
          all.push({
            code,
            name: String(r.name ?? code),
            market: node.startsWith('sh') ? 'sh' : node.startsWith('sz') ? 'sz' : 'bj',
            price: num(r.trade),
            changePct: num(r.changepercent),
            totalMv: num(r.mktcap) ? num(r.mktcap) * 10000 : undefined, // 万→元
            floatMv: num(r.nmc) ? num(r.nmc) * 10000 : undefined,
            pe: num(r.per),
            pb: num(r.pb),
            turnoverRate: num(r.turnoverratio),
          })
        }
        if (rows.length < pageSize) break
        page++
      }
    }
    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ data: { total: all.length, diff: all } }))
  } catch (err) {
    res.writeHead(502, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 502, msg: String(err) }))
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] listening on http://127.0.0.1:${PORT}`)
})
