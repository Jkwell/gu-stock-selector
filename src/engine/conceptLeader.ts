import type { Kline, MoneyFlow, StockInfo } from '../types'
import { computeConceptHeat } from './sectorHeat'

/**
 * 题材龙头选股
 * 从当日最强概念题材里选出领涨股（光模块/算力这类风口的龙头）。
 *
 * 两阶段：
 *   1. 快照粗筛（个股强势 + 单日题材热度）取 topK
 *   2. 对粗筛候选补 K 线 / 资金流
 *   3. 精排：
 *      - 个股强势分（涨幅/换手/涨停）
 *      - 位置因子：低位首板优先 +，高位连板 / 近20日涨幅过大降级
 *      - 主力资金确认：净流入加分、净流出降级
 *      - 题材热度钝化：单日热度 × 近5日持续度 各半，避免只追单日爆炒
 */

/** 精排阶段需要的数据（由调用方从数据层补充） */
export interface ConceptLeaderData {
  kline: Kline[]
  moneyFlow?: MoneyFlow
}

export interface ConceptLeaderPick {
  stock: StockInfo
  highRisk: boolean
  reasons: string[]
}

/** 题材内龙头得分：涨停优先 + 涨幅 + 换手率 */
function leaderScore(s: StockInfo): number {
  const chg = s.changePct ?? 0
  const turnover = s.turnoverRate ?? 0
  return chg * 3 + turnover * 0.5 + (isLimitUp(s) ? 20 : 0)
}

function isLimitUp(s: StockInfo): boolean {
  const chg = s.changePct
  if (chg === undefined || chg === null) return false
  const wide = s.code.startsWith('30') || s.code.startsWith('688')
  return wide ? chg >= 19.8 : chg >= 9.8
}

/** 连续涨停天数（从最新一根往前数） */
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

/** 位置因子：低位首板加分，高位连板 / 20日涨幅过大降级 */
function positionScore(s: StockInfo, kline: Kline[]): { score: number; highRisk: boolean; reason: string } {
  if (kline.length < 21) return { score: 0, highRisk: false, reason: '' }
  const wide = s.code.startsWith('30') || s.code.startsWith('688')
  const limitUp = countLimitUp(kline, wide ? 0.198 : 0.098)
  const close = kline.map((k) => k.close)
  const prev20 = close[close.length - 21]
  const high20Gain = prev20 > 0 ? close[close.length - 1] / prev20 - 1 : 0

  let score = 0
  const parts: string[] = []
  const highRisk = limitUp >= 5 || high20Gain > 0.5
  if (limitUp >= 5) {
    score -= 40
    parts.push(`${limitUp}连板·高位`)
  } else if (limitUp === 4) {
    score -= 20
    parts.push('4连板·偏高')
  }
  if (high20Gain > 0.5) {
    score -= 25
    parts.push(`近20日+${(high20Gain * 100).toFixed(0)}%`)
  }
  if (limitUp <= 1 && high20Gain <= 0.35) {
    score += 15
    parts.push('低位首板')
  }
  return { score, highRisk, reason: parts.join(',') }
}

/** 主力资金确认：净流入占流通市值 0~2% 对应 0~20 分，净流出降级 */
function flowScore(s: StockInfo, mf?: MoneyFlow): { score: number; reason: string } {
  if (!mf) return { score: 0, reason: '' }
  const fmv = s.floatMv ?? s.totalMv
  if (!fmv || fmv <= 0) return { score: 0, reason: '' }
  const ratio = (mf.mainNetInflow / fmv) * 100
  if (ratio > 0) return { score: Math.min(ratio, 2) * 10, reason: `主力净流入${ratio.toFixed(2)}%` }
  return { score: -20, reason: '主力净流出' }
}

/**
 * 题材热度钝化：概念近5日平均涨幅映射 0~100（样本不足时回退单日热度）。
 * 与单日热度各半融合，避免只追"单日爆炒、持续性差"的题材。
 */
function computeMultiHeat(
  enriched: Array<{ stock: StockInfo; data: ConceptLeaderData }>,
): Map<string, number> {
  const groups = new Map<string, number[]>()
  for (const { stock, data } of enriched) {
    const kline = data.kline
    if (kline.length < 6) continue
    const close = kline.map((k) => k.close)
    const prev5 = close[close.length - 6]
    if (prev5 <= 0) continue
    const gain5 = close[close.length - 1] / prev5 - 1
    const concept = stock.concept ?? ''
    if (!groups.has(concept)) groups.set(concept, [])
    groups.get(concept)!.push(gain5)
  }
  const out = new Map<string, number>()
  for (const [concept, gains] of groups) {
    const avg = gains.reduce((sum, g) => sum + g, 0) / gains.length
    const score = Math.min(100, Math.max(0, ((avg + 3) / 6) * 100))
    out.set(concept, score)
  }
  return out
}

