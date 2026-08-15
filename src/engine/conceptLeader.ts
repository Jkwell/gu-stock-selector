import type { StockInfo } from '../types'
import { computeConceptHeat } from './sectorHeat'

/**
 * 题材龙头选股
 * 从当日最强概念题材里选出领涨股（光模块/算力这类风口的龙头）。
 * 绕开"换手率/市值候选池"，直接用全市场概念聚合，避免龙头被粗筛过滤。
 */

function isLimitUp(s: StockInfo): boolean {
  const chg = s.changePct
  if (chg === undefined || chg === null) return false
  const wide = s.code.startsWith('30') || s.code.startsWith('688')
  return wide ? chg >= 19.8 : chg >= 9.8
}

/** 题材内龙头得分：涨停优先 + 涨幅 + 换手率 */
function leaderScore(s: StockInfo): number {
  const chg = s.changePct ?? 0
  const turnover = s.turnoverRate ?? 0
  const score = chg * 3 + turnover * 0.5 + (isLimitUp(s) ? 20 : 0)
  return score
}

/**
 * 选出题材龙头（不排除冷门题材）
 * 逻辑：题材热度是加分项而非硬门槛。
 *   - 热点题材的领涨股：个股强势分 + 题材热度加成
 *   - 冷门题材但个股暴涨（如独立逻辑/次新）：靠个股强势分也能入选
 * 保证亨通/美利云这种热点龙头 + 一鸣这种冷门妖股都能选出来。
 *
 * @param stocks 全市场快照（含 concept）
 * @param count 返回数量
 */
export function pickConceptLeaders(
  stocks: StockInfo[],
  count = 4,
): StockInfo[] {
  // 计算每个概念的热度（涨停数），作为题材加成
  const heat = computeConceptHeat(stocks, 30)
  const conceptHeat = new Map<string, number>()
  for (const h of heat) {
    conceptHeat.set(h.sector, h.limitUpCount)
  }

  // 全局加权排序：个股强势分 + 题材热度加成
  const scored = stocks
    .map((s) => {
      const ind = leaderScore(s)
      const conceptLimitUp = conceptHeat.get(s.concept ?? '') ?? 0
      // 题材热度加成：所属概念涨停数越多，加成越高（封顶 3 个涨停 +24 分）
      const boost = Math.min(conceptLimitUp, 3) * 8
      return { s, total: ind + boost }
    })
    .filter((x) => x.s.changePct !== undefined && x.s.changePct !== null) // 排除无行情
    .sort((a, b) => b.total - a.total)

  return scored.slice(0, count).map((x) => x.s)
}
