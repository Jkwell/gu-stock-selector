import type {
  DailyPick,
  DailyPickResult,
  Kline,
  SelectionResult,
  SelectConfig,
  StockInfo,
  StockScore,
} from '../types'
import { scoreStocks, type ScoringInput } from '../engine/factors'
import { diversifyPortfolio } from '../engine/portfolio'
import { computeTradingSignal, isOneWordLimitUp } from '../engine/tradingSignals'
import { pickConceptLeaders } from '../engine/conceptLeader'
import { filterByQuickRules, filterByVolumeRatio, isUptrend } from '../engine/quickRules'
import type { FactorDef } from '../types'
import {
  fetchFinancials,
  fetchKline,
  fetchMoneyFlow,
  fetchMoneyFlowHistory,
  fetchStockList,
  fetchStockListSina,
} from './api'
import {
  financialsCache,
  klineCache,
  moneyflowCache,
  stockListCache,
} from './cache'

/** 流水线进度回调 */
export interface PipelineProgress {
  stage: 'list' | 'kline' | 'fundamental' | 'moneyflow' | 'scoring' | 'done'
  done: number
  total: number
  message: string
}

/**
 * 通过 Web Worker 打分（不阻塞 UI）。
 * 非浏览器环境（无 Worker）降级为同步调用。
 */
function scoreWithWorker(
  inputs: ScoringInput[],
  factors: FactorDef[],
): Promise<StockScore[]> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(scoreStocks(inputs, factors))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/scoring.worker.ts', import.meta.url),
      { type: 'module' },
    )
    const timeout = setTimeout(() => {
      worker.terminate()
      reject(new Error('打分 Worker 超时'))
    }, 30000)
    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: StockScore[]; error?: string }>) => {
      clearTimeout(timeout)
      worker.terminate()
      if (e.data.ok) resolve(e.data.result ?? [])
      else reject(new Error(e.data.error ?? '打分失败'))
    }
    worker.onerror = (e) => {
      clearTimeout(timeout)
      worker.terminate()
      reject(new Error(e.message ?? '打分 Worker 错误'))
    }
    worker.postMessage({ inputs, factors })
  })
}

/** 带 K 线的股票（供 IC 分析/回测使用） */
export interface KlineStock {
  code: string
  name: string
  kline: Kline[]
}

/**
 * 加载候选股票池的 K 线（供 IC 分析、回测等使用）
 * @param config 需要 pool/candidatePool/candidateCount/过滤字段
 * @param opts concurrency、onProgress
 */
export async function loadKlineStocks(
  config: Pick<
    SelectConfig,
    | 'pool'
    | 'candidatePool'
    | 'candidateCount'
    | 'excludeST'
    | 'excludeKcb'
    | 'excludeCyb'
    | 'sector'
    | 'minMvYiyi'
  >,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<KlineStock[]> {
  const concurrency = opts.concurrency ?? 8
  let all = await getStockList(config.pool)

  const minMv = config.minMvYiyi * 1e8
  all = all.filter((s) => {
    if (config.excludeST && /ST|退/.test(s.name)) return false
    if (config.excludeKcb && s.code.startsWith('688')) return false
    if (config.excludeCyb && /^(300|301)/.test(s.code)) return false
    if (config.sector && config.sector !== 'all' && s.industry !== config.sector) return false
    if (minMv > 0 && (s.totalMv ?? 0) < minMv) return false
    return true
  })

  const byMomentum = (a: StockInfo, b: StockInfo) =>
    (b.changePct ?? -999) - (a.changePct ?? -999)
  const byLiquid = (a: StockInfo, b: StockInfo) =>
    (b.floatMv ?? 0) - (a.floatMv ?? 0)
  const byTurnover = (a: StockInfo, b: StockInfo) =>
    (b.turnoverRate ?? 0) - (a.turnoverRate ?? 0)
  const byMcap = (a: StockInfo, b: StockInfo) =>
    (b.totalMv ?? 0) - (a.totalMv ?? 0)
  const sortFn =
    config.candidatePool === 'momentum'
      ? byMomentum
      : config.candidatePool === 'turnover'
        ? byTurnover
        : config.candidatePool === 'liquid'
          ? byLiquid
          : byMcap
  const candidates = all.sort(sortFn).slice(0, config.candidateCount)

  const out: KlineStock[] = []
  let done = 0
  await mapLimit(candidates, concurrency, async (s) => {
    let kline = await klineCache.get(s.code)
    if (!kline) {
      try {
        kline = await fetchKline(s.market, s.code, 160)
      } catch {
        kline = []
      }
      if (kline.length > 0) await klineCache.set(s.code, kline)
    }
    if (kline.length > 0) out.push({ code: s.code, name: s.name, kline })
    done++
    if (done % 10 === 0 || done === candidates.length) opts.onProgress?.(done, candidates.length)
  })
  return out
}

/** 简单并发池：依次消费任务，最多 concurrent 个同时进行 */
async function mapLimit<T, R>(
  items: T[],
  concurrent: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrent, items.length) }, () => run()),
  )
  return results
}