/**
 * 选出题材龙头（不排除冷门题材）
 * 逻辑：题材热度是加分项而非硬门槛。
 *   - 热点题材的领涨股：个股强势分 + 题材热度加成
 *   - 冷门题材但个股暴涨（如独立逻辑/次新）：靠个股强势分也能入选
 * 精排阶段优先"低位首板 + 主力净流入 + 题材持续发酵"的票，
 * 对高位连板 / 近20日涨幅过大的票降级（避免周一追高）。
 *
 * @param stocks 全市场快照（含 concept）
 * @param count 返回数量
 * @param options.topK 快照粗筛数量（默认 40，精排前补充数据用）
 * @param options.enrich 为粗筛候选补充 K 线/资金流；缺省时退回纯快照排序
 * @param options.maxPerConcept 同一题材最多保留数量（默认 2，组合分散）
 */
export async function pickConceptLeaders(
  stocks: StockInfo[],
  count = 4,
  options: {
    topK?: number
    maxPerConcept?: number
    enrich?: (s: StockInfo) => Promise<ConceptLeaderData | null>
  } = {},
): Promise<ConceptLeaderPick[]> {
  const topK = options.topK ?? 40
  const valid = stocks.filter((s) => s.changePct !== undefined && s.changePct !== null)

  // 单日题材热度
  const heat = computeConceptHeat(valid, 30)
  const conceptHeat = new Map<string, number>()
  for (const h of heat) {
    conceptHeat.set(h.sector, h.heatScore)
  }

  // ---- 阶段 1：快照粗筛 ----
  const rough = valid
    .map((s) => {
      const ind = leaderScore(s)
      const conceptHeatScore = conceptHeat.get(s.concept ?? '') ?? 0
      const boost = Math.min(conceptHeatScore / 4, 24)
      return { s, total: ind + boost }
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, topK)

  if (!options.enrich) {
    // 降级：无数据补充时按快照排序返回
    return rough.slice(0, count).map((x) => ({
      stock: x.s,
      highRisk: false,
      reasons: ['快照排序（无 K 线/资金流）'],
    }))
  }

  // ---- 阶段 2：补充 K 线 / 资金流 ----
  const enriched: Array<{ stock: StockInfo; data: ConceptLeaderData }> = []
  await Promise.all(
    rough.map(async (x) => {
      const data = await options.enrich!(x.s)
      if (data) enriched.push({ stock: x.s, data })
    }),
  )

  // 题材热度钝化：单日 × 近5日持续度 各半
  const multiHeat = computeMultiHeat(enriched)
  const heatScoreOf = (s: StockInfo): number => {
    const today = conceptHeat.get(s.concept ?? '') ?? 0
    const multi = multiHeat.get(s.concept ?? '') ?? today
    return today * 0.5 + multi * 0.5
  }

  // ---- 阶段 3：精排 ----
  const scored = enriched
    .map(({ stock, data }) => {
      const base = leaderScore(stock)
      const pos = positionScore(stock, data.kline)
      const flow = flowScore(stock, data.moneyFlow)
      const heatScore = heatScoreOf(stock)
      const boost = Math.min(heatScore / 4, 24)
      return {
        stock,
        highRisk: pos.highRisk,
        reasons: [pos.reason, flow.reason].filter(Boolean),
        total: base + pos.score + flow.score + boost,
      }
    })
    .sort((a, b) => b.total - a.total)

  // 概念分散：同一题材最多保留 maxPerConcept 只，避免组合集中于单一题材
  const maxPerConcept = options.maxPerConcept ?? 2
  const conceptCount = new Map<string, number>()
  const diversified: typeof scored = []
  for (const item of scored) {
    const concept = item.stock.concept ?? ''
    const cnt = conceptCount.get(concept) ?? 0
    if (cnt >= maxPerConcept) continue
    conceptCount.set(concept, cnt + 1)
    diversified.push(item)
    if (diversified.length >= count) break
  }

  return diversified.slice(0, count).map((x) => ({
    stock: x.stock,
    highRisk: x.highRisk,
    reasons: x.reasons,
  }))
}
