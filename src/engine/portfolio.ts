import type { StockScore } from '../types'

/**
 * 组合优化：行业分散
 * 输入已按总分降序的评分结果，按行业去重，每个行业最多保留
 * maxPerIndustry 只，避免组合集中在少数行业。
 */

export function diversifyPortfolio(
  scored: StockScore[],
  maxPerIndustry: number,
): StockScore[] {
  if (maxPerIndustry <= 0) return scored
  const industryCount = new Map<string, number>()
  const seenCodes = new Set<string>() // 同代码只保留一次，防止重复候选进入组合
  const out: StockScore[] = []
  for (const s of scored) {
    if (seenCodes.has(s.code)) continue
    seenCodes.add(s.code)
    const ind = s.industry ?? '未知'
    // 无行业数据（新浪降级源无行业字段）时不限行业数量，避免结果坍缩
    if (ind === '未知') {
      out.push(s)
      continue
    }
    const cnt = industryCount.get(ind) ?? 0
    if (cnt >= maxPerIndustry) continue
    industryCount.set(ind, cnt + 1)
    out.push(s)
  }
  return out
}

/** 组合行业分布统计 */
export function industryBreakdown(scored: StockScore[]): Array<{
  industry: string
  count: number
  avgScore: number
}> {
  const groups = new Map<string, { count: number; sum: number }>()
  for (const s of scored) {
    const ind = s.industry ?? '未知'
    const g = groups.get(ind) ?? { count: 0, sum: 0 }
    g.count++
    g.sum += s.totalScore
    groups.set(ind, g)
  }
  return [...groups.entries()]
    .map(([industry, g]) => ({
      industry,
      count: g.count,
      avgScore: g.count > 0 ? g.sum / g.count : 0,
    }))
    .sort((a, b) => b.count - a.count)
}