async function getStockList(pool: SelectConfig['pool']): Promise<StockInfo[]> {
  // 优先读缓存（12小时内）
  const cached = await stockListCache.get()
  if (cached && cached.length > 0) return dedupeByCode(cached)
  try {
    // 优先东财（有行业/概念字段）
    const list = await fetchStockList(pool)
    await stockListCache.set(list)
    return list
  } catch {
    // 降级1：尝试新浪全市场快照（无行业/概念，但价格/市值/PE 齐全）
    try {
      console.warn('⚠ 东财 clist 不可用，降级到新浪数据源')
      const list = await fetchStockListSina()
      if (list.length > 0) {
        await stockListCache.set(list)
        return list
      }
    } catch {
      // 新浪也失败，继续降级
    }
    // 降级2：尝试用过期的缓存数据
    const stale = await stockListCache.getStale()
    if (stale && stale.length > 0) {
      console.warn('⚠ 数据源均不可用，使用过期缓存股票列表')
      return dedupeByCode(stale)
    }
    throw new Error('数据源暂时不可用（东财/新浪均失败），请稍后重试。')
  }
}

/** 按代码去重，防止旧缓存/异常数据含重复代码进入候选池 */
function dedupeByCode(stocks: StockInfo[]): StockInfo[] {
  const seen = new Set<string>()
  const out: StockInfo[] = []
  for (const s of stocks) {
    if (seen.has(s.code)) continue
    seen.add(s.code)
    out.push(s)
  }
  return out
}

/**
 * 拉取全市场快照（情绪/板块分析用，不经过选股过滤）
 * 盘中刷新频率低（缓存 12 小时），情绪分析足够
 */
export async function fetchMarketStocks(): Promise<StockInfo[]> {
  return getStockList('all')
}

/** 获取行业列表（去重排序），供板块下拉框使用 */
export async function fetchSectorList(): Promise<string[]> {
  const stocks = await fetchMarketStocks()
  const sectors = new Set<string>()
  for (const s of stocks) {
    if (s.industry) sectors.add(s.industry)
  }
  return [...sectors].sort((a, b) => a.localeCompare(b, 'zh'))
}

export interface RunOptions {
  onProgress?: (p: PipelineProgress) => void
  /** 并发数（用于测试/调优） */
  concurrency?: number
}

interface LoadedInputs {
  inputs: ScoringInput[]
  totalScanned: number
  skipped: number
}

/**
 * 共享数据加载：拉列表 → 过滤 → 候选池 → 拉 K 线/财务/资金流（带缓存）。
 * runSelection 与 runDailyPick 共用。
 */
