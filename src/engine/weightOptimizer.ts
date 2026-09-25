import type { FactorDef } from '../types'
import type { FactorIC } from './icAnalysis'

/**
 * IC 驱动权重优化引擎
 * 把因子 IC 分析结果（每个因子对未来 N 日收益的预测能力）映射回因子权重，
 * 替代人工"拍脑袋"权重。核心思路：IC 越强越稳定 → 权重越高；负 IC / 不稳定 → 降权或剔除。
 *
 * 规则（保守策略，防止过拟合）：
 * 1. 权重基础 = |meanIC|，IC 越强权重越高
 * 2. meanIC < -0.01 且 |tStat| > 1.5（显著负相关）→ 权重归零并禁用（方向反了，剔除）
 * 3. |tStat| < 1.0（IC 不稳定，统计上不显著）→ 权重上限压到 0.05，防止靠运气加码
 * 4. 两因子 IC 序列相关性 > 0.7 → 合并权重（各取一半，防止重复加码）
 * 5. 归一化到总和为 1，保留未参与 IC 分析因子（如基本面）的原有配置
 */

/** 建议权重结果：每个因子的建议配置 + 优化说明 */
export interface WeightSuggestion {
  key: string
  name: string
  currentWeight: number
  suggestedWeight: number
  meanIC: number | null // null = 无 IC 数据（如基本面因子）
  tStat: number | null
  disabled: boolean // 建议禁用
  note: string // 优化理由（可读）
}

/**
 * 基于 IC 结果生成权重建议
 * @param icResults 因子 IC 分析结果（仅技术因子）
 * @param factorDefs 当前因子配置（全量，含基本面/资金流）
 * @param factorCorr 因子 IC 序列相关性（可选，来自 computeFactorCorrelation）
 * @returns 建议的 FactorDef[] + 可读建议明细
 */
