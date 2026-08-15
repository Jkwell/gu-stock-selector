import type { FactorDef, SelectConfig } from '../types'

/** 默认因子权重模板（权重之和为 1） */
export const DEFAULT_FACTORS: FactorDef[] = [
  {
    key: 'trend',
    name: '趋势强度',
    group: 'technical',
    weight: 0.15,
    enabled: true,
    desc: '收盘价相对 20/60 日均线的位置，价格越在均线上方得分越高',
  },
  {
    key: 'macd',
    name: 'MACD 动量',
    group: 'technical',
    weight: 0.12,
    enabled: true,
    desc: 'DIF 与 DEA 关系、MACD 柱体方向，金叉且柱体放大得分高',
  },
  {
    key: 'rsi',
    name: 'RSI 状态',
    group: 'technical',
    weight: 0.07,
    enabled: true,
    desc: 'RSI(14)，30~55 回升区得分高，超买(>75)与超卖(<20)得分低',
  },
  {
    key: 'volume',
    name: '成交量异动',
    group: 'technical',
    weight: 0.07,
    enabled: true,
    desc: '当日量 / 20 日均量，温和放量(1.2~3倍)得分高，放天量得分低',
  },
  {
    key: 'momentum_1m',
    name: '动量(1月)',
    group: 'technical',
    weight: 0.09,
    enabled: true,
    desc: '过去 20 个交易日涨幅，涨幅越大动量越强',
  },
  {
    key: 'momentum_3m',
    name: '动量(3月)',
    group: 'technical',
    weight: 0.06,
    enabled: true,
    desc: '过去 60 个交易日涨幅，A 股中期动量效应',
  },
  {
    key: 'reversal',
    name: '短期反转',
    group: 'technical',
    weight: 0.04,
    enabled: true,
    desc: '过去 5 日跌幅越大得分越高（超跌反弹逻辑）',
  },
  {
    key: 'volatility',
    name: '低波动',
    group: 'technical',
    weight: 0.04,
    enabled: true,
    desc: '20 日年化波动率，低波动溢价，波动越小得分越高',
  },
  {
    key: 'valuation',
    name: '估值水平',
    group: 'fundamental',
    weight: 0.16,
    enabled: true,
    desc: '基于 PE 在行业/全市场的分位点，分位越低得分越高（行业中性化）',
  },
  {
    key: 'profitability',
    name: '盈利能力',
    group: 'fundamental',
    weight: 0.08,
    enabled: true,
    desc: '基于 ROE，ROE 越高得分越高',
  },
  {
    key: 'growth',
    name: '成长性',
    group: 'fundamental',
    weight: 0.08,
    enabled: true,
    desc: '基于营收/净利润同比增速，增速越高得分越高',
  },
  {
    key: 'moneyflow',
    name: '主力净流入',
    group: 'money',
    weight: 0.04,
    enabled: true,
    desc: '主力净流入占流通市值比例，流入越多得分越高',
  },
  {
    key: 'short_momentum',
    name: '3日爆发力',
    group: 'technical',
    weight: 0,
    enabled: false,
    desc: '过去 3 个交易日涨幅，短线龙头核心特征',
  },
  {
    key: 'breakout',
    name: '创新高',
    group: 'technical',
    weight: 0,
    enabled: false,
    desc: '现价相对近 20 日最高价，突破/接近新高得分高',
  },
  {
    key: 'limit_up',
    name: '连板高度',
    group: 'technical',
    weight: 0,
    enabled: false,
    desc: '连续涨停天数，识别空间板龙头（2-4 板黄金期）',
  },
  {
    key: 'ma_squeeze',
    name: '均线粘合突破',
    group: 'technical',
    weight: 0,
    enabled: false,
    desc: 'MA5/20/60 粘合后放量突破 = 启动信号，配合回踩低吸',
  },
  {
    key: 'moneyflow_5d',
    name: '资金趋势',
    group: 'money',
    weight: 0,
    enabled: false,
    desc: '近5日主力净流入合计，识别吸筹/出货，防单日骗线',
  },
]