async function loadScoringInputs(
  config: SelectConfig,
  onProgress: (p: PipelineProgress) => void,
  concurrency: number,
): Promise<LoadedInputs> {
  const enableFund = config.factors.some(
    (f) => f.enabled && (f.key === 'profitability' || f.key === 'growth'),
  )
  const enableMoney = config.factors.some(
    (f) => f.enabled && f.key === 'moneyflow',
  )
  const enableMoney5d = config.factors.some(
    (f) => f.enabled && f.key === 'moneyflow_5d',
  )

  onProgress({ stage: 'list', done: 0, total: 1, message: '获取股票列表…' })
  let all = await getStockList(config.pool)
  onProgress({ stage: 'list', done: 1, total: 1, message: `共 ${all.length} 只` })

  // ---- 过滤 ----
  const minMv = config.minMvYiyi * 1e8
  all = all.filter((s) => {
    if (config.excludeST && /ST|退/.test(s.name)) return false
    if (config.excludeKcb && s.code.startsWith('688')) return false
    if (config.excludeCyb && /^(300|301)/.test(s.code)) return false
    if (config.sector && config.sector !== 'all' && s.industry !== config.sector) return false
    if (minMv > 0 && (s.totalMv ?? 0) < minMv) return false
    return true
  })

  // ---- 候选池排序 ----
  const byMomentum = (a: StockInfo, b: StockInfo) =>
    (b.changePct ?? -999) - (a.changePct ?? -999)
  const byLiquid = (a: StockInfo, b: StockInfo) =>
    (b.floatMv ?? 0) - (a.floatMv ?? 0)
  const byTurnover = (a: StockInfo, b: StockInfo) =>
    (b.turnoverRate ?? 0) - (a.turnoverRate ?? 0)
  const byMcap = (a: StockInfo, b: StockInfo) =>
    (b.totalMv ?? 0) - (a.totalMv ?? 0)
  const sortFn =
    config.candidatePool === 'momentum'
      ? byMomentum
      : config.candidatePool === 'turnover'
        ? byTurnover
        : config.candidatePool === 'liquid'
          ? byLiquid
          : byMcap
  const candidates = all.sort(sortFn).slice(0, config.candidateCount)

  const skipped = all.length - candidates.length

  // ---- 并发拉 K 线（带缓存） ----
  const inputs: ScoringInput[] = []
  let klineDone = 0
  await mapLimit(candidates, concurrency, async (s) => {
    let kline = await klineCache.get(s.code)
    if (!kline) {
      try {
        kline = await fetchKline(s.market, s.code, 160)
      } catch {
        kline = []
      }
      if (kline.length > 0) await klineCache.set(s.code, kline)
    }
    if (kline.length > 0) {
      inputs.push({ info: s, kline })
    }
    klineDone++
    if (klineDone % 10 === 0 || klineDone === candidates.length) {
      onProgress({
        stage: 'kline',
        done: klineDone,
        total: candidates.length,
        message: `拉取 K 线 ${klineDone}/${candidates.length}…`,
      })
    }
  })

  // ---- 财务数据（可选） ----
  if (enableFund) {
    const allInputs = [...inputs]
    let fundDone = 0
    await mapLimit(allInputs, concurrency, async (input) => {
      const s = input.info
      let fin = await financialsCache.get(s.code)
      if (!fin) {
        try {
          fin = await fetchFinancials(s.code)
        } catch {
          fin = null
        }
        if (fin) await financialsCache.set(s.code, fin)
      }
      if (fin) input.financials = fin
      fundDone++
      if (fundDone % 10 === 0 || fundDone === allInputs.length) {
        onProgress({
          stage: 'fundamental',
          done: fundDone,
          total: allInputs.length,
          message: `拉取财务数据 ${fundDone}/${allInputs.length}…`,
        })
      }
    })
  }

  // ---- 资金流（可选） ----
  if (enableMoney) {
    const allInputs = [...inputs]
    let mfDone = 0
    await mapLimit(allInputs, concurrency, async (input) => {
      const s = input.info
      let mf = await moneyflowCache.get(s.code)
      if (!mf) {
        try {
          mf = await fetchMoneyFlow(s.market, s.code)
        } catch {
          mf = null
        }
        if (mf) await moneyflowCache.set(s.code, mf)
      }
      if (mf) input.moneyFlow = mf
      // 资金趋势（近5日主力净流入，可选）
      if (enableMoney5d) {
        try {
          const hist = await fetchMoneyFlowHistory(s.market, s.code, 5)
          if (hist.length > 0) input.moneyFlowHistory = hist
        } catch {
          // push2his 间歇性不可用，降级（因子缺席）
        }
      }
      mfDone++
      if (mfDone % 10 === 0 || mfDone === allInputs.length) {
        onProgress({
          stage: 'moneyflow',
          done: mfDone,
          total: allInputs.length,
          message: `拉取资金流 ${mfDone}/${allInputs.length}…`,
        })
      }
    })
  }

  return { inputs, totalScanned: all.length, skipped }
}

