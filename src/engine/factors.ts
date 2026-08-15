import type {
  FactorDef,
  FactorScore,
  Financials,
  Kline,
  MoneyFlow,
  StockInfo,
  StockScore,
} from '../types'
import {
  annualizedVol,
  bollinger,
  lastValid,
  macd,
  rsi,
  sma,
} from './indicators'
import { maSqueeze } from './breakout'

/** 打分引擎输入：一只股票的所有原始数据 */
export interface ScoringInput {
  info: StockInfo
  kline: Kline[] // 至少 60 根才参与技术因子打分
  financials?: Financials
  moneyFlow?: MoneyFlow
  moneyFlowHistory?: number[] // 近 N 日主力净流入（资金趋势）
}

const clamp = (v: number, lo = 0, hi = 100) =>
  Math.min(hi, Math.max(lo, v))

interface TechnicalRaw {
  trend: number | null
  macd: number | null
  rsi: number | null
  volume: number | null
  momentum_1m: number | null
  momentum_3m: number | null
  reversal: number | null
  volatility: number | null
  short_momentum: number | null
  breakout: number | null
  limit_up: number | null
  ma_squeeze: number | null
}

/** 计算连续涨停板天数（从最新一天往前数） */
function countLimitUp(kline: Kline[], threshold: number): number {
  let days = 0
  for (let i = kline.length - 1; i >= 1; i--) {
    const prev = kline[i - 1].close
    if (prev <= 0) break
    const change = kline[i].close / prev - 1
    if (change >= threshold - 0.005) days++
    else break
  }
  return days
}