export const DEFAULT_CONFIG: SelectConfig = {
  pool: 'all',
  factors: DEFAULT_FACTORS.map((f) => ({ ...f })),
  excludeST: true,
  excludeKcb: true,
  excludeCyb: true,
  minMvYiyi: 0,
  maxResults: 100,
  candidatePool: 'marketcap',
  candidateCount: 200,
  diversify: true,
  maxPerIndustry: 3,
  sector: 'all',
  requireUptrend: true,
  marketGate: true,
  minRiskReward: 1.5,
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

/** 策略模板预设（权重之和为 1） */
export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    key: 'balanced',
    name: '⚖️ 均衡配置',
    desc: '技术面 50% + 基本面 40% + 资金面 10%，各维度均衡，适合长线',
    pool: 'all',
    candidateCount: 200,
    candidatePool: 'marketcap',
    weights: {
      trend: 0.15, macd: 0.12, rsi: 0.07, volume: 0.07,
      momentum_1m: 0.09, momentum_3m: 0.06, reversal: 0.04, volatility: 0.04,
      valuation: 0.16, profitability: 0.08, growth: 0.08,
      moneyflow: 0.04,
    },
  },
  {
    key: 'value',
    name: '💎 价值精选',
    desc: '估值 40% + 盈利 20% + 成长 15%，偏基本面，适合低估值抄底',
    pool: 'hs300',
    candidateCount: 150,
    candidatePool: 'marketcap',
    weights: {
      valuation: 0.4, profitability: 0.2, growth: 0.15,
      trend: 0.1, volume: 0.05,
      moneyflow: 0.1,
    },
  },
  {
    key: 'growth',
    name: '🚀 成长先锋',
    desc: '成长 35% + 盈利 25% + 估值 15%，追高成长股',
    pool: 'zz500',
    candidateCount: 200,
    candidatePool: 'marketcap',
    weights: {
      growth: 0.35, profitability: 0.25, valuation: 0.15,
      trend: 0.1, momentum_1m: 0.1, volume: 0.05,
    },
  },
  {
    key: 'momentum',
    name: '📈 动量追击',
    desc: '纯技术面 85%，趋势/动量/资金驱动，适合波段',
    pool: 'all',
    candidateCount: 250,
    candidatePool: 'momentum',
    weights: {
      trend: 0.2, momentum_1m: 0.2, momentum_3m: 0.15, macd: 0.15,
      volume: 0.1, moneyflow: 0.05, volatility: 0.05, rsi: 0.05,
    },
  },
  {
    key: 'quality',
    name: '🏆 质量优选',
    desc: '盈利 30% + 成长 25% + 估值 20%，高 ROE 优质公司',
    pool: 'hs300',
    candidateCount: 150,
    candidatePool: 'marketcap',
    weights: {
      profitability: 0.3, growth: 0.25, valuation: 0.2,
      trend: 0.1, moneyflow: 0.1, volatility: 0.05,
    },
  },
  {
    key: 'strong',
    name: '🔥 强势领涨',
    desc: '短线强势股：连板+3日爆发力+创新高+主力资金，回踩低吸',
    pool: 'all',
    candidateCount: 300,
    candidatePool: 'turnover',
    weights: {
      limit_up: 0.15,
      short_momentum: 0.2,
      breakout: 0.15,
      moneyflow: 0.15,
      trend: 0.1,
      volume: 0.1,
      momentum_1m: 0.1,
      macd: 0.05,
    },
  },
  {
    key: 'concept_leader',
    name: '🔥 题材龙头',
    desc: '从当日最强概念题材里选领涨股（光模块/算力这类风口的龙头）',
    pool: 'all',
    candidateCount: 500,
    candidatePool: 'turnover',
    weights: {
      short_momentum: 0.3,
      breakout: 0.3,
      volume: 0.2,
      moneyflow: 0.2,
    },
  },
  {
    key: 'gentle_volume',
    name: '📈 温和放量',
    desc: '东财条件选股：量比1.2~5 + 换手5~15% + 涨跌幅1~6%，资金温和活跃不追高',
    pool: 'all',
    candidateCount: 500,
    candidatePool: 'turnover',
    weights: {
      volume: 0.35,
      short_momentum: 0.2,
      moneyflow: 0.2,
      trend: 0.15,
      macd: 0.1,
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
