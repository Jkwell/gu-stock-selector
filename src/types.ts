/** 单根日 K 线数据 */
export interface Kline {
  date: string // 'YYYY-MM-DD'
  open: number
  close: number
  high: number
  low: number
  volume: number // 成交量（手）
  amount: number // 成交额（元）
}

/** 股票基础信息 */
export interface StockInfo {
  code: string // 6 位代码
  name: string
  market: 'sh' | 'sz' | 'bj' // 上交所 / 深交所 / 北交所
  industry?: string // 行业（用于行业中性化）
  concept?: string // 概念板块（第一个，用于题材热点识别）
  // 可选：实时行情快照
  price?: number
  changePct?: number
  totalMv?: number // 总市值（元）
  floatMv?: number // 流通市值（元）
  pe?: number // 市盈率 TTM
  pb?: number // 市净率
  turnoverRate?: number // 换手率 %
}

/** 财务指标（季度） */
export interface Financials {
  code: string
  reportDate: string // 报告期，如 '2024-06-30'
  roe?: number // 净资产收益率 %
  revenueGrowth?: number // 营收同比增速 %
  profitGrowth?: number // 净利润同比增速 %
  debtRatio?: number // 资产负债率 %
  grossMargin?: number // 毛利率 %
}

/** 资金流向快照 */
export interface MoneyFlow {
  code: string
  mainNetInflow: number // 主力净流入（元）
  superNetInflow: number // 超大单净流入（元）
  bigNetInflow: number // 大单净流入（元）
  date: string
}

/** 因子定义 */
export interface FactorDef {
  key: string // 唯一标识，如 'trend'
  name: string // 中文名，如 '趋势强度'
  group: 'technical' | 'fundamental' | 'money' // 所属类别
  weight: number // 权重 0~1（自动归一化）
  enabled: boolean // 是否启用
  desc: string // 说明
}

/** 因子得分结果 */
export interface FactorScore {
  key: string
  name: string
  group: FactorDef['group']
  rawValue: number | null // 原始值（可能因为缺数据为 null）
  score: number // 0~100 归一化得分
  weight: number // 实际参与计算的权重
  detail: string // 展示用的可读说明
}

/** 单只股票的综合评分结果 */
export interface StockScore {
  code: string
  name: string
  market: StockInfo['market']
  industry?: string
  concept?: string
  highRisk?: boolean // 高位风险预警
  totalScore: number // 0~100
  price?: number
  changePct?: number
  factorScores: FactorScore[]
}

/** 选股配置 */
export interface SelectConfig {
  pool: 'all' | 'hs300' | 'zz500'
  factors: FactorDef[]
  excludeST: boolean
  excludeKcb: boolean // 排除科创板（688）
  excludeCyb: boolean // 排除创业板（300/301）
  minMvYiyi: number // 最小总市值（亿元），0 表示不限
  maxResults: number // 最大返回条数
  /** 候选池排序方式：动量(今日涨幅)/流动性(市值)/换手率(资金活跃)/规模(市值) */
  candidatePool: 'momentum' | 'liquid' | 'turnover' | 'marketcap'
  candidateCount: number // 候选池大小（决定拉取 K 线的数量）
  /** 组合优化：行业分散 */
  diversify: boolean
  maxPerIndustry: number // 每个行业最多入选数量
  /** 板块过滤：'all' 表示不限制，其他为行业名 */
  sector: string
  /** 温和放量：是否要求上升趋势（MA20>MA60 + 站上MA20 + MA20拐头），默认 true */
  requireUptrend?: boolean
}

/** 打分流水线产出 */
export interface SelectionResult {
  config: SelectConfig
  scored: StockScore[]
  totalScanned: number
  skipped: number // 因缺数据/过滤跳过
  computedAt: string
}

/** 今日推荐单只股票（含买卖点） */
export interface DailyPick {
  code: string
  name: string
  industry?: string // 行业（通信设备/造纸）
  concept?: string // 概念题材（光模块/算力）
  market: StockInfo['market']
  totalScore: number // 综合评分 0-100
  factorScores: FactorScore[] // 入选因子明细
  price?: number // 实时价
  changePct?: number
  // 买卖点
  buyLow: number
  buyHigh: number
  takeProfit: number
  stopLoss: number
  riskReward: number
  reasons: string[]
  oneWord?: boolean // 一字板（买不进）
  highRisk?: boolean // 高位风险预警
}