/** 计算某只股票的技术指标原始值 */
function computeTechnicalRaw(kline: Kline[], limitUpThreshold: number): TechnicalRaw {
  const empty: TechnicalRaw = {
    trend: null,
    macd: null,
    rsi: null,
    volume: null,
    momentum_1m: null,
    momentum_3m: null,
    reversal: null,
    volatility: null,
    short_momentum: null,
    breakout: null,
    limit_up: null,
    ma_squeeze: null,
  }
  if (kline.length < 70) return empty
  const close = kline.map((k) => k.close)
  const high = kline.map((k) => k.high)
  const volume = kline.map((k) => k.volume)
  const n = close.length

  const ma20 = lastValid(sma(close, 20))
  const ma60 = lastValid(sma(close, 60))
  const ma20arr = sma(close, 20)
  const ma20prev = ma20arr[n - 3]

  const macdRes = macd(close)
  const difLast = macdRes.dif[n - 1]
  const deaLast = macdRes.dea[n - 1]
  const histLast = macdRes.hist[n - 1]
  const histPrev = macdRes.hist[n - 2]

  const rsiArr = rsi(close, 14)
  const rsiLast = lastValid(rsiArr)

  const vol20 = lastValid(sma(volume, 20))
  const volLast = volume[n - 1]

  // 趋势强度：相对 20/60 日线位置 + 均线多空排列
  const trend = (() => {
    if (!ma20 || !ma60 || !ma20prev) return null
    const above20 = close[n - 1] / ma20 - 1
    const above60 = close[n - 1] / ma60 - 1
    const maBull = ma20 / ma60 - 1 // >0 表示 ma20 在 ma60 上方（多头）
    const ma20Turn = (ma20 - ma20prev) / ma20prev // ma20 方向
    return above20 * 0.35 + above60 * 0.35 + maBull * 0.2 + ma20Turn * 1.5
  })()

  // MACD：柱相对价格强度 + 金叉死叉方向
  const macdRaw = (() => {
    if (difLast === undefined || deaLast === undefined || histLast === undefined) return null
    const histRatio = (histLast / close[n - 1]) * 100
    let v = 50 + histRatio * 120
    if (histLast > 0 && histPrev <= 0) v += 20 // 柱由负转正（金叉确认）
    if (histLast < 0 && histPrev >= 0) v -= 20 // 柱由正转负（死叉确认）
    if (difLast > deaLast) v += 5
    return clamp(v, 5, 100)
  })()

  // RSI：健康区间高分，超买超卖低分
  const rsiScore = (() => {
    if (rsiLast === null) return null
    const r = rsiLast
    if (r >= 45 && r <= 60) return 100
    if (r >= 35 && r < 45) return 88
    if (r > 60 && r <= 70) return 78
    if (r >= 25 && r < 35) return 58
    if (r > 70 && r <= 75) return 45
    return 25 // r<25 或 r>75
  })()

  // 成交量异动：量比 1.2~2.5 温和放量高分
  const volumeScore = (() => {
    if (!vol20 || vol20 === 0) return null
    const ratio = volLast / vol20
    if (ratio <= 0.6) return 30
    if (ratio <= 1.2) return 60
    if (ratio <= 1.5) return 75
    if (ratio <= 2.5) return 90
    if (ratio <= 4) return 68
    return 40
  })()

  // 动量（1月）：过去 20 个交易日涨幅
  const momentum1m = (() => {
    if (n < 21 || close[n - 21] === 0) return null
    return close[n - 1] / close[n - 21] - 1
  })()

  // 动量（3月）：过去 60 个交易日涨幅
  const momentum3m = (() => {
    if (n < 61 || close[n - 61] === 0) return null
    return close[n - 1] / close[n - 61] - 1
  })()

  // 短期反转：过去 5 日跌幅（负值=超跌），越跌分越高
  const reversal = (() => {
    if (n < 6 || close[n - 6] === 0) return null
    return close[n - 6] / close[n - 1] - 1 // >0 表示过去5日下跌
  })()

  // 波动率：20 日年化波动率（%）
  const volatilityRaw = (() => {
    if (n < 30) return null
    return annualizedVol(close, 20)
  })()

  // 短线爆发力：过去 3 个交易日涨幅
  const shortMomentum = (() => {
    if (n < 4 || close[n - 4] === 0) return null
    return close[n - 1] / close[n - 4] - 1
  })()

  // 创新高程度：现价相对前 20 日最高价（不含当日）
  const breakout = (() => {
    if (n < 21) return null
    const high20prev = Math.max(...high.slice(n - 21, n - 1))
    if (high20prev <= 0) return null
    return close[n - 1] / high20prev - 1
  })()

  // 连板高度：连续涨停天数
  const limitUp = countLimitUp(kline, limitUpThreshold)

  // 均线粘合突破：粘合度越接近 0 越粘合；粘合后放量突破 = 启动信号
  const squeeze = maSqueeze(kline)
  const maSqueezeScore =
    squeeze.squeeze !== null
      ? squeeze.breakout
        ? clamp(100 - squeeze.squeeze * 2000, 70, 100) // 突破 → 高分
        : clamp(70 - squeeze.squeeze * 1500, 30, 70) // 粘合蓄势 → 中分
      : null

  return {
    trend,
    macd: macdRaw,
    rsi: rsiScore,
    volume: volumeScore,
    momentum_1m: momentum1m,
    momentum_3m: momentum3m,
    reversal,
    volatility: volatilityRaw,
    short_momentum: shortMomentum,
    breakout,
    limit_up: limitUp,
    ma_squeeze: maSqueezeScore,
  }
}

/** 估值原始值：返回 PE（用于全市场分位比较），无效值返回 null */
function computeValuationRaw(info: StockInfo): number | null {
  const pe = info.pe
  if (pe === undefined || pe === null) return null
  if (pe <= 0 || pe > 300) return null // 亏损或异常值不参与分位
  return pe
}

/** 盈利能力原始值：ROE */
function computeProfitabilityRaw(fin?: Financials): number | null {
  if (!fin || fin.roe === undefined || fin.roe === null) return null
  return fin.roe
}

/** 成长性原始值：净利润增速（缺失用营收增速） */
function computeGrowthRaw(fin?: Financials): number | null {
  if (!fin) return null
  if (fin.profitGrowth !== undefined && fin.profitGrowth !== null) {
    return fin.profitGrowth
  }
  if (fin.revenueGrowth !== undefined && fin.revenueGrowth !== null) {
    return fin.revenueGrowth
  }
  return null
}

