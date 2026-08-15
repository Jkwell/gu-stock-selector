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
import {
  computeTradingSignal,
  DEFAULT_MIN_RISK_REWARD,
  isOneWordLimitUp,
} from '../engine/tradingSignals'
import { pickConceptLeaders } from '../engine/conceptLeader'
import { filterByQuickRules, filterByVolumeRatio, isUptrend } from '../engine/quickRules'
import { computeMarketSentiment, type MarketSentiment } from '../engine/marketSentiment'
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

export type CandidateConfig = Pick<SelectConfig, 'candidatePool' | 'candidateCount'>

/**
 * 构造候选池：实盘选股以配置排序为主，同时从其他排序补充样本，
 * 避免单一的今日涨幅/换手/市值排序把潜在标的提前截掉。
 */
export function selectCandidatePool(
  stocks: StockInfo[],
  config: CandidateConfig,
  mixSources: boolean,
): StockInfo[] {
  const byMomentum = (a: StockInfo, b: StockInfo) =>
    (b.changePct ?? -999) - (a.changePct ?? -999)
  const byLiquid = (a: StockInfo, b: StockInfo) =>
    (b.floatMv ?? 0) - (a.floatMv ?? 0)
  const byTurnover = (a: StockInfo, b: StockInfo) =>
    (b.turnoverRate ?? 0) - (a.turnoverRate ?? 0)
  const byMcap = (a: StockInfo, b: StockInfo) =>
    (b.totalMv ?? 0) - (a.totalMv ?? 0)
  const sorters = { momentum: byMomentum, liquid: byLiquid, turnover: byTurnover, marketcap: byMcap }
  const primary = sorters[config.candidatePool]
  const selected: StockInfo[] = []
  const seen = new Set<string>()
  const add = (items: StockInfo[], limit: number) => {
    const target = Math.min(config.candidateCount, selected.length + limit)
    for (const s of items) {
      if (selected.length >= target) break
      if (seen.has(s.code)) continue
      seen.add(s.code)
      selected.push(s)
    }
  }

  const sortedBy = (sort: (a: StockInfo, b: StockInfo) => number) => [...stocks].sort(sort)
  const primarySorted = sortedBy(primary)
  if (!mixSources) {
    return primarySorted.slice(0, config.candidateCount)
  }

  const primaryQuota = Math.max(1, Math.floor(config.candidateCount * 0.7))
  add(primarySorted, primaryQuota)
  const alternates = Object.values(sorters).filter((sort) => sort !== primary)
  const alternateQuota = Math.max(1, Math.floor(config.candidateCount * 0.1))
  for (const sort of alternates) add(sortedBy(sort), alternateQuota)
  add(primarySorted, config.candidateCount)
  return selected.slice(0, config.candidateCount)
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

  all = filterBySelectionConfig(all, config)

  const candidates = selectCandidatePool(all, config, false)

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
  // 优先读缓存（盘中 5 分钟内）
  const cached = await stockListCache.get(pool)
  if (cached && cached.length > 0) return dedupeByCode(cached)
  try {
    // 优先东财（有行业/概念字段）
    const list = await fetchStockList(pool)
    await stockListCache.set(list, pool)
    return list
  } catch {
    // 新浪只有全市场快照，没有沪深300/中证500成分字段，不能冒充指数池。
    if (pool === 'all') {
      try {
        console.warn('⚠ 东财 clist 不可用，降级到新浪数据源')
        const list = await fetchStockListSina()
        if (list.length > 0) {
          await stockListCache.set(list, pool)
          return list
        }
      } catch {
        // 新浪也失败，继续降级
      }
    }
    // 降级2：尝试用过期的缓存数据
    const stale = await stockListCache.getStale(pool)
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

/** 所有策略共用的基础可交易过滤，避免特殊策略绕过用户配置。 */
export function filterBySelectionConfig(
  stocks: StockInfo[],
  config: Pick<
    SelectConfig,
    'excludeST' | 'excludeKcb' | 'excludeCyb' | 'sector' | 'minMvYiyi'
  >,
): StockInfo[] {
  const minMv = config.minMvYiyi * 1e8
  return stocks.filter((s) => {
    if (config.excludeST && /ST|退/.test(s.name)) return false
    if (config.excludeKcb && s.code.startsWith('688')) return false
    if (config.excludeCyb && /^(300|301)/.test(s.code)) return false
    if (config.sector && config.sector !== 'all' && s.industry !== config.sector) return false
    if (minMv > 0 && (s.totalMv ?? 0) < minMv) return false
    return true
  })
}

/**
 * 拉取全市场快照（情绪/板块分析用，不经过选股过滤）
 * 盘中短缓存（5 分钟），避免情绪和题材榜使用过时快照
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
  all = filterBySelectionConfig(all, config)

  // ---- 候选池排序：实盘使用多来源合并，降低单一排序截断偏差 ----
  const candidates = selectCandidatePool(all, config, true)

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

  let marketSnapshot: StockInfo[] | null = null
  let marketState: MarketSentiment | undefined
  let marketGateWarning: string | undefined
  let tradeFilterWarning: string | undefined
  const minRiskReward = Math.max(
    0,
    pickConfig.minRiskReward ?? DEFAULT_MIN_RISK_REWARD,
  )
  const now = new Date()
  const h = now.getHours()
  const m = now.getMinutes()
  const isTailPeriod = (h === 14 && m >= 30) || h === 15

  // 市场冰点时暂停自动推荐，避免个股评分掩盖系统性风险；数据失败则放行但明确提示。
  if (pickConfig.marketGate !== false) {
    onProgress({ stage: 'list', done: 0, total: 1, message: '检查市场情绪…' })
    try {
      marketSnapshot = await fetchMarketStocks()
      marketState = computeMarketSentiment(marketSnapshot)
      onProgress({ stage: 'list', done: 1, total: 1, message: `市场情绪 ${marketState.temperature}°` })
      if (marketState.level === 'cold') {
        onProgress({ stage: 'done', done: 1, total: 1, message: '市场处于冰点，暂停今日推荐' })
        return {
          picks: [],
          computedAt: now.toISOString(),
          isTailPeriod,
          marketTemperature: marketState.temperature,
          marketLevel: marketState.level,
          gateReason: `市场情绪 ${marketState.temperature}°（冰点），今日暂停自动推荐`,
        }
      }
    } catch {
      marketGateWarning = '市场情绪数据暂时不可用，本次未执行情绪门控'
    }
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

  let topCandidates: StockScore[]
  if (isGentleVolume) {
    // 温和放量规则：基础过滤 → 量比/趋势硬筛 → 完整五因子评分 → Top 4
    onProgress({ stage: 'list', done: 0, total: 1, message: '应用量比/换手筛选…' })
    const market = marketSnapshot ?? await fetchMarketStocks()
    const eligible = filterBySelectionConfig(market, pickConfig)
    const quickFiltered = filterByQuickRules(eligible)
    onProgress({ stage: 'list', done: 1, total: 1, message: `快筛后 ${quickFiltered.length} 只，算量比…` })
    const requireTrend = pickConfig.requireUptrend !== false // 默认要求上升趋势
    const qualified: ScoringInput[] = []
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
        kline.length >= 70 &&
        filterByVolumeRatio(kline) &&
        (!requireTrend || isUptrend(kline))
      ) {
        qualified.push({ info: s, kline })
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
    // 资金流是模板因子之一，先补齐快筛通过者，再按真实因子分排序。
    let moneyDone = 0
    await mapLimit(qualified, concurrency, async (input) => {
      let moneyFlow = await moneyflowCache.get(input.info.code)
      if (!moneyFlow) {
        try {
          moneyFlow = await fetchMoneyFlow(input.info.market, input.info.code)
        } catch {
          moneyFlow = null
        }
        if (moneyFlow) await moneyflowCache.set(input.info.code, moneyFlow)
      }
      if (moneyFlow) input.moneyFlow = moneyFlow
      moneyDone++
      if (moneyDone % 25 === 0 || moneyDone === qualified.length) {
        onProgress({ stage: 'moneyflow', done: moneyDone, total: qualified.length, message: `补充资金流 ${moneyDone}/${qualified.length}…` })
      }
    })
    onProgress({ stage: 'scoring', done: 0, total: 1, message: '温和放量因子评分…' })
    let scored = await scoreWithWorker(qualified, pickConfig.factors)
    scored = diversifyPortfolio(scored, pickConfig.maxPerIndustry)
    topCandidates = scored.slice(0, 12)
  } else if (isConceptLeader) {
    onProgress({ stage: 'list', done: 0, total: 1, message: '分析热点概念题材…' })
    const market = marketSnapshot ?? await fetchMarketStocks()
    const eligible = filterBySelectionConfig(market, pickConfig)
    const leaders = pickConceptLeaders(eligible, 12) // 先取候选，后续再按可成交性补足 Top 4
    topCandidates = leaders.slice(0, 12).map((s, i) => ({
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
    topCandidates = scored.slice(0, 12)
  }

  onProgress({ stage: 'done', done: 0, total: topCandidates.length, message: '计算买卖点…' })

  // 强势领涨模板 → 短线模式（MA5 回踩）
  const shortMode = pickConfig.factors.some(
    (f) => f.enabled && (f.key === 'short_momentum' || f.key === 'breakout'),
  )

  // 对候选强制拉最新 K 线（绕过缓存，确保最后一根是尾盘实时价）
  const picks: DailyPick[] = []
  let rejectedOneWord = 0
  let rejectedRiskReward = 0
  for (let i = 0; i < topCandidates.length; i++) {
    const s = topCandidates[i]
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
        if (oneWord) {
          rejectedOneWord++
        } else if (signal.riskReward < minRiskReward) {
          rejectedRiskReward++
        } else if (picks.length < 4) {
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
    }
    onProgress({
      stage: 'done',
      done: i + 1,
      total: topCandidates.length,
      message: `计算买卖点 ${i + 1}/${topCandidates.length}…`,
    })
  }

  const filterNotes: string[] = []
  if (rejectedOneWord > 0) filterNotes.push(`剔除一字板 ${rejectedOneWord} 只`)
  if (rejectedRiskReward > 0) filterNotes.push(`剔除风险回报比低于 ${minRiskReward.toFixed(1)} 的 ${rejectedRiskReward} 只`)
  tradeFilterWarning = filterNotes.length > 0 ? filterNotes.join('，') : undefined

  return {
    picks,
    computedAt: now.toISOString(),
    isTailPeriod,
    marketTemperature: marketState?.temperature,
    marketLevel: marketState?.level,
    gateReason: [marketGateWarning, tradeFilterWarning].filter(Boolean).join('；') || undefined,
  }
}
