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
import { lastValid, sma } from '../engine/indicators'
import { diversifyPortfolio } from '../engine/portfolio'
import {
  computeTradingSignal,
  isOneWordLimitUp,
  analyzeStabilization,
  computeBuyScore,
} from '../engine/tradingSignals'
import type { TradingSignalBrief } from '../types'
import { pickConceptLeaders } from '../engine/conceptLeader'
import { calcShrinkSurgeScore } from '../engine/shrink-surge-factor'

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
  sectorStrengthMap?: Map<string, number>,
): Promise<StockScore[]> {
  // 注入板块热度到 input（用于 sector_heat 因子）
  if (sectorStrengthMap && sectorStrengthMap.size > 0) {
    for (const input of inputs) {
      const strength = sectorStrengthMap.get(input.info.code)
      if (strength !== undefined) {
        ;(input as any)._sectorStrength = strength
      }
    }
  }

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
  opts: {
    concurrency?: number
    onProgress?: (done: number, total: number) => void
    klineLimit?: number // 拉取K线根数（默认160；回测用更长历史时传大值）
    bypassCache?: boolean // 跳过缓存（长历史与缓存不一致时）
  } = {},
): Promise<KlineStock[]> {
  const concurrency = opts.concurrency ?? 8
  const klineLimit = opts.klineLimit ?? 160
  const bypassCache = opts.bypassCache ?? false
  let all = await getStockList(config.pool)

  all = filterBySelectionConfig(all, config)

  const candidates = selectCandidatePool(all, config, false)

  const out: KlineStock[] = []
  let done = 0
  await mapLimit(candidates, concurrency, async (s) => {
    let kline: Kline[] | null = bypassCache ? null : await klineCache.get(s.code)
    // 缓存长度不足时重新拉取
    if (!kline || kline.length < klineLimit) {
      try {
        kline = await fetchKline(s.market, s.code, klineLimit)
      } catch {
        kline = kline ?? []
      }
      if (kline.length >= klineLimit && !bypassCache) await klineCache.set(s.code, kline)
    }
    if (kline && kline.length > 0) out.push({ code: s.code, name: s.name, kline })
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
  const hasIndustry = (list: StockInfo[] | null) =>
    !!list && list.some((s) => !!s.industry)
  // 优先读缓存（盘中 5 分钟内）——但新浪降级的数据无行业字段，需重试东财
  const cached = await stockListCache.get(pool)
  if (cached && cached.length > 0 && hasIndustry(cached)) return dedupeByCode(cached)
  try {
    // 优先东财（有行业/概念字段）
    const list = await fetchStockList(pool)
    await stockListCache.set(list, pool)
    return list
  } catch {
    // 东财失败：优先用"含行业字段的过期缓存"，避免直接降级到无行业的新浪数据
    const stale = await stockListCache.getStale(pool)
    if (hasIndustry(stale)) {
      console.warn('⚠ 东财 clist 不可用，使用含行业的过期缓存（数据源暂时不可用）')
      return dedupeByCode(stale!)
    }
    // 新浪只有全市场快照，没有行业字段，也没有指数成分字段
    if (pool === 'all') {
      try {
        console.warn('⚠ 东财 clist 不可用，降级到新浪数据源（无行业字段，主数据源不可用）')
        const list = await fetchStockListSina()
        if (list.length > 0) return list // 不写缓存，避免污染（下次仍会重试东财）
      } catch {
        // 新浪也失败，继续降级
      }
    }
    if (cached && cached.length > 0) return dedupeByCode(cached)
    if (stale && stale.length > 0) {
      console.warn('⚠ 数据源均不可用，使用过期缓存股票列表（所有数据源不可用）')
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
/** 行业名称归一化：去除尾部 Ⅱ/Ⅲ/Ⅳ 等后缀 */
function normalizeSector(name: string): string {
  return name.replace(/[ⅡⅢⅣⅤ]$/u, '').trim()
}

export function filterBySelectionConfig(
  stocks: StockInfo[],
  config: Pick<
    SelectConfig,
    'excludeST' | 'excludeKcb' | 'excludeCyb' | 'sector' | 'minMvYiyi'
  >,
): StockInfo[] {
  const minMv = config.minMvYiyi * 1e8
  const targetSector = config.sector && config.sector !== 'all' ? normalizeSector(config.sector) : null
  return stocks.filter((s) => {
    if (config.excludeST && /ST|退/.test(s.name)) return false
    if (config.excludeKcb && s.code.startsWith('688')) return false
    if (config.excludeCyb && /^(300|301)/.test(s.code)) return false
    // 行业模糊匹配（归一化后比较）
    if (targetSector && normalizeSector(s.industry ?? '') !== targetSector) return false
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
    if (s.industry) sectors.add(normalizeSector(s.industry))
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
 * 选股增强：动量阶段过滤 + 板块确认 + 资金方向
 * 1. 排除近5日涨>15%的票（快结束了）
 * 2. 个股得分 × 板块热度系数（好板块才有好票）
 * 3. 主力净流出扣分（资金推动才是真动力）
 */
function enhanceStockSelection(
  scored: StockScore[],
  inputs: ScoringInput[],
  sectorStrengthMap: Map<string, number>,
): StockScore[] {
  const inputMap = new Map(inputs.map(i => [i.info.code, i]))

  for (const s of scored) {
    const input = inputMap.get(s.code)
    if (!input) continue

    let score = s.totalScore

    // 1. 动量阶段过滤：近5日涨幅>15% 大幅降权
    const kline = input.kline
    if (kline.length >= 6) {
      const gain5 = (kline[kline.length - 1].close / kline[kline.length - 6].close - 1) * 100
      if (gain5 > 20) {
        score *= 0.3 // 涨太多，排除
      } else if (gain5 > 15) {
        score *= 0.6 // 涨偏多，降权
      } else if (gain5 > 10) {
        score *= 0.8 // 涨了不少，轻微降权
      }
    }

    // 2. 板块确认：得分 × 板块热度系数
    const sectorHeat = sectorStrengthMap.get(s.code) ?? 0.5
    // 板块热度 0~1 → 系数 0.6~1.4
    const sectorCoef = 0.6 + sectorHeat * 0.8
    score *= sectorCoef

    // 3. 资金方向：主力净流出扣分
    const mf = input.moneyFlow
    if (mf && mf.mainNetInflow !== undefined) {
      if (mf.mainNetInflow < -1e7) {
        score *= 0.5 // 主力大幅流出
      } else if (mf.mainNetInflow < 0) {
        score *= 0.8 // 主力小幅流出
      }
    }

    // 4. 买点距离：当前价远高于买点 → 追高降权
    if (kline.length >= 20) {
      const c = kline.map(k => k.close)
      const last = c[c.length - 1]
      const ma5 = lastValid(sma(c, 5)) ?? last
      const ma20 = lastValid(sma(c, 20)) ?? last
      const support = Math.max(ma5, ma20) // 简化支撑：取均线较高者
      const buyHigh = support * 1.03
      const distFromBuy = last / buyHigh - 1 // 高于买点上沿的幅度
      if (distFromBuy > 0.10) {
        score *= 0.3 // 高于买点10%+，严重追高
      } else if (distFromBuy > 0.05) {
        score *= 0.6 // 高于买点5~10%
      } else if (distFromBuy > 0.02) {
        score *= 0.85 // 略高于买点
      } else if (distFromBuy >= -0.03) {
        score *= 1.1 // 在买点区间，加分
      }
    }

    // 5. 出货风险检测：高位放量滞涨/长上影/冲高回落 → 一票降权
    if (kline.length >= 25) {
      const last = kline[kline.length - 1]
      const prev = kline[kline.length - 2]
      const high = kline.map(k => k.high)
      const volume = kline.map(k => k.volume)

      const vol20 = lastValid(sma(volume, 20))
      const volRatio = vol20 && vol20 > 0 ? last.volume / vol20 : 1
      const todayGain = prev.close > 0 ? last.close / prev.close - 1 : 0
      const high60 = Math.max(...high.slice(-60))
      const posRatio = high60 > 0 ? last.close / high60 : 0.5
      const isHigh = posRatio > 0.88 // 处于高位

      const body = Math.abs(last.close - last.open)
      const upperShadow = last.high - Math.max(last.close, last.open)
      const isLongUpper = body > 0 && upperShadow > body * 2 // 长上影

      const intradayHigh = prev.close > 0 ? last.high / prev.close - 1 : 0
      const isSpikeFall = intradayHigh > 0.03 && todayGain < 0 // 冲高回落

      const isVolumeStall = volRatio > 1.5 && todayGain < 0.01 // 放量滞涨
      const isHighVolumeDown = isHigh && last.close < last.open && volRatio > 1.5 // 高位放量收阴

      let riskSignals = 0
      if (isVolumeStall) riskSignals++
      if (isLongUpper) riskSignals++
      if (isSpikeFall) riskSignals++
      if (isHighVolumeDown) riskSignals++

      if (riskSignals >= 2) {
        score *= 0.25 // 多个出货信号，严重降权
      } else if (riskSignals === 1 && (isHigh || isVolumeStall)) {
        score *= 0.6 // 单个出货信号且在关键位置
      }
    }

    s.totalScore = Math.round(score * 10) / 10
  }

  // 重新排序
  scored.sort((a, b) => b.totalScore - a.totalScore)
  return scored
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

  // 加载候选池 + K 线
  const { inputs, totalScanned, skipped } = await loadScoringInputs(
    config,
    onProgress,
    concurrency,
  )

  // 板块热度注入：按行业内涨幅排名
  const sectorStrengthMap = new Map<string, number>()
  const industryGroups = new Map<string, { code: string; changePct: number }[]>()
  for (const input of inputs) {
    const ind = input.info.industry ?? '未知'
    if (!industryGroups.has(ind)) industryGroups.set(ind, [])
    industryGroups.get(ind)!.push({ code: input.info.code, changePct: input.info.changePct ?? 0 })
  }
  for (const group of industryGroups.values()) {
    group.sort((a, b) => b.changePct - a.changePct)
    for (let i = 0; i < group.length; i++) {
      sectorStrengthMap.set(group[i].code, 1 - i / group.length)
    }
  }

  // 大盘温度计算（全市场涨幅中位数映射到 0~100）
  const allChanges = inputs.map(i => i.info.changePct ?? 0).filter(c => !isNaN(c))
  allChanges.sort((a, b) => a - b)
  const medianChange = allChanges.length > 0 ? allChanges[Math.floor(allChanges.length / 2)] : 0
  // 涨幅中位数 -3° → 0°, 0° → 50°, +3° → 100°
  const marketTemp = Math.round(Math.max(0, Math.min(100, 50 + medianChange * (50 / 3))))
  for (const input of inputs) {
    ;(input as any)._marketTemp = marketTemp
  }

  // 多因子打分（统一走 scoreWithWorker）
  onProgress({ stage: 'scoring', done: 0, total: 1, message: '多因子打分…' })
  let scored: StockScore[] = await scoreWithWorker(inputs, config.factors, sectorStrengthMap)
  // 选股页与回测共用严格的缩量蓄势突破定义：T 日只使用截至 T 的 K 线，
  // 评分口径为 0~100，避免选股页仍使用旧版宽松形态算法。
  if (config.factors.some((f) => f.enabled && f.key === 'shrink_surge')) {
    const strictByCode = new Map<string, number>()
    for (const input of inputs) {
      const values = calcShrinkSurgeScore(input.kline)
      const value = values[values.length - 1]
      if (value !== null && Number.isFinite(value)) strictByCode.set(input.info.code, value * 100)
    }
    scored = scored.map((s) => {
      const strict = strictByCode.get(s.code)
      if (strict === undefined) return s
      const factor = s.factorScores.find((f) => f.key === 'shrink_surge')
      if (factor) {
        factor.rawValue = strict / 100
        factor.score = Math.round(strict)
        factor.detail = strict >= 65 ? '严格形态确认：放量→缩量洗盘→平台突破' : '严格形态未完全确认'
        // scoreStocks 已在旧因子上完成过总分计算；覆盖核心因子后必须同步重算，
        // 否则页面排序与实际展示的严格分数会脱节。
        const available = s.factorScores.filter((f) => f.score !== undefined)
        const weightSum = available.reduce((sum, f) => sum + f.weight, 0)
        if (weightSum > 0) {
          s.totalScore = Math.round(
            available.reduce((sum, f) => sum + f.score * f.weight, 0) / weightSum,
          )
        }
      }
      return s
    })
  }
  // 选股增强：动量阶段 + 板块确认 + 资金方向
  scored = enhanceStockSelection(scored, inputs, sectorStrengthMap)
  // 用候选池已有的 K 线预算买卖点（详情弹窗会自行拉更多 K 线重算，此处给结果表一个快速参考）
  attachSignalsFromInputs(scored, inputs, config)
  // 计算综合评分 = 总分×0.5 + 性价比×40 + 买入决策×10
  for (const s of scored) {
    const total = s.totalScore ?? 0
    const rr = s.signal?.riskReward ?? 0
    const buy = s.buyScore ?? 5 // 没有则取中性值
    s.compositeScore = Math.round(total * 0.5 + rr * 40 + buy * 10)
  }
  // 过滤今日涨停票（买不进）
  scored = scored.filter(s => (s.changePct ?? 0) < 9.8)
  // 过滤破支撑的票（现价跌破买点下沿，形态走坏，不接刀）
  scored = scored.filter(s => {
    if (!s.signal || s.price === undefined) return true
    return s.price >= s.signal.buyLow
  })
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

  // 今日推荐固定 Top 5 + 强制行业分散（对应回测最优参数）
  const pickConfig: SelectConfig = {
    ...config,
    maxResults: 5,
    diversify: true,
  }

  let marketSnapshot: StockInfo[] | null = null
  let tradeFilterWarning: string | undefined
  const now = new Date()
  const h = now.getHours()
  const m = now.getMinutes()
  const isTailPeriod = (h === 14 && m >= 30) || h === 15

  // 识别当前模板类型
  const enabledKeys = new Set(config.factors.filter((f) => f.enabled).map((f) => f.key))
  const isConceptLeader =
    enabledKeys.size === 4 &&
    ['short_momentum', 'breakout', 'volume', 'moneyflow'].every((k) => enabledKeys.has(k))

  let topCandidates: StockScore[]
  if (isConceptLeader) {
    onProgress({ stage: 'list', done: 0, total: 1, message: '分析热点概念题材…' })
    const market = marketSnapshot ?? await fetchMarketStocks()
    const eligible = filterBySelectionConfig(market, pickConfig)
    // 粗筛候选 → 补 K 线 / 资金流 → 精排（低位首板优先、高位连板降级、资金确认）
    let leadersDone = 0
    const picks = await pickConceptLeaders(eligible, 12, {
      topK: 40,
      enrich: async (s) => {
        let kline: Kline[] = []
        try {
          kline = await fetchKline(s.market, s.code, 160)
        } catch {
          kline = []
        }
        let moneyFlow = await moneyflowCache.get(s.code)
        if (!moneyFlow) {
          try {
            moneyFlow = await fetchMoneyFlow(s.market, s.code)
          } catch {
            moneyFlow = null
          }
          if (moneyFlow) await moneyflowCache.set(s.code, moneyFlow)
        }
        leadersDone++
        if (leadersDone % 10 === 0) {
          onProgress({ stage: 'kline', done: leadersDone, total: 40, message: `分析龙头候选 ${leadersDone}/40…` })
        }
        return { kline, moneyFlow: moneyFlow ?? undefined }
      },
    })
    topCandidates = picks.slice(0, 12).map(({ stock: s, highRisk, reasons }, i) => ({
      code: s.code,
      name: s.name,
      market: s.market,
      industry: s.industry,
      concept: s.concept,
      totalScore: 100 - i * 5, // 龙头排序分数（仅展示）
      price: s.price,
      changePct: s.changePct,
      highRisk,
      factorScores: [
        {
          key: 'concept',
          name: s.concept ?? '题材',
          group: 'technical',
          rawValue: s.changePct ?? 0,
          score: Math.min(100, (s.changePct ?? 0) * 5 + 50),
          weight: 1,
          detail:
            reasons.length > 0
              ? `题材龙头 · 今日涨幅 ${(s.changePct ?? 0).toFixed(2)}% · ${reasons.join('，')}`
              : `题材龙头 · 今日涨幅 ${(s.changePct ?? 0).toFixed(2)}%`,
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
        // 破支撑判断（现价跌破买点下沿，不接刀）
        const brokeSupport = signal.currentPrice < signal.buyLow
        if (oneWord) {
          rejectedOneWord++
        } else if (brokeSupport) {
          rejectedOneWord++ // 计入跳过
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
            totalMv: s.totalMv,
            floatMv: s.floatMv,
            pe: s.pe,
            pb: s.pb,
            turnoverRate: s.turnoverRate,
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
  tradeFilterWarning = filterNotes.length > 0 ? filterNotes.join('，') : undefined

  return {
    picks,
    computedAt: now.toISOString(),
    isTailPeriod,
    gateReason: tradeFilterWarning,
  }
}

/**
 * 精选1只：全市场扫描，按综合评分选出唯一最适合买入的标的。
 * 综合评分 = 总分×0.5 + 性价比×40 + 买入决策×10
 */
export async function runBestPick(
  config: SelectConfig,
  opts: RunOptions = {},
): Promise<DailyPickResult> {
  const onProgress = opts.onProgress ?? (() => {})
  const now = new Date()
  const h = now.getHours()
  const m = now.getMinutes()
  const isTailPeriod = (h === 14 && m >= 30) || h === 15

  // 跑完整选股（多取候选，再按综合评分挑最优）
  onProgress({ stage: 'scoring', done: 0, total: 1, message: '全市场扫描…' })
  const sel = await runSelection(
    { ...config, maxResults: 40, diversify: false },
    opts,
  )

  // 按综合评分排序（无综合评分则退回总分）
  const ranked = [...sel.scored].sort(
    (a, b) => (b.compositeScore ?? b.totalScore) - (a.compositeScore ?? a.totalScore),
  )

  const picks: DailyPick[] = []
  const shortMode = isShortMode(config)
  for (const s of ranked) {
    if (picks.length >= 1) break
    let kline: Kline[] = []
    try {
      kline = await fetchKline(s.market, s.code, 160)
    } catch {
      kline = []
    }
    if (kline.length === 0) continue
    const signal = computeTradingSignal(kline, undefined, shortMode)
    if (!signal) continue
    const n = kline.length
    const changePct =
      n >= 2 && kline[n - 2].close > 0
        ? (kline[n - 1].close / kline[n - 2].close - 1) * 100
        : s.changePct
    const isWide = s.code.startsWith('30') || s.code.startsWith('688')
    const oneWord = isOneWordLimitUp(kline, isWide ? 0.2 : 0.1)
    if (oneWord) continue // 一字板买不进，跳过
    if (signal.currentPrice < signal.buyLow) continue // 破支撑，不接刀
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
      totalMv: s.totalMv,
      floatMv: s.floatMv,
      pe: s.pe,
      pb: s.pb,
      turnoverRate: s.turnoverRate,
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

  onProgress({ stage: 'done', done: 1, total: 1, message: picks.length > 0 ? '精选完成' : '无符合条件的标的' })

  return {
    picks,
    computedAt: now.toISOString(),
    isTailPeriod,
    gateReason: picks.length === 0 ? '全市场暂无符合策略的标的，建议空仓等待' : undefined,
  }
}

/** 短线模式识别：含短线爆发/创新高等短线因子时，用 MA5 回踩更敏感 */
function isShortMode(config: SelectConfig): boolean {
  return config.factors.some(
    (f) => f.enabled && (f.key === 'short_momentum' || f.key === 'breakout' || f.key === 'limit_up'),
  )
}

/** 用打分前已有的候选池 K 线，给每只入选股票附上买卖点摘要 */
function attachSignalsFromInputs(
  scored: StockScore[],
  inputs: ScoringInput[],
  config: SelectConfig,
): void {
  if (scored.length === 0) return
  const shortMode = isShortMode(config)
  const klineByCode = new Map(inputs.map((inp) => [inp.info.code, inp.kline]))
  const concByCode = new Map(inputs.map((inp) => [inp.info.code, inp.fundConcentration]))
  for (const s of scored) {
    const kline = klineByCode.get(s.code)
    if (!kline || kline.length < 30) continue
    const sig = computeTradingSignal(kline, s.price, shortMode)
    if (!sig) continue
    const brief: TradingSignalBrief = {
      buyLow: sig.buyLow,
      buyHigh: sig.buyHigh,
      takeProfit: sig.takeProfit,
      stopLoss: sig.stopLoss,
      riskReward: sig.riskReward,
      shortMode,
    }
    s.signal = brief
    // 附带企稳评分 + 买入决策评分（与详情页共用同一算法）
    const stab = analyzeStabilization(kline)
    if (stab) {
      s.stabilityScore = stab.verdict.score
      s.buyScore = computeBuyScore(stab, sig.riskReward)
    }
    // 附带资金集中度
    s.fundConcentration = concByCode.get(s.code) ?? undefined
  }
}