/** 资金面原始值：主力净流入占流通市值比例（%） */
function computeMoneyflowRaw(
  mf: MoneyFlow | undefined,
  info: StockInfo,
): number | null {
  if (!mf || mf.mainNetInflow === undefined || mf.mainNetInflow === null) return null
  const fmv = info.floatMv ?? info.totalMv
  if (!fmv || fmv <= 0) return null
  return (mf.mainNetInflow / fmv) * 100
}

/** 阈值分段打分助手：给定分档表，输出分数 */
function tierScore(
  value: number,
  tiers: Array<{ min: number; max: number; score: number }>,
): number {
  for (const t of tiers) {
    if (value >= t.min && value < t.max) return t.score
  }
  return 0
}

/** 主打分函数：给定一批股票与配置，返回排序后的评分结果 */
export function scoreStocks(
  inputs: ScoringInput[],
  factors: FactorDef[],
): StockScore[] {
  const enabledFactors = factors.filter((f) => f.enabled)
  if (enabledFactors.length === 0) return []

  // 权重归一化（仅启用因子）
  const weightSum = enabledFactors.reduce((s, f) => s + f.weight, 0) || 1
  const weightOf = new Map(enabledFactors.map((f) => [f.key, f.weight / weightSum]))

  // 估值分位：优先行业中性化（行业内分位），样本不足时退化为全市场分位
  const percentileOf = (() => {
    const byIndustry = new Map<string, number[]>()
    const marketPEs: number[] = []
    for (const input of inputs) {
      const pe = computeValuationRaw(input.info)
      if (pe === null) continue
      const ind = input.info.industry ?? ''
      if (!byIndustry.has(ind)) byIndustry.set(ind, [])
      byIndustry.get(ind)!.push(pe)
      marketPEs.push(pe)
    }
    for (const pes of byIndustry.values()) pes.sort((a, b) => a - b)
    marketPEs.sort((a, b) => a - b)

    const rankIn = (sorted: number[], v: number): number => {
      if (sorted.length === 0) return 0.5
      let lo = 0
      let hi = sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (sorted[mid] <= v) lo = mid + 1
        else hi = mid
      }
      return lo / sorted.length // 0~1，1 = 估值最高
    }

    // 返回 { 分位, 是否行业中性 }
    return (pe: number, industry?: string): { pct: number; isInd: boolean } => {
      const group = industry ? byIndustry.get(industry) : undefined
      if (group && group.length >= 5) {
        return { pct: rankIn(group, pe), isInd: true }
      }
      return { pct: rankIn(marketPEs, pe), isInd: false }
    }
  })()

  const results: StockScore[] = []
  for (const input of inputs) {
    // 涨停阈值：创业板(30)/科创板(688) 20%，主板 10%
    const isWide = input.info.code.startsWith('30') || input.info.code.startsWith('688')
    const limitUpThreshold = isWide ? 0.2 : 0.1
    const tech = computeTechnicalRaw(input.kline, limitUpThreshold)
    const factorScores: FactorScore[] = []
    let highRiskFlag = false

    for (const f of enabledFactors) {
      const w = weightOf.get(f.key) ?? 0
      let score: number | null = null
      let rawValue: number | null = null
      let detail = '数据不足'

      switch (f.key) {
        case 'trend': {
          rawValue = tech.trend
          if (rawValue !== null) {
            score = clamp(50 + rawValue * 900, 5, 100)
            detail = `高于20日线 ${(rawValue * 100).toFixed(2)}% 综合`
          }
          break
        }
        case 'macd': {
          score = tech.macd
          rawValue = score
          if (score !== null) detail = `DIF-DEA柱体动量评分 ${score.toFixed(0)}`
          break
        }
        case 'rsi': {
          score = tech.rsi
          rawValue = score
          if (score !== null) detail = `RSI 状态评分 ${score.toFixed(0)}`
          break
        }
        case 'volume': {
          score = tech.volume
          rawValue = score
          if (score !== null) detail = `量比评分 ${score.toFixed(0)}`
          break
        }
        case 'momentum_1m': {
          rawValue = tech.momentum_1m
          if (rawValue !== null) {
            score = clamp(50 + rawValue * 400, 5, 100)
            detail = `近1月涨幅 ${(rawValue * 100).toFixed(2)}%`
          }
          break
        }
        case 'momentum_3m': {
          rawValue = tech.momentum_3m
          if (rawValue !== null) {
            score = clamp(50 + rawValue * 250, 5, 100)
            detail = `近3月涨幅 ${(rawValue * 100).toFixed(2)}%`
          }
          break
        }
        case 'short_momentum': {
          rawValue = tech.short_momentum
          if (rawValue !== null) {
            score = clamp(50 + rawValue * 300, 5, 100)
            detail = `近3日涨幅 ${(rawValue * 100).toFixed(2)}%`
          }
          break
        }
        case 'breakout': {
          rawValue = tech.breakout
          if (rawValue !== null) {
            // 创新高程度：≥+5% 100，≥0 85，≥-3% 70，≥-6% 55，≥-10% 35，更低 20
            score = tierScore(rawValue, [
              { min: 0.05, max: Infinity, score: 100 },
              { min: 0, max: 0.05, score: 85 },
              { min: -0.03, max: 0, score: 70 },
              { min: -0.06, max: -0.03, score: 55 },
              { min: -0.1, max: -0.06, score: 35 },
              { min: -Infinity, max: -0.1, score: 20 },
            ])
            detail = `现价${rawValue >= 0 ? '已创新高' : `距20日高点 ${(Math.abs(rawValue) * 100).toFixed(1)}%`}`
          }
          break
        }
        case 'ma_squeeze': {
          score = tech.ma_squeeze
          rawValue = score
          if (score !== null) {
            const s = maSqueeze(input.kline)
            detail = s.breakout
              ? `均线粘合后放量突破（粘合度 ${((s.squeeze ?? 0) * 100).toFixed(1)}%）`
              : `均线粘合蓄势（粘合度 ${((s.squeeze ?? 0) * 100).toFixed(1)}%）`
          }
          break
        }
        case 'limit_up': {
          rawValue = tech.limit_up
          if (rawValue !== null) {
            // 连板高度：1板启动，2-4板黄金，5板+过高风险（降级）
            score = tierScore(rawValue, [
              { min: 5, max: Infinity, score: 60 }, // 高连板降级
              { min: 4, max: 5, score: 92 },
              { min: 3, max: 4, score: 90 },
              { min: 2, max: 3, score: 80 },
              { min: 1, max: 2, score: 60 },
              { min: 0, max: 1, score: 30 },
            ])
            // 高位风险预警：5 板以上 或 20日涨幅>50% 且 量比>4（放天量）
            const high20Gain = tech.momentum_3m !== null ? tech.momentum_3m > 0.5 : false
            const volumeRatio = tech.volume !== null && tech.volume >= 85 // volume 因子高分≈放量
            if (rawValue >= 5 || (high20Gain && volumeRatio)) {
              score = Math.min(score ?? 0, 45)
              highRiskFlag = true
              detail = `⚠️ 高位风险 · ${rawValue} 连板，注意追高风险`
            } else {
              detail = rawValue >= 1 ? `已 ${rawValue} 连板` : '未涨停'
            }
          }
          break
        }
        case 'reversal': {
          rawValue = tech.reversal
          if (rawValue !== null) {
            score = clamp(50 + rawValue * 500, 5, 100)
            detail = `近5日${rawValue >= 0 ? '下跌' : '上涨'} ${(Math.abs(rawValue) * 100).toFixed(2)}%`
          }
          break
        }
        case 'volatility': {
          rawValue = tech.volatility
          if (rawValue !== null) {
            score = clamp(50 - (rawValue - 30) * 0.6, 5, 100)
            detail = `20日年化波动 ${rawValue.toFixed(1)}%`
          }
          break
        }
        case 'valuation': {
          const pe = computeValuationRaw(input.info)
          rawValue = pe
          if (pe !== null) {
            const { pct, isInd } = percentileOf(pe, input.info.industry)
            score = clamp(100 - pct * 100, 0, 100)
            detail = `PE=${pe.toFixed(1)}，低于${
              isInd ? `${input.info.industry ?? '行业'}内` : '全市场'
            } ${(pct * 100).toFixed(0)}% 的股票`
          } else {
            detail = 'PE 缺失或非正'
          }
          break
        }
        case 'profitability': {
          const roe = computeProfitabilityRaw(input.financials)
          rawValue = roe
          if (roe !== null) {
            score = tierScore(roe, [
              { min: 25, max: Infinity, score: 100 },
              { min: 20, max: 25, score: 90 },
              { min: 15, max: 20, score: 80 },
              { min: 10, max: 15, score: 65 },
              { min: 5, max: 10, score: 50 },
              { min: 0, max: 5, score: 30 },
              { min: -Infinity, max: 0, score: 10 },
            ])
            detail = `ROE=${roe.toFixed(1)}%`
          }
          break
        }
        case 'growth': {
          const g = computeGrowthRaw(input.financials)
          rawValue = g
          if (g !== null) {
            score = tierScore(g, [
              { min: 50, max: Infinity, score: 100 },
              { min: 30, max: 50, score: 90 },
              { min: 20, max: 30, score: 75 },
              { min: 10, max: 20, score: 60 },
              { min: 0, max: 10, score: 45 },
              { min: -10, max: 0, score: 25 },
              { min: -Infinity, max: -10, score: 10 },
            ])
            detail = `净利润同比 ${g.toFixed(1)}%`
          }
          break
        }
        case 'moneyflow': {
          const m = computeMoneyflowRaw(input.moneyFlow, input.info)
          rawValue = m
          if (m !== null) {
            score = clamp(50 + m * 180, 0, 100)
            detail = `主力净流入占流通市值 ${m.toFixed(3)}%`
          }
          break
        }
        case 'moneyflow_5d': {
          const hist = input.moneyFlowHistory
          if (hist && hist.length >= 2) {
            const total = hist.reduce((a, b) => a + b, 0)
            const fmv = input.info.floatMv ?? input.info.totalMv
            const m5 = fmv && fmv > 0 ? (total / fmv) * 100 : null
            rawValue = m5
            if (m5 !== null) {
              score = clamp(50 + m5 * 250, 0, 100)
              const inflowDays = hist.filter((v) => v > 0).length
              detail = `近5日主力${total > 0 ? '净流入' : '净流出'}${(total / 1e8).toFixed(2)}亿 · ${inflowDays}/${hist.length}日流入`
            }
          }
          break
        }
      }

      if (score !== null) {
        factorScores.push({
          key: f.key,
          name: f.name,
          group: f.group,
          rawValue,
          score,
          weight: w,
          detail,
        })
      }
    }

    // 总分：按实际可得因子的归一化权重加权
    const availSum = factorScores.reduce((s, fs) => s + fs.weight, 0)
    const total =
      availSum > 0
        ? factorScores.reduce((s, fs) => s + fs.score * (fs.weight / availSum), 0)
        : 0

    results.push({
      code: input.info.code,
      name: input.info.name,
      market: input.info.market,
      industry: input.info.industry,
      concept: input.info.concept,
      highRisk: highRiskFlag,
      totalScore: Number(total.toFixed(1)),
      price: input.info.price,
      changePct: input.info.changePct,
      factorScores,
    })
  }

  return results.sort((a, b) => b.totalScore - a.totalScore)
}

/** 布林带位置（供详情页展示） */
export function bollingerPosition(kline: Kline[]): number | null {
  if (kline.length < 20) return null
  const close = kline.map((k) => k.close)
  const bb = bollinger(close)
  const u = lastValid(bb.upper)
  const l = lastValid(bb.lower)
  const m = lastValid(bb.middle)
  if (u === null || l === null || m === null) return null
  const last = close[close.length - 1]
  return (last - l) / (u - l)
}