/**
 * 执行一次完整选股：
 * 1. 拉全市场快照（缓存）
 * 2. 应用过滤 → 排序 → 取候选池
 * 3. 并发拉 K 线/财务/资金流（带缓存）
 * 4. 多因子打分 → 排序
 */
export async function runSelection(
  config: SelectConfig,
  opts: RunOptions = {},
): Promise<SelectionResult> {
  const onProgress = opts.onProgress ?? (() => {})
  const concurrency = opts.concurrency ?? 8
  const { inputs, totalScanned, skipped } = await loadScoringInputs(
    config,
    onProgress,
    concurrency,
  )

  // ---- 打分（Web Worker 后台执行）----
  onProgress({ stage: 'scoring', done: 0, total: 1, message: '多因子打分…' })
  let scored: StockScore[] = await scoreWithWorker(inputs, config.factors)
  // 组合优化：行业分散
  if (config.diversify) {
    scored = diversifyPortfolio(scored, config.maxPerIndustry)
  }
  scored = scored.slice(0, config.maxResults)
  onProgress({
    stage: 'done',
    done: 1,
    total: 1,
    message: `完成，共 ${scored.length} 只入选`,
  })

  return {
    config,
    scored,
    totalScanned,
    skipped,
    computedAt: new Date().toISOString(),
  }
}

/**
 * 今日推荐：打分选 Top 4，对每只强制拉实时 K 线算买卖点。
 * 尾盘运行可拿到当日实时价，收盘前下单。
 */
