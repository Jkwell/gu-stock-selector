import type { FactorDef, SelectConfig } from '../types'

/**
 * 默认因子：主推「缩量蓄势突破」策略。
 * 核心形态评分与回测共用严格定义，其他因子仅作为排序辅助。
 */
export const DEFAULT_FACTORS: FactorDef[] = [
  {
    key: 'shrink_surge',
    name: '缩量蓄势突破',
    group: 'technical',
    weight: 0.5,
    enabled: true,
    desc: '前期放量→缩量洗盘→平台突破；仅使用当前及历史K线',
  },
  {
    key: 'pullback',
    name: '回踩低吸',
    group: 'technical',
    weight: 0,
    enabled: false,
    desc: '前期涨停+突破过+回踩MA5/MA10缩量企稳，低吸埋伏点',
  },
  {
    key: 'platform',
    name: '平台突破',
    group: 'technical',
    weight: 0,
    enabled: false,
    desc: '横盘平台+放量突破上沿+上升趋势（配合分时踩均线确认买点）',
  },
  {
    key: 'entry_fit',
    name: '买点契合',
    group: 'technical',
    weight: 0.15,
    enabled: true,
    desc: '价格靠近支撑位程度，越靠近买点分越高',
  },
  {
    key: 'accumulation',
    name: '吸筹痕迹',
    group: 'money',
    weight: 0.12,
    enabled: true,
    desc: '大单买入+小单卖出=主力建仓',
  },
  {
    key: 'moneyflow',
    name: '主力净流入',
    group: 'money',
    weight: 0.1,
    enabled: true,
    desc: '主力净流入占流通市值比例，流入越多得分越高',
  },
  {
    key: 'sector_heat',
    name: '板块热度',
    group: 'technical',
    weight: 0.08,
    enabled: true,
    desc: '板块内相对热度排名',
  },
  {
    key: 'moneyflow_5d',
    name: '资金趋势',
    group: 'money',
    weight: 0.05,
    enabled: true,
    desc: '近5日主力净流入合计，识别持续吸筹（用于排序参考）',
  },
]

export const DEFAULT_CONFIG: SelectConfig = {
  pool: 'all',
  factors: DEFAULT_FACTORS.map((f) => ({ ...f })),
  excludeST: true,
  excludeKcb: true,
  excludeCyb: true,
  minMvYiyi: 0,
  maxResults: 400,
  candidatePool: 'turnover',
  candidateCount: 60, // 优化：从100减到60，速度优先（60÷5×150ms=1.8秒）
  diversify: false,
  maxPerIndustry: 0, // 0 = 不限行业数量
  sector: 'all',
  requireUptrend: true,
}

/** 策略模板：预设因子权重组合 */
export interface StrategyTemplate {
  key: string
  name: string
  desc: string
  /** 覆盖的因子权重，未列出的因子自动设为 0 并禁用 */
  weights: Record<string, number>
  /** 推荐的股票池 */
  pool: SelectConfig['pool']
  candidateCount: number
  /** 候选池排序方式 */
  candidatePool: SelectConfig['candidatePool']
}

/**
 * 策略模板：主推「缩量蓄势突破」。历史回测结果取决于样本区间，页面不承诺未来收益。
 */
export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    key: 'shrink_surge',
    name: '🏆 缩量蓄势突破（推荐）',
    desc: '前期放量→缩量洗盘→平台突破（与校正后的回测口径一致）',
    pool: 'all',
    candidateCount: 80, // 优化：从150减到80，速度优先（80÷5×150ms=2.4秒）
    candidatePool: 'turnover',
    weights: {
      shrink_surge: 0.5,
      entry_fit: 0.15,
      accumulation: 0.12,
      moneyflow: 0.1,
      sector_heat: 0.08,
      moneyflow_5d: 0.05,
    },
  },
  {
    key: 'pullback',
    name: '📈 回踩低吸',
    desc: '前期涨停+突破过+回踩均线缩量企稳，低吸埋伏（不追突破）',
    pool: 'all',
    candidateCount: 80, // 优化：速度优先（80÷5×150ms=2.4秒）
    candidatePool: 'turnover',
    weights: {
      pullback: 0.3,
      entry_fit: 0.15,
      accumulation: 0.15,
      moneyflow: 0.12,
      sector_heat: 0.1,
      moneyflow_5d: 0.18,
    },
  },
  {
    key: 'platform',
    name: '🚀 平台突破',
    desc: '横盘平台+放量突破上沿+上升趋势+大单买入（尾盘看分时踩均线不破再买）',
    pool: 'all',
    candidateCount: 80, // 优化：速度优先（80÷5×150ms=2.4秒）
    candidatePool: 'turnover',
    weights: {
      platform: 0.36,
      accumulation: 0.17,
      moneyflow: 0.12,
      sector_heat: 0.1,
      entry_fit: 0.07,
      moneyflow_5d: 0.18,
    },
  },
]

/** 将策略模板转换为 SelectConfig（未覆盖因子自动禁用） */
export function applyTemplate(
  template: StrategyTemplate,
  base: SelectConfig,
): SelectConfig {
  const factors = base.factors.map((f) => {
    const w = template.weights[f.key]
    return {
      ...f,
      weight: w !== undefined ? w : 0,
      enabled: w !== undefined && w > 0,
    }
  })
  return {
    ...base,
    pool: template.pool,
    factors,
    candidateCount: template.candidateCount,
    candidatePool: template.candidatePool,
  }
}
