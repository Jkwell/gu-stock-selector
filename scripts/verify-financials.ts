/** 财务数据历史时点查询验证；不访问网络，使用 mock fetch 检查查询约束。 */
import { fetchFinancials } from '../src/data/api'

let pass = true
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) pass = false
}

const originalFetch = globalThis.fetch
const urls: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL) => {
  urls.push(String(input))
  return {
    ok: true,
    json: async () => ({
      result: {
        data: [{
          REPORTDATE: '2024-09-30',
          NOTICE_DATE: '2024-10-31',
          WEIGHTAVG_ROE: '12.5',
          YSTZ: '8.1',
          SJLTZ: '10.2',
          ZCFZL: '42.0',
          XSMLL: '26.0',
        }],
      },
    }),
  } as Response
}) as typeof fetch

try {
  console.log('=== 1. 历史时点查询 ===')
  const historical = await fetchFinancials('600519', '2024-12-31')
  const historicalUrl = decodeURIComponent(urls[0] ?? '')
  check('返回时点元数据', historical?.pointInTime === true && historical.asOfDate === '2024-12-31')
  check('保留披露日期', historical?.disclosureDate === '2024-10-31')
  check('请求按披露日过滤', historicalUrl.includes("NOTICE_DATE<='2024-12-31'"), historicalUrl)
  check('请求按披露日倒序', historicalUrl.includes('sortColumns=NOTICE_DATE'))

  console.log('=== 2. 实盘最新快照兼容 ===')
  const latest = await fetchFinancials('600519')
  const latestUrl = decodeURIComponent(urls[1] ?? '')
  check('最新快照不标记为时点数据', latest?.pointInTime === false && latest.asOfDate === undefined)
  check('最新快照仍按报告期排序', latestUrl.includes('sortColumns=REPORTDATE'))
  check('最新快照不附加披露日过滤', !latestUrl.includes('NOTICE_DATE<='))

  console.log('=== 3. 日期参数校验 ===')
  let rejected = false
  try {
    await fetchFinancials('600519', '2024-02-30')
  } catch {
    rejected = true
  }
  check('拒绝无效日期', rejected)

  console.log('=== 4. 严格防未来数据 ===')
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ result: { data: [{ REPORTDATE: '2025-03-31', WEIGHTAVG_ROE: '20' }] } }),
  })) as typeof fetch
  const unverifiable = await fetchFinancials('600519', '2024-12-31')
  check('缺少披露日时拒绝历史报告', unverifiable === null)
} finally {
  globalThis.fetch = originalFetch
}

console.log(pass ? '\n✅ 财务时点查询验证通过' : '\n❌ 财务时点查询验证失败')
if (!pass) process.exit(1)
