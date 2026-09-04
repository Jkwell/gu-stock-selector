import type { DailyPick } from '../types'

/**
 * 组合透视分析（纯函数）
 * 分析今日推荐多只股票在行业/概念上的重叠度，判断组合真实分散度，
 * 输出风险等级与组合层面建议。
 *
 * 注意：DailyPick.concept 来自东财 f128，是逗号拼接的多概念串
 * （如 "融资融券,MSCI中国,光模块,..."），且包含大量几乎每只都有的
 * 通用概念（融资融券/沪股通/MSCI…），必须拆分并过滤后才算真实题材重叠。
 */

export interface PortfolioView {
  industryGroups: Array<{ industry: string; count: number; names: string[] }> // 按行业分组（含 count=1，'未知' 单独）
  sharedConcepts: Array<{ concept: string; count: number; names: string[] }> // 被 ≥2 只共有且非通用概念
  riskLevel: 'low' | 'medium' | 'high'
  advice: string
}

/** 通用/非题材概念黑名单（几乎每只股票都有的标签，不计入"扎堆"） */
export const GENERIC_CONCEPTS = new Set([
  '融资融券',
  '沪股通',
  '深股通',
  'MSCI中国',
  '标准普尔',
  '富时罗素',
  '标普道琼斯A股',
  '转融券标的',
  '机构重仓',
  '社保重仓',
  '基金重仓',
  'QFII重仓',
  '破净股',
  '低价股',
  '国企改革',
  '央企改革',
  '预盈预增',
  '预亏预减',
  '股权激励',
  '送转预期',
  '高送转',
  '昨日涨停',
  '昨日连板',
  '举牌',
  '参股金融',
  '参股银行',
  '参股保险',
  '创投',
  '西部开发',
  '一带一路',
  '垃圾分类',
])

/** 拆分概念串：split + trim + 去空 + 过滤通用概念 */
function splitConcepts(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !GENERIC_CONCEPTS.has(c))
}

/** 行业归一化：去掉东财分类的罗马数字后缀（如 银行Ⅱ → 银行），避免 Ⅱ/Ⅲ 被误判为两个行业 */
function normalizeIndustry(raw: string | undefined): string {
  const t = (raw ?? '').trim()
  if (!t) return '未知'
  return t.replace(/^(.+?)[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+$/, '$1')
}

export function analyzePortfolio(picks: DailyPick[]): PortfolioView {
  // ---- 行业分组（归一化，银行Ⅱ/银行Ⅲ 归并为 银行） ----
  const industryMap = new Map<string, { count: number; names: string[] }>()
  for (const p of picks) {
    const ind = normalizeIndustry(p.industry)
    const g = industryMap.get(ind) ?? { count: 0, names: [] }
    g.count++
    g.names.push(p.name)
    industryMap.set(ind, g)
  }
  const industryGroups = [...industryMap.entries()]
    .map(([industry, g]) => ({ industry, ...g }))
    .sort((a, b) => b.count - a.count)

  // ---- 概念重叠 ----
  const conceptMap = new Map<string, { count: number; names: string[] }>()
  for (const p of picks) {
    const seen = new Set<string>() // 同一只票内的重复概念只计一次
    for (const c of splitConcepts(p.concept)) {
      if (seen.has(c)) continue
      seen.add(c)
      const g = conceptMap.get(c) ?? { count: 0, names: [] }
      g.count++
      g.names.push(p.name)
      conceptMap.set(c, g)
    }
  }
  const sharedConcepts = [...conceptMap.entries()]
    .filter(([, g]) => g.count >= 2)
    .map(([concept, g]) => ({ concept, ...g }))
    .sort((a, b) => b.count - a.count)

  // ---- 风险等级 ----
  const realIndustries = industryGroups.filter((g) => g.industry !== '未知')
  const maxIndustryCount = realIndustries.length > 0 ? realIndustries[0].count : 0
  const maxConceptCount = sharedConcepts.length > 0 ? sharedConcepts[0].count : 0

  let riskLevel: PortfolioView['riskLevel'] = 'low'
  if (maxIndustryCount >= 3 || maxConceptCount >= 3) riskLevel = 'high'
  else if (maxIndustryCount === 2 || maxConceptCount === 2) riskLevel = 'medium'

  // 主要扎堆方向：取行业 / 概念中 count 更大的那个（并列取行业，更直观）
  const topIndustry = realIndustries[0]
  const topConcept = sharedConcepts[0]
  const useConcept =
    topConcept !== undefined && (topIndustry === undefined || topConcept.count > topIndustry.count)
  const focusCount = useConcept ? (topConcept?.count ?? 0) : (topIndustry?.count ?? 0)
  const focusNames = useConcept ? (topConcept?.names ?? []) : (topIndustry?.names ?? [])
  const focusLabel = useConcept
    ? (topConcept?.concept ?? '')
    : (topIndustry?.industry ?? '')

  // 不在主要扎堆组里的票（不同方向的其余暴露）
  const focusNameSet = new Set(focusNames)
  const others = picks
    .filter((p) => !focusNameSet.has(p.name))
    .map((p) => `${p.name}（${normalizeIndustry(p.industry)}）`)

  // ---- 建议文案 ----
  let advice: string
  if (riskLevel === 'high') {
    advice = `组合高度集中：${focusCount} 只（${focusNames.join('、')}）都集中在「${focusLabel}」，这 ${focusCount} 只才是同涨同跌的方向，分散度低。${
      others.length > 0
        ? `其余 ${others.length} 只（${others.join('、')}）是不同方向，可另行评估。`
        : ''
    }建议在「${focusLabel}」里只留评分最高的 1 只。`
  } else if (riskLevel === 'medium') {
    advice = `有 ${focusCount} 只（${focusNames.join('、')}）都属「${focusLabel}」，方向重叠。建议这 ${focusCount} 只最多留 1 只，另一只从不同方向里挑，保持组合分散。`
  } else {
    advice = `行业/概念分散良好，${picks.length} 只方向互不重叠。可适当等权分配，但仍建议单票 ≤20% 仓位。`
  }

  return { industryGroups, sharedConcepts, riskLevel, advice }
}