export function optimizeWeightsFromIC(
  icResults: FactorIC[],
  factorDefs: FactorDef[],
  factorCorr?: Array<{ a: string; b: string; corr: number }>,
): { factors: FactorDef[]; suggestions: WeightSuggestion[] } {
  const icMap = new Map(icResults.map((ic) => [ic.key, ic]))
  const suggestions: WeightSuggestion[] = []

  // 1. 每个因子 → 原始建议权重（含正负方向）
  const rawWeight = new Map<string, number>()
  const notes = new Map<string, string>()
  const disabled = new Set<string>()

  for (const f of factorDefs) {
    const ic = icMap.get(f.key)
    if (!ic || ic.icSeries.length === 0) {
      // 无 IC 数据（基本面/资金流因子不参与 IC 分析）：保留原权重
      rawWeight.set(f.key, f.enabled ? f.weight : 0)
      suggestions.push({
        key: f.key, name: f.name, currentWeight: f.weight,
        suggestedWeight: f.enabled ? f.weight : 0,
        meanIC: null, tStat: null, disabled: !f.enabled,
        note: '无 IC 数据（非技术因子），保留当前权重',
      })
      continue
    }

    const { meanIC, tStat } = ic
    let w = Math.abs(meanIC)
    let note = ''
    let dis = false

    if (meanIC < -0.01 && Math.abs(tStat) > 1.5) {
      // 显著负 IC：因子方向反了，剔除
      w = 0
      dis = true
      note = `IC 显著为负（${meanIC.toFixed(3)}，t=${tStat.toFixed(1)}），方向与收益相反，建议禁用`
    } else if (Math.abs(tStat) < 1.0) {
      // IC 不稳定：限制权重，防过拟合
      w = Math.min(w, 0.05)
      note = `IC 不稳定（t=${tStat.toFixed(1)} < 1），权重上限压到 5%`
    } else {
      note = `IC=${meanIC.toFixed(3)}（t=${tStat.toFixed(1)}），按强度加权`
    }

    rawWeight.set(f.key, w)
    notes.set(f.key, note)
    if (dis) disabled.add(f.key)
    suggestions.push({
      key: f.key, name: f.name, currentWeight: f.weight, suggestedWeight: 0,
      meanIC, tStat, disabled: dis, note,
    })
  }

  // 2. 高相关因子合并权重（IC 序列相关性 > 0.7 → 重复信息，各取一半）
  if (factorCorr) {
    for (const { a, b, corr } of factorCorr) {
      if (corr > 0.7 && !disabled.has(a) && !disabled.has(b)) {
        const wa = rawWeight.get(a) ?? 0
        const wb = rawWeight.get(b) ?? 0
        const merged = (wa + wb) / 2
        rawWeight.set(a, merged)
        rawWeight.set(b, merged)
        notes.set(a, `与 ${b} IC 相关性 ${corr.toFixed(2)}（重复信息），权重合并减半`)
        notes.set(b, `与 ${a} IC 相关性 ${corr.toFixed(2)}（重复信息），权重合并减半`)
      }
    }
  }

  // 3. 归一化（仅对参与 IC 优化且未禁用的技术因子）。
  // 若配置同时包含基本面/资金面，技术组只保留原预算，避免 IC 优化改变组间风险暴露。
  const active = factorDefs
    .map((f) => f.key)
    .filter((k) => icMap.has(k) && !disabled.has(k) && (rawWeight.get(k) ?? 0) > 0)
  const total = active.reduce((s, k) => s + (rawWeight.get(k) ?? 0), 0)
  const norm = total > 0 ? total : 1
  const hasNonTechnical = factorDefs.some((f) => f.enabled && f.group !== 'technical')
  const technicalBudget = hasNonTechnical
    ? factorDefs
        .filter((f) => f.enabled && f.group === 'technical')
        .reduce((s, f) => s + f.weight, 0)
    : 1
  const weightOf = new Map<string, number>()
  for (const k of active) {
    weightOf.set(k, ((rawWeight.get(k) ?? 0) / norm) * technicalBudget)
  }

  // 4. 不稳定因子硬性 cap ≤ 0.05（在预算归一化后应用）
  //    溢出部分按比例重分给未受限因子，保证技术组预算不变
  const unstableKeys = new Set<string>()
  for (const f of factorDefs) {
    const ic = icMap.get(f.key)
    if (ic && Math.abs(ic.tStat) < 1.0 && !disabled.has(f.key)) unstableKeys.add(f.key)
  }
  for (let iter = 0; iter < 10; iter++) {
    let overflow = 0
    for (const k of unstableKeys) {
      const w = weightOf.get(k) ?? 0
      if (w > 0.05) {
        overflow += w - 0.05
        weightOf.set(k, 0.05)
      }
    }
    if (overflow <= 1e-9) break
    const freeKeys = active.filter(
      (k) => !unstableKeys.has(k) || (weightOf.get(k) ?? 0) < 0.05,
    )
    const freeTotal = freeKeys.reduce((s, k) => s + (weightOf.get(k) ?? 0), 0)
    if (freeTotal <= 0) break
    for (const k of freeKeys) {
      const cur = weightOf.get(k) ?? 0
      weightOf.set(k, cur + overflow * (cur / freeTotal))
    }
  }

  // 5. 生成新配置（保留原 name/group/desc，更新 weight/enabled）
  const factors = factorDefs.map((f) => {
    if (!icMap.has(f.key)) return { ...f } // 非技术因子原样保留
    const w = weightOf.get(f.key) ?? 0
    const dis = disabled.has(f.key) || w <= 0
    return { ...f, weight: w, enabled: !dis }
  })

  // 6. 回填建议权重（归一化后的）
  const filled = factors.map((f, i) => ({ ...suggestions[i], suggestedWeight: f.weight, disabled: !f.enabled, note: notes.get(f.key) ?? suggestions[i].note }))

  return { factors, suggestions: filled }
}