/** 今日推荐产出 */
export interface DailyPickResult {
  picks: DailyPick[]
  computedAt: string
  isTailPeriod: boolean // 是否尾盘时段（14:30-15:00）
}

// ─────────────── AI 研报（tradingAgents-astock 多智能体分析）───────────────

/** 后端流水线阶段状态 */
export type AIStageStatus = 'pending' | 'active' | 'done'

export interface AIStage {
  id: string
  name: string
  icon: string
  status: AIStageStatus
}

export type AIJobStatus = 'queued' | 'running' | 'done' | 'error'

/** 任务轮询信息（来自 GET /api/ai-report/{id}） */
export interface AIJobInfo {
  status: AIJobStatus
  current_stage: string
  progress: AIStage[]
  error?: string | null
}

/** 完整研报（来自 GET /api/ai-report/{id}/result） */
export interface AIReport {
  ticker: string
  label: string
  name?: string // 前端补充的股票名称
  trade_date: string
  run_time?: string
  duration_seconds?: number
  signal: string // Buy / Overweight / Hold / Underweight / Sell
  reports: Record<string, string>
  jobId?: string // 本地保存用
  savedAt?: string // 本地保存用
}

/** 12 阶段定义（与后端 PIPELINE_STAGES 一致，前端渲染用） */
export const AI_STAGES: Array<{ id: string; name: string; icon: string }> = [
  { id: 'market', name: '技术分析', icon: '📊' },
  { id: 'social', name: '情绪分析', icon: '💬' },
  { id: 'news', name: '新闻舆情', icon: '📰' },
  { id: 'fundamentals', name: '基本面', icon: '📋' },
  { id: 'policy', name: '政策分析', icon: '🏛️' },
  { id: 'hot_money', name: '游资追踪', icon: '🔥' },
  { id: 'lockup', name: '解禁监控', icon: '🔒' },
  { id: 'quality_gate', name: '质量门控', icon: '✅' },
  { id: 'debate', name: '多空辩论', icon: '⚔️' },
  { id: 'trader', name: '交易决策', icon: '💹' },
  { id: 'risk', name: '风控评估', icon: '🛡️' },
  { id: 'pm', name: '最终决策', icon: '👔' },
]

/** 报告分区 key → 中文标题（未列出的 key 不展示） */
export const AI_REPORT_TITLES: Record<string, { title: string; icon: string }> = {
  market_report: { title: '技术分析', icon: '📊' },
  sentiment_report: { title: '情绪分析', icon: '💬' },
  news_report: { title: '新闻舆情', icon: '📰' },
  fundamentals_report: { title: '基本面', icon: '📋' },
  policy_report: { title: '政策分析', icon: '🏛️' },
  hot_money_report: { title: '游资追踪', icon: '🔥' },
  lockup_report: { title: '解禁监控', icon: '🔒' },
  bull_history: { title: '多方观点', icon: '🟢' },
  bear_history: { title: '空方观点', icon: '🔴' },
  research_manager: { title: '研究员裁决', icon: '⚖️' },
  investment_plan: { title: '投资计划', icon: '📝' },
  trader_investment_plan: { title: '交易方案', icon: '💹' },
  aggressive_analyst: { title: '激进风控', icon: '🔥' },
  conservative_analyst: { title: '保守风控', icon: '🐢' },
  neutral_analyst: { title: '中立风控', icon: '⚖️' },
  portfolio_manager: { title: '投资经理决策', icon: '👔' },
  final_trade_decision: { title: '最终交易决策', icon: '⭐' },
}

/** 五档评级 → 展示文案/颜色类 */
export const AI_RATING_MAP: Record<string, { label: string; cls: string }> = {
  Buy: { label: '买入', cls: 'rating-buy' },
  Overweight: { label: '偏多', cls: 'rating-overweight' },
  Hold: { label: '中性', cls: 'rating-hold' },
  Underweight: { label: '偏空', cls: 'rating-underweight' },
  Sell: { label: '卖出', cls: 'rating-sell' },
}