export async function runDailyPick(
  config: SelectConfig,
  opts: RunOptions = {},
): Promise<DailyPickResult> {
  const onProgress = opts.onProgress ?? (() => {})
  const concurrency = opts.concurrency ?? 8

  // 今日推荐固定 Top 4 + 强制行业分散
  const pickConfig: SelectConfig = {
    ...config,
    maxResults: 4,
    diversify: true,
  }

  // 识别当前模板类型
  const enabledKeys = new Set(config.factors.filter((f) => f.enabled).map((f) => f.key))
  const isConceptLeader =
    enabledKeys.size === 4 &&
    ['short_momentum', 'breakout', 'volume', 'moneyflow'].every((k) => enabledKeys.has(k))
  // 温和放量模板：volume + short_momentum + moneyflow + trend + macd
  const isGentleVolume =
    enabledKeys.size === 5 &&
    ['volume', 'short_momentum', 'moneyflow', 'trend', 'macd'].every((k) => enabledKeys.has(k))

  let top4: StockScore[]
  if (isGentleVolume) {
    // 温和放量规则：粗筛(换手/涨跌/剔除) → 拉K线精筛量比 → Top 4
    onProgress({ stage: 'list', done: 0, total: 1, message: '应用量比/换手筛选…' })
    const market = await fetchMarketStocks()
    const quickFiltered = filterByQuickRules(market)
    onProgress({ stage: 'list', done: 1, total: 1, message: `快筛后 ${quickFiltered.length} 只，算量比…` })
    const requireTrend = pickConfig.requireUptrend !== false // 默认要求上升趋势
    const qualified: StockInfo[] = []
    let checked = 0
    await mapLimit(quickFiltered, concurrency, async (s) => {
      let kline: Kline[] = []
      try {
        kline = await fetchKline(s.market, s.code, 70) // 需要 60+ 根判断趋势
      } catch {
        kline = []
      }
      // 博主规则①：温和放量；规则②：上升趋势（可选开关，拒绝抄底低位）
      if (
        kline.length >= 60 &&
        filterByVolumeRatio(kline) &&
        (!requireTrend || isUptrend(kline))
      ) {
        qualified.push(s)
      }
      checked++
      if (checked % 50 === 0 || checked === quickFiltered.length) {
        onProgress({
          stage: 'list',
          done: checked,
          total: quickFiltered.length,
          message: `量比/趋势筛选 ${checked}/${quickFiltered.length}…`,
        })
      }
    })
    // 量比合格后按换手率/涨幅排序取 Top 4
    const sorted = [...qualified].sort(
      (a, b) => (b.turnoverRate ?? 0) - (a.turnoverRate ?? 0),
    )
    top4 = sorted.slice(0, 4).map((s, i) => ({
      code: s.code,
      name: s.name,
      market: s.market,
      industry: s.industry,
      concept: s.concept,
      totalScore: 100 - i * 3,
      price: s.price,
      changePct: s.changePct,
      factorScores: [
        {
          key: 'volume_ratio',
          name: '温和放量',
          group: 'technical',
          rawValue: s.turnoverRate ?? 0,
          score: 90,
          weight: 1,
          detail: `换手 ${(s.turnoverRate ?? 0).toFixed(2)}% · 涨跌幅 ${(s.changePct ?? 0).toFixed(2)}% · 满足量比/换手${requireTrend ? '/上升趋势' : ''}`,
        },
      ],
    }))
  } else if (isConceptLeader) {
    onProgress({ stage: 'list', done: 0, total: 1, message: '分析热点概念题材…' })
    const market = await fetchMarketStocks()
    const leaders = pickConceptLeaders(market, 4) // 加权排序取 Top 4（含冷门强势股）
    top4 = leaders.slice(0, 4).map((s, i) => ({
      code: s.code,
      name: s.name,
      market: s.market,
      industry: s.industry,
      concept: s.concept,
      totalScore: 100 - i * 5, // 龙头排序分数（仅展示）
      price: s.price,
      changePct: s.changePct,
      factorScores: [
        {
          key: 'concept',
          name: s.concept ?? '题材',
          group: 'technical',
          rawValue: s.changePct ?? 0,
          score: Math.min(100, (s.changePct ?? 0) * 5 + 50),
          weight: 1,
          detail: `题材龙头 · 今日涨幅 ${(s.changePct ?? 0).toFixed(2)}%`,
        },
      ],
    }))
  } else {
    const { inputs } = await loadScoringInputs(pickConfig, onProgress, concurrency)
    onProgress({ stage: 'scoring', done: 0, total: 1, message: '多因子打分…' })
    let scored = await scoreWithWorker(inputs, pickConfig.factors)
    scored = diversifyPortfolio(scored, pickConfig.maxPerIndustry)
    top4 = scored.slice(0, 4)
  }

  onProgress({ stage: 'done', done: 0, total: 4, message: '计算买卖点…' })

  // 强势领涨模板 → 短线模式（MA5 回踩）
  const shortMode = pickConfig.factors.some(
    (f) => f.enabled && (f.key === 'short_momentum' || f.key === 'breakout'),
  )

  // 对 Top 4 强制拉最新 K 线（绕过缓存，确保最后一根是尾盘实时价）
  const picks: DailyPick[] = []
  for (let i = 0; i < top4.length; i++) {
    const s = top4[i]
    let kline: Kline[] = []
    try {
      kline = await fetchKline(s.market, s.code, 160)
    } catch {
      kline = []
    }
    if (kline.length > 0) {
      const signal = computeTradingSignal(kline, undefined, shortMode)
      if (signal) {
        // 实时涨跌幅（最后一根 vs 前一根）
        const n = kline.length
        const changePct =
          n >= 2 && kline[n - 2].close > 0
            ? ((kline[n - 1].close / kline[n - 2].close - 1) * 100)
            : s.changePct
        // 一字板判断（买不进）
        const isWide = s.code.startsWith('30') || s.code.startsWith('688')
        const oneWord = isOneWordLimitUp(kline, isWide ? 0.2 : 0.1)
        picks.push({
          code: s.code,
          name: s.name,
          industry: s.industry,
          concept: s.concept,
          market: s.market,
          totalScore: s.totalScore,
          factorScores: s.factorScores,
          price: signal.currentPrice,
          changePct: changePct !== undefined ? Number(changePct.toFixed(2)) : undefined,
          buyLow: signal.buyLow,
          buyHigh: signal.buyHigh,
          takeProfit: signal.takeProfit,
          stopLoss: signal.stopLoss,
          riskReward: signal.riskReward,
          reasons: signal.reasons,
          oneWord,
          highRisk: s.highRisk,
        })
      }
    }
    onProgress({
      stage: 'done',
      done: i + 1,
      total: top4.length,
      message: `计算买卖点 ${i + 1}/${top4.length}…`,
    })
  }

  const now = new Date()
  const h = now.getHours()
  const m = now.getMinutes()
  const isTailPeriod = (h === 14 && m >= 30) || h === 15 // 14:30-15:00

  return {
    picks,
    computedAt: now.toISOString(),
    isTailPeriod,
  }
}
