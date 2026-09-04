import { useEffect, useMemo, useRef, useState } from 'react'
import type { Kline, StockInfo } from '../types'
import { fetchKline, fetchRealtimeQuotes, marketOfCode, fetchMoneyFlow, fetchMoneyFlowHistory, fetchMinuteData, type MinutePoint } from '../data/api'
import { analyzeStock, type StockAnalysis } from '../engine/stockAnalysis'
import { analyzeStockSelection, analyzeKlinePatterns, analyzeGaps, analyzeTrendMomentum, analyzeBuyDecision, detectDivergence, analyzeMoneyFlowTrend, type SelectionMetrics, type KlinePatternAnalysis, type GapAnalysis, type TrendMomentum, type BuyDecision, type DivergenceSignal, type MoneyFlowTrend } from '../engine/tradingSignals'
import { computeSectorHeat, type SectorHeat } from '../engine/sectorInfo'
import { computeMarketSentiment } from '../engine/marketSentiment'
import { fetchMarketStocks } from '../data/pipeline'
import type { MarketSentiment } from '../engine/marketSentiment'
import { getPickRecords } from '../data/records'
import { getWatchlist, addToWatchlist, watchItemFrom } from '../data/watchlist'
import { addPosition, getPositions } from '../data/positions'
import { computeStockSectorInfo, judgeSector, type SectorJudgment } from '../engine/sectorInfo'
import KLineChart from './charts/KLineChart'
import MinuteChart from './charts/MinuteChart'

/** 资金格式化 */
function fmtFlow(v?: number) {
  if (v === undefined || v === null || Number.isNaN(v)) return '--'
  const yi = v / 10000
  if (Math.abs(yi) >= 1) return `${yi >= 0 ? '+' : ''}${yi.toFixed(2)}亿`
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)}万`
}

/** 市值格式化 */
function fmtMv(v?: number) {
  if (v === undefined || v === null || Number.isNaN(v)) return '--'
  const yi = v / 1e8
  if (yi >= 1) return `${yi.toFixed(1)}亿`
  return `${(v / 1e4).toFixed(0)}万`
}

/** 按名称搜索全市场股票索引：精确 → 前缀 → 包含 */
function searchStocks(list: StockInfo[], q: string): StockInfo[] {
  const norm = q.trim()
  if (!norm) return []
  const exact = list.filter((s) => s.name === norm)
  if (exact.length > 0) return exact.slice(0, 10)
  const starts = list.filter((s) => s.name.startsWith(norm))
  const contains = list.filter((s) => s.name.includes(norm) && !s.name.startsWith(norm))
  return [...starts, ...contains].slice(0, 10)
}

const VERDICT_CLS: Record<string, string> = {
  buy: 'sa-buy',
  watch: 'sa-watch',
  avoid: 'sa-avoid',
}

export default function StockAnalysisPanel() {
  const [query, setQuery] = useState('')
  const [stocks, setStocks] = useState<StockInfo[]>([])
  const [indexReady, setIndexReady] = useState(false)
  const [suggestions, setSuggestions] = useState<StockInfo[]>([])
  const [showSug, setShowSug] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<StockAnalysis | null>(null)
  const [kline, setKline] = useState<Kline[]>([])
  const [sentiment, setSentiment] = useState<MarketSentiment | null>(null)
  const [sectorJudgment, setSectorJudgment] = useState<SectorJudgment | null>(null)
  const [moneyFlow, setMoneyFlow] = useState<{ mainNetInflow: number; superNetInflow: number; bigNetInflow: number } | null>(null)
  const [moneyFlowSum, setMoneyFlowSum] = useState<number>(0)
  const [stockSnapshot, setStockSnapshot] = useState<StockInfo | null>(null)
  const [selectionMetrics, setSelectionMetrics] = useState<SelectionMetrics | null>(null)
  const [klinePatterns, setKlinePatterns] = useState<KlinePatternAnalysis | null>(null)
  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysis | null>(null)
  const [trendMomentum, setTrendMomentum] = useState<TrendMomentum | null>(null)
  const [divergence, setDivergence] = useState<DivergenceSignal | null>(null)
  const [moneyFlowTrend, setMoneyFlowTrend] = useState<MoneyFlowTrend | null>(null)
  const [buyDecision, setBuyDecision] = useState<BuyDecision | null>(null)
  const [sectorHeat, setSectorHeat] = useState<SectorHeat[] | null>(null)
  const [chartTab, setChartTab] = useState<'kline' | 'minute'>('kline')
  const [watched, setWatched] = useState(false)
  const [held, setHeld] = useState(false)
  const [minute, setMinute] = useState<MinutePoint[]>([])
  // 点「开始分析」按钮时不因失焦关闭联想下拉
  const suppressBlurRef = useRef(false)

  // 快捷点选：今日推荐 + 监控列表
  const quickPicks = useMemo(() => {
    const picks = getPickRecords()[0]?.picks ?? []
    const watch = getWatchlist().slice(0, 8)
    const map = new Map<string, { code: string; name: string }>()
    for (const p of picks) map.set(p.code, { code: p.code, name: p.name })
    for (const w of watch) if (!map.has(w.code)) map.set(w.code, { code: w.code, name: w.name })
    return [...map.values()]
  }, [])

  // 买入决策分析（依赖所有指标就绪后自动计算）
  useEffect(() => {
    if (!analysis?.signal?.stability || !trendMomentum || !sectorJudgment) {
      setBuyDecision(null)
      return
    }
    const secScore = sectorJudgment.industry?.score ?? sectorJudgment.concept?.score
    setBuyDecision(
      analyzeBuyDecision(
        analysis.signal,
        analysis.signal.stability,
        trendMomentum,
        secScore,
        sentiment?.level,
      ),
    )
    // 更新监控/持仓状态
    setWatched(getWatchlist().some((w) => w.code === analysis.code))
    setHeld(getPositions().some((p) => p.code === analysis.code))
  }, [analysis, trendMomentum, sectorJudgment, sentiment])

  // 拉全市场快照：既算大盘情绪，又做中文名搜索索引

  // 拉全市场快照：既算大盘情绪，又做中文名搜索索引
  useEffect(() => {
    let cancelled = false
    fetchMarketStocks()
      .then((list) => {
        if (cancelled) return
        setStocks(list)
        setSentiment(computeMarketSentiment(list))
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIndexReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleChange = (v: string) => {
    setQuery(v)
    setError(null)
    const pureDigit = /^\d*$/.test(v)
    if (v.trim().length > 0 && !pureDigit && stocks.length > 0) {
      setSuggestions(searchStocks(stocks, v))
      setShowSug(true)
    } else {
      setSuggestions([])
      setShowSug(false)
    }
  }

  /** 6 位代码解析 */
  const codeOf = (q: string): string | null => {
    const t = q.trim()
    return /^\d{6}$/.test(t) ? t : null
  }

  const run = async (target?: { code: string; name?: string }) => {
    if (loading) return

    // ① 显式目标（快捷选择 / 下拉选中）直接跑
    if (target) {
      const c = target.code
      const providedName = target.name || ''
      setLoading(true)
      setError(null)
      setAnalysis(null)
      setKline([])
      setShowSug(false)
      setSectorJudgment(null)
      setMoneyFlow(null)
      setMoneyFlowSum(0)
      setStockSnapshot(null)
      setSelectionMetrics(null)
      setKlinePatterns(null)
      setGapAnalysis(null)
      setTrendMomentum(null)
      setDivergence(null)
      setMoneyFlowTrend(null)
      setSectorHeat(null)
      try {
        const market = marketOfCode(c)
        const [kl, quotes] = await Promise.all([
          fetchKline(market, c, 200),
          fetchRealtimeQuotes([c]),
        ])
        const quote = quotes[0]
        const stockName = quote?.name || providedName || ''
        const currentPrice = quote?.price ?? kl[kl.length - 1]?.close
        const result = analyzeStock(c, stockName, kl, currentPrice, sentiment)
        if (!result) throw new Error('K 线数据不足（少于 30 根），请稍后重试')
        setAnalysis(result)
        setKline(kl)

        // 估值指标：从快照里找
        const snap = stocks.find((s) => s.code === c) || null
        setStockSnapshot(snap)
        setKlinePatterns(analyzeKlinePatterns(kl, snap?.turnoverRate))
        setGapAnalysis(analyzeGaps(kl))
        setTrendMomentum(analyzeTrendMomentum(kl))
        setDivergence(detectDivergence(kl))

        // 资金流 + 板块行情 + 分时数据（并行拉取）
        const [mf, mfHist, marketList, minuteData] = await Promise.allSettled([
          fetchMoneyFlow(market, c),
          fetchMoneyFlowHistory(market, c, 5),
          fetchMarketStocks(),
          fetchMinuteData(c),
        ])
        if (mf.status === 'fulfilled' && mf.value) {
          setMoneyFlow({
            mainNetInflow: mf.value.mainNetInflow,
            superNetInflow: mf.value.superNetInflow,
            bigNetInflow: mf.value.bigNetInflow,
          })
        }
        if (mfHist.status === 'fulfilled' && mfHist.value) {
          setMoneyFlowSum(mfHist.value.reduce((a, b) => a + b, 0))
          setMoneyFlowTrend(analyzeMoneyFlowTrend(mfHist.value))
        }
        if (marketList.status === 'fulfilled') {
          const si = computeStockSectorInfo(marketList.value, c, snap?.industry, snap?.concept)
          setSectorJudgment(judgeSector(si))
          setSelectionMetrics(analyzeStockSelection(kl, marketList.value))
          setSectorHeat(computeSectorHeat(marketList.value))
        }
        if (minuteData.status === 'fulfilled') {
          setMinute(minuteData.value)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
      return
    }

    // ② 输入框内容：代码直接跑，名称先解析
    const q = query.trim()
    const code = codeOf(q)
    if (code) {
      void run({ code })
      return
    }
    if (stocks.length === 0) {
      setError('正在加载股票名称索引，请稍候再试（也可直接输入 6 位代码）')
      return
    }
    const found = searchStocks(stocks, q)
    if (found.length === 0) {
      setError(`未找到「${q}」，试试输入完整中文名或 6 位代码`)
      return
    }
    if (found.length === 1) {
      void run({ code: found[0].code, name: found[0].name })
      return
    }
    // 多个候选 → 弹出下拉让用户选
    setSuggestions(found)
    setShowSug(true)
    setError(`找到 ${found.length} 只名称含「${q}」，请从下拉列表选择`)
  }

  const selectSuggestion = (s: StockInfo) => {
    setQuery(s.name)
    setSuggestions([])
    setShowSug(false)
    void run({ code: s.code, name: s.name })
  }

  const addToWatch = () => {
    if (!analysis) return
    addToWatchlist(
      watchItemFrom(analysis.code, analysis.name || analysis.code, {
        buyLow: analysis.signal?.buyLow,
        buyHigh: analysis.signal?.buyHigh,
        takeProfit: analysis.signal?.takeProfit,
        stopLoss: analysis.signal?.stopLoss,
      }),
    )
    setWatched(true)
    alert(`已加入「👁️ 监控」：${analysis.name || analysis.code}`)
  }

  const buyStock = () => {
    if (!analysis || !analysis.signal) return
    const price = analysis.price ?? analysis.signal.currentPrice
    if (price === undefined) {
      alert('暂无实时价格，无法模拟买入')
      return
    }
    addPosition({
      code: analysis.code,
      name: analysis.name || analysis.code,
      buyPrice: price,
      shares: 100,
      buyDate: new Date().toISOString().slice(0, 10),
      stopLoss: analysis.signal.stopLoss,
      takeProfit: analysis.signal.takeProfit,
    })
    setHeld(true)
    alert(`已模拟买入 ${analysis.name || analysis.code} 100股 @ ¥${price.toFixed(2)}（可到「💰 持仓」查看）`)
  }

  const verdictCls = VERDICT_CLS[analysis?.verdict ?? '']
  const passCount = analysis?.checks.filter((c) => c.pass).length ?? 0

  return (
    <div className="config-panel">
      <h2 className="section-title">🔍 个股买卖点分析</h2>
      <p className="muted" style={{ margin: '0 0 12px' }}>
        输入股票名称或代码，自动分析「现在能不能买、买点在哪、卖点（止盈/止损）在哪」。基于均线 / MACD / RSI / 量能 / 支撑压力位 + 大盘情绪综合判断。仅供参考，不构成投资建议。
      </p>

      <section className="card">
        <div className="ai-input">
          <div className="ai-input-row sa-search-wrap">
            <input
              value={query}
              onChange={(e) => handleChange(e.target.value)}
              onFocus={() => {
                if (query && !/^\d*$/.test(query) && suggestions.length > 0) setShowSug(true)
              }}
              onBlur={() => {
                if (suppressBlurRef.current) {
                  suppressBlurRef.current = false
                  return
                }
                setTimeout(() => setShowSug(false), 150)
              }}
              placeholder="输入股票名称或 6 位代码（如：茅台 / 600519）"
              disabled={loading}
            />
            <button
              className="btn btn-primary"
              onMouseDown={() => {
                suppressBlurRef.current = true
              }}
              onClick={() => void run()}
              disabled={loading || !query.trim()}
            >
              {loading ? '分析中…' : '🔍 开始分析'}
            </button>
            {showSug && suggestions.length > 0 && (
              <ul className="sa-suggest">
                {suggestions.map((s) => (
                  <li
                    key={s.code}
                    className="sa-suggest-item"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectSuggestion(s)
                    }}
                  >
                    <span className="sa-sug-name">{s.name}</span>
                    <span className="code-muted">{s.code}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {!indexReady && (
            <div className="muted" style={{ marginTop: 6 }}>
              正在加载股票名称索引（支持中文搜索）…
            </div>
          )}
          {sentiment && (
            <div className="muted" style={{ marginTop: 6 }}>
              大盘情绪{' '}
              <span className={sentiment.level === 'cold' ? 'down' : sentiment.level === 'hot' ? 'up' : ''}>
                {sentiment.level === 'hot' ? '🔥' : sentiment.level === 'cold' ? '🧊' : '😐'} {sentiment.temperature}°
              </span>{' '}
              · {sentiment.advice}
            </div>
          )}
          {quickPicks.length > 0 && (
            <div className="ai-quickpicks">
              <span className="muted">快捷选择：</span>
              {quickPicks.map((p) => (
                <button
                  key={p.code}
                  className="chip"
                  disabled={loading}
                  onClick={() => {
                    setQuery(p.name)
                    void run({ code: p.code, name: p.name })
                  }}
                >
                  {p.name} {p.code}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {loading && <div className="loading-hint">正在拉取 K 线 + 实时行情并计算买卖点…</div>}

      {analysis && (
        <>
          {/* 结论横幅 */}
          <section className={`card sa-verdict ${verdictCls}`}>
            <div className="sa-verdict-head">
              <span className="sa-verdict-icon">{analysis.verdictIcon}</span>
              <div>
                <div className="sa-verdict-title">
                  {analysis.name || analysis.code}
                  <span className="code-muted">{analysis.code}</span>
                </div>
                <div className="sa-verdict-label">{analysis.verdictLabel}</div>
              </div>
              <div className="sa-score-box">
                <div className="sa-score-val">{analysis.score}</div>
                <div className="sa-score-label">
                  综合评分 · 通过 {passCount}/{analysis.checks.length}
                </div>
              </div>
            </div>
            <div className="sa-price-row">
              <span className="sa-price">
                现价 ¥{analysis.price.toFixed(2)}
                {analysis.changePct !== undefined && (
                  <span className={analysis.changePct >= 0 ? 'up' : 'down'}>
                    {' '}
                    {analysis.changePct >= 0 ? '+' : ''}
                    {analysis.changePct.toFixed(2)}%
                  </span>
                )}
              </span>
              <span className="muted">趋势：{analysis.indicators.trendLabel}</span>
            </div>
            <p className="sa-summary">{analysis.summary}</p>
            <div className="btn-row">
              <button className="btn btn-sm" onClick={addToWatch}>
                👁️ 加入监控
              </button>
            </div>
          </section>

          {/* 买入决策 */}
          {buyDecision && (
            <div className={`buy-decision-card buy-decision-${buyDecision.summary.color}`}>
              <div className="buy-decision-head">
                <span className="buy-decision-verdict">{buyDecision.summary.verdict}</span>
                <span className="buy-decision-count">通过 {buyDecision.summary.passCount}/{buyDecision.summary.total}</span>
              </div>
              <p className="buy-decision-hint">{buyDecision.summary.hint}</p>
              <div className="buy-checklist">
                {buyDecision.checklist.map((item, i) => (
                  <div key={i} className={`buy-check-item ${item.pass ? 'buy-check-pass' : 'buy-check-fail'}`}>
                    <span className="buy-check-icon">{item.pass ? '✓' : '✗'}</span>
                    <span className="buy-check-label">{item.label}</span>
                    <span className="buy-check-tag">{item.weight === 'high' ? '重要' : item.weight === 'medium' ? '中等' : '参考'}</span>
                    <span className="buy-check-detail">{item.detail}</span>
                  </div>
                ))}
              </div>
              <div className="buy-rr-row">
                <div className="buy-rr-box">
                  <span className="buy-rr-label">风险回报比</span>
                  <span className={`buy-rr-val ${buyDecision.riskReward.worthEntry ? 'buy-rr-good' : 'buy-rr-bad'}`}>
                    {buyDecision.riskReward.ratio}
                  </span>
                  <span className="buy-rr-hint">{buyDecision.riskReward.hint}</span>
                </div>
                {buyDecision.position && (
                  <div className="buy-rr-box">
                    <span className="buy-rr-label">仓位建议</span>
                    <span className="buy-rr-pos">{buyDecision.position.suggestion}</span>
                  </div>
                )}
              </div>
              {/* 一键操作：加入监控 / 模拟买入 */}
              <div className="buy-action-row">
                <button
                  className={`btn btn-sm ${watched ? 'btn-disabled' : ''}`}
                  onClick={addToWatch}
                  disabled={watched}
                >
                  {watched ? '👁️ 已监控' : '👁️ 加入监控'}
                </button>
                <button
                  className={`btn btn-sm btn-primary ${held ? 'btn-disabled' : ''}`}
                  onClick={buyStock}
                  disabled={held}
                >
                  {held ? '💼 已持仓' : '💼 模拟买入'}
                </button>
              </div>
            </div>
          )}

          {/* 企稳状态大标识 */}
          {analysis.signal?.stability && (
            <div className={`verdict-card verdict-${analysis.signal.stability.verdict.color}`}>
              <div className="sa-section-hint">综合均线+MACD+是否创新低+量能。"已企稳"才可考虑买入。</div>
              <div className="verdict-main">
                <span className="verdict-label">{analysis.signal.stability.verdict.label}</span>
                <span className="verdict-score">
                  评分 {analysis.signal.stability.verdict.score > 0 ? '+' : ''}
                  {analysis.signal.stability.verdict.score}
                </span>
                <span className="verdict-confidence">
                  置信度 {analysis.signal.stability.verdict.confidence === 'high' ? '高' : analysis.signal.stability.verdict.confidence === 'medium' ? '中' : '低'}
                </span>
              </div>
              <p className="verdict-summary">{analysis.signal.stability.verdict.summary}</p>
              <div className="verdict-signals">
                {analysis.signal.stability.verdict.signals.map((s, i) => (
                  <span key={i} className="verdict-signal good">
                    ✓ {s}
                  </span>
                ))}
                {analysis.signal.stability.verdict.risks.map((r, i) => (
                  <span key={i} className="verdict-signal risk">
                    ✗ {r}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 板块判断条件 */}
          {sectorJudgment && (sectorJudgment.industry || sectorJudgment.concept) && (
            <div className="card sector-judge-card">
              <h3>板块判断条件</h3>
              <p className="sa-section-hint">个股所在板块今天涨不涨、是不是领涨、跑不跑赢板块。"板块助力"=顺风，"板块拖累"=逆风。</p>
              <div className="sector-judge-grid">
                {sectorJudgment.industry && (
                  <div className={`sector-judge-item c-${sectorJudgment.industry.color}`}>
                    <span className="sector-judge-label">{sectorJudgment.industry.name}</span>
                    <span className="sector-judge-status">{sectorJudgment.industry.label}</span>
                    <span className="sector-judge-detail">
                      {sectorJudgment.industry.signals.join(' / ') || sectorJudgment.industry.risks.join(' / ')}
                    </span>
                  </div>
                )}
                {sectorJudgment.concept && (
                  <div className={`sector-judge-item c-${sectorJudgment.concept.color}`}>
                    <span className="sector-judge-label">{sectorJudgment.concept.name}</span>
                    <span className="sector-judge-status">{sectorJudgment.concept.label}</span>
                    <span className="sector-judge-detail">
                      {sectorJudgment.concept.signals.join(' / ') || sectorJudgment.concept.risks.join(' / ')}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 估值/市值 + 资金细节 */}
          <div className="sa-metric-row">
            <div className="card sa-metrics-card">
              <h3>估值与市值</h3>
              <p className="sa-section-hint">PE=回本年限（越低越便宜）；PB=股价/净资产（小于1=破净）；市值=公司规模。和行业比才有意义。</p>
              <div className="sa-metric-grid">
                <div className="sa-metric">
                  <span className="sa-metric-label">市盈率</span>
                  <span className="sa-metric-val">{stockSnapshot?.pe ? stockSnapshot.pe.toFixed(1) + 'x' : '--'}</span>
                </div>
                <div className="sa-metric">
                  <span className="sa-metric-label">市净率</span>
                  <span className="sa-metric-val">{stockSnapshot?.pb ? stockSnapshot.pb.toFixed(2) + 'x' : '--'}</span>
                </div>
                <div className="sa-metric">
                  <span className="sa-metric-label">总市值</span>
                  <span className="sa-metric-val">{fmtMv(stockSnapshot?.totalMv)}</span>
                </div>
                <div className="sa-metric">
                  <span className="sa-metric-label">流通市值</span>
                  <span className="sa-metric-val">{fmtMv(stockSnapshot?.floatMv)}</span>
                </div>
                <div className="sa-metric">
                  <span className="sa-metric-label">换手率</span>
                  <span className="sa-metric-val">{stockSnapshot?.turnoverRate ? stockSnapshot.turnoverRate.toFixed(2) + '%' : '--'}</span>
                </div>
              </div>
            </div>
            <div className="card sa-money-card">
              <h3>资金流向</h3>
              <p className="sa-section-hint">正数=资金在买入，负数=资金在卖出。超大单=机构级别，大单=大户。持续流入=看好。</p>
              <div className="sa-metric-grid">
                <div className="sa-metric">
                  <span className="sa-metric-label">主力净流入</span>
                  <span className="sa-metric-val">{moneyFlow ? fmtFlow(moneyFlow.mainNetInflow) : '--'}</span>
                </div>
                <div className="sa-metric">
                  <span className="sa-metric-label">超大单</span>
                  <span className="sa-metric-val">{moneyFlow ? fmtFlow(moneyFlow.superNetInflow) : '--'}</span>
                </div>
                <div className="sa-metric">
                  <span className="sa-metric-label">大单</span>
                  <span className="sa-metric-val">{moneyFlow ? fmtFlow(moneyFlow.bigNetInflow) : '--'}</span>
                </div>
                <div className="sa-metric">
                  <span className="sa-metric-label">5日合计</span>
                  <span className="sa-metric-val">{fmtFlow(moneyFlowSum)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* 箱体状态 + 看盘指南 */}
          <div className="sa-status-row">
            {analysis.signal?.box && (
              <div className="card sa-box-card">
                <h3>箱体/趋势状态</h3>
                <div className="sa-box-status">
                  <span className={`box-badge ${analysis.signal.box.active ? (analysis.signal.box.breakoutDay ? 'box-hot' : 'box-active') : 'box-idle'}`}>
                    {analysis.signal.box.active
                      ? analysis.signal.box.breakoutDay
                        ? '今日放量突破'
                        : '已突破箱体'
                      : '横盘中 ' + analysis.signal.box.boxDays + ' 日'}
                  </span>
                  <span className="sa-box-detail">
                    箱体 {analysis.signal.box.boxLow} ~ {analysis.signal.box.boxHigh}
                    {analysis.signal.box.active && <> · 打开空间目标 {analysis.signal.box.measuredTarget}</>}
                  </span>
                </div>
              </div>
            )}
            <div className="card sa-guide-card">
              <h3>看盘指南</h3>
              <div className="sa-guide-list">
                <div className="sa-guide-item"><span className="sa-guide-rank r1">1</span>是否创新低（最重要）</div>
                <div className="sa-guide-item"><span className="sa-guide-rank r2">2</span>均线位置 MA20/MA60</div>
                <div className="sa-guide-item"><span className="sa-guide-rank r3">3</span>MACD 柱方向</div>
                <div className="sa-guide-item"><span className="sa-guide-rank r4">4</span>量能配合</div>
                <div className="sa-guide-item"><span className="sa-guide-rank r5">5</span>板块是否助力</div>
              </div>
            </div>
          </div>

          {/* 选股维度数据 */}
          {selectionMetrics && (
            <div className="card sa-selection-card">
              <h3>选股维度数据（供自行判断）</h3>
              <p className="sa-section-hint">跑赢大盘+创新高+多头排列+连阳=强势；跑输大盘+创新低+空头排列+连阴=弱势。</p>
              <div className="sa-selection-grid">
                {/* 1. 相对大盘强弱 */}
                <div className="sa-sel-group">
                  <div className="sa-sel-group-title">相对大盘强弱</div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">个股5日</span>
                    <span className={`sa-sel-val ${selectionMetrics.relativeStrength.stock5d >= 0 ? 'up' : 'down'}`}>
                      {selectionMetrics.relativeStrength.stock5d >= 0 ? '+' : ''}{selectionMetrics.relativeStrength.stock5d}%
                    </span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">个股20日</span>
                    <span className={`sa-sel-val ${selectionMetrics.relativeStrength.stock20d >= 0 ? 'up' : 'down'}`}>
                      {selectionMetrics.relativeStrength.stock20d >= 0 ? '+' : ''}{selectionMetrics.relativeStrength.stock20d}%
                    </span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">个股60日</span>
                    <span className={`sa-sel-val ${selectionMetrics.relativeStrength.stock60d >= 0 ? 'up' : 'down'}`}>
                      {selectionMetrics.relativeStrength.stock60d >= 0 ? '+' : ''}{selectionMetrics.relativeStrength.stock60d}%
                    </span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">大盘1日</span>
                    <span className={`sa-sel-val ${selectionMetrics.relativeStrength.market1d >= 0 ? 'up' : 'down'}`}>
                      {selectionMetrics.relativeStrength.market1d >= 0 ? '+' : ''}{selectionMetrics.relativeStrength.market1d}%
                    </span>
                  </div>
                  <div className="sa-sel-row highlight">
                    <span className="sa-sel-label">相对大盘</span>
                    <span className={`sa-sel-val ${selectionMetrics.relativeStrength.vsMarket >= 0 ? 'up' : 'down'}`}>
                      {selectionMetrics.relativeStrength.vsMarket >= 0 ? '+' : ''}{selectionMetrics.relativeStrength.vsMarket}%
                    </span>
                  </div>
                </div>

                {/* 2. N日高低点 */}
                <div className="sa-sel-group">
                  <div className="sa-sel-group-title">高低点位置</div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">20日新高</span>
                    <span className={`sa-sel-val ${selectionMetrics.highLows.at20dHigh ? 'up' : ''}`}>
                      {selectionMetrics.highLows.at20dHigh ? '是' : '否'}
                    </span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">60日新高</span>
                    <span className={`sa-sel-val ${selectionMetrics.highLows.at60dHigh ? 'up' : ''}`}>
                      {selectionMetrics.highLows.at60dHigh ? '是' : '否'}
                    </span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">20日新低</span>
                    <span className={`sa-sel-val ${selectionMetrics.highLows.at20dLow ? 'down' : ''}`}>
                      {selectionMetrics.highLows.at20dLow ? '是' : '否'}
                    </span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">距20日高点</span>
                    <span className="sa-sel-val">{selectionMetrics.highLows.distTo20dHighPct}%</span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">距20日低点</span>
                    <span className="sa-sel-val">+{selectionMetrics.highLows.distTo20dLowPct}%</span>
                  </div>
                </div>

                {/* 3. 量价关系 */}
                <div className="sa-sel-group">
                  <div className="sa-sel-group-title">量价关系</div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">5日价格变化</span>
                    <span className={`sa-sel-val ${selectionMetrics.volPrice.priceChange5d >= 0 ? 'up' : 'down'}`}>
                      {selectionMetrics.volPrice.priceChange5d >= 0 ? '+' : ''}{selectionMetrics.volPrice.priceChange5d}%
                    </span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">5日量能变化</span>
                    <span className="sa-sel-val">{selectionMetrics.volPrice.volChange5d}x</span>
                  </div>
                  <div className="sa-sel-row highlight">
                    <span className="sa-sel-label">量价形态</span>
                    <span className={`sa-sel-val ${selectionMetrics.volPrice.relationship === '价涨量增' ? 'up' : selectionMetrics.volPrice.relationship === '价跌量增' ? 'down' : ''}`}>
                      {selectionMetrics.volPrice.relationship}
                    </span>
                  </div>
                </div>

                {/* 4. 均线排列 */}
                <div className="sa-sel-group">
                  <div className="sa-sel-group-title">均线排列</div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">MA5/20/60</span>
                    <span className="sa-sel-val small">
                      {selectionMetrics.maAlignment.ma5.toFixed(1)} / {selectionMetrics.maAlignment.ma20.toFixed(1)} / {selectionMetrics.maAlignment.ma60.toFixed(1)}
                    </span>
                  </div>
                  <div className="sa-sel-row highlight">
                    <span className="sa-sel-label">多头排列</span>
                    <span className={`sa-sel-val ${selectionMetrics.maAlignment.bullAlign ? 'up' : ''}`}>
                      {selectionMetrics.maAlignment.bullAlign ? '是' : '否'}
                    </span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">空头排列</span>
                    <span className={`sa-sel-val ${selectionMetrics.maAlignment.bearAlign ? 'down' : ''}`}>
                      {selectionMetrics.maAlignment.bearAlign ? '是' : '否'}
                    </span>
                  </div>
                </div>

                {/* 5. 连阳/连阴 */}
                <div className="sa-sel-group">
                  <div className="sa-sel-group-title">连阳/连阴</div>
                  <div className="sa-sel-row highlight">
                    <span className="sa-sel-label">方向</span>
                    <span className={`sa-sel-val ${selectionMetrics.consecutive.type === 'up' ? 'up' : selectionMetrics.consecutive.type === 'down' ? 'down' : ''}`}>
                      {selectionMetrics.consecutive.type === 'up' ? '连阳' : selectionMetrics.consecutive.type === 'down' ? '连阴' : '无'}
                    </span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">天数</span>
                    <span className="sa-sel-val">{selectionMetrics.consecutive.count} 天</span>
                  </div>
                </div>

                {/* 6. 距高点回撤 + 波动率 */}
                <div className="sa-sel-group">
                  <div className="sa-sel-group-title">回撤与波动</div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">距20日高点</span>
                    <span className="sa-sel-val">{selectionMetrics.drawdown.dd20d}%</span>
                  </div>
                  <div className="sa-sel-row">
                    <span className="sa-sel-label">距60日高点</span>
                    <span className="sa-sel-val">{selectionMetrics.drawdown.dd60d}%</span>
                  </div>
                  <div className="sa-sel-row highlight">
                    <span className="sa-sel-label">年化波动率</span>
                    <span className="sa-sel-val">{selectionMetrics.volatility.annualized}%</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* K线形态 + 支撑压力 + 量能趋势 + 换手解读 */}
          {klinePatterns && (
            <div className="card sa-pattern-card">
              <h3>K线形态 / 支撑压力 / 量能趋势</h3>
              <p className="sa-section-hint">K线形态看多空转折；支撑=跌到这里可能止跌；压力=涨到这里可能受阻；量价配合=上涨真实性。</p>
              <div className="sa-pattern-grid">
                {/* K线形态 */}
                <div className="sa-pattern-group">
                  <div className="sa-pattern-group-title">K线形态</div>
                  {klinePatterns.patterns.length > 0 ? (
                    klinePatterns.patterns.map((p, i) => (
                      <div key={i} className={`sa-pattern-item p-${p.signal}`}>
                        <span className="sa-pattern-name">{p.name}</span>
                        <span className={`sa-pattern-signal ${p.signal}`}>
                          {p.signal === 'bullish' ? '看涨' : p.signal === 'bearish' ? '看跌' : '中性'}
                        </span>
                        <span className="sa-pattern-desc">{p.desc}</span>
                      </div>
                    ))
                  ) : (
                    <div className="sa-pattern-empty">无明显形态</div>
                  )}
                </div>
                {/* 支撑压力位 */}
                <div className="sa-pattern-group">
                  <div className="sa-pattern-group-title">支撑压力位</div>
                  <div className="sa-pattern-row">
                    <span className="sa-pattern-label">最近支撑</span>
                    <span className="sa-pattern-val support">{klinePatterns.supportResistance.nearestSupport}</span>
                  </div>
                  <div className="sa-pattern-row">
                    <span className="sa-pattern-label">最近压力</span>
                    <span className="sa-pattern-val resistance">{klinePatterns.supportResistance.nearestResistance}</span>
                  </div>
                  {klinePatterns.supportResistance.supports.length > 1 && (
                    <div className="sa-pattern-row">
                      <span className="sa-pattern-label">其他支撑</span>
                      <span className="sa-pattern-val">{klinePatterns.supportResistance.supports.slice(1).join(' / ')}</span>
                    </div>
                  )}
                  {klinePatterns.supportResistance.resistances.length > 1 && (
                    <div className="sa-pattern-row">
                      <span className="sa-pattern-label">其他压力</span>
                      <span className="sa-pattern-val">{klinePatterns.supportResistance.resistances.slice(1).join(' / ')}</span>
                    </div>
                  )}
                </div>
                {/* 量能趋势 + 换手 */}
                <div className="sa-pattern-group">
                  <div className="sa-pattern-group-title">量能趋势</div>
                  <div className="sa-pattern-row">
                    <span className="sa-pattern-label">量能方向</span>
                    <span className={`sa-pattern-val ${klinePatterns.volumeTrend.trend === '放量' ? 'up' : klinePatterns.volumeTrend.trend === '缩量' ? 'down' : ''}`}>
                      {klinePatterns.volumeTrend.trend}
                    </span>
                  </div>
                  <div className="sa-pattern-row">
                    <span className="sa-pattern-label">5日/20日量比</span>
                    <span className="sa-pattern-val">{klinePatterns.volumeTrend.ratio}x</span>
                  </div>
                  <div className="sa-pattern-row">
                    <span className="sa-pattern-label">换手率</span>
                    <span className="sa-pattern-val">{klinePatterns.turnover.rate.toFixed(2)}% ({klinePatterns.turnover.level})</span>
                  </div>
                  <div className="sa-pattern-row">
                    <span className="sa-pattern-label">解读</span>
                    <span className="sa-pattern-val small">{klinePatterns.turnover.signal}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 跳空缺口分析 */}
          {gapAnalysis && (
            <div className="card sa-gap-card">
              <h3>跳空缺口分析</h3>
              <div className="sa-gap-guide">
                <strong>怎么看缺口：</strong>缺口 = 当日开盘与昨日收盘之间的空白。<strong>向上缺口未回补 = 支撑</strong>（多头强势）；<strong>向下缺口未回补 = 压力</strong>（空头强势）。缺口越大、越未回补，作用力越强。
              </div>
              <div className="sa-gap-grid">
                <div className="sa-gap-group">
                  <div className="sa-gap-group-title">未回补向上缺口（支撑）</div>
                  {gapAnalysis.unfilledUp.length > 0 ? (
                    gapAnalysis.unfilledUp.map((g, i) => (
                      <div key={i} className="sa-gap-row">
                        <span className="sa-gap-date">{g.date}</span>
                        <span className="sa-gap-range">{g.gapLow.toFixed(2)} ~ {g.gapHigh.toFixed(2)}</span>
                        <span className="sa-gap-size up">+{g.size}%</span>
                      </div>
                    ))
                  ) : (
                    <div className="sa-gap-empty">无未回补向上缺口</div>
                  )}
                </div>
                <div className="sa-gap-group">
                  <div className="sa-gap-group-title">未回补向下缺口（压力）</div>
                  {gapAnalysis.unfilledDown.length > 0 ? (
                    gapAnalysis.unfilledDown.map((g, i) => (
                      <div key={i} className="sa-gap-row">
                        <span className="sa-gap-date">{g.date}</span>
                        <span className="sa-gap-range">{g.gapLow.toFixed(2)} ~ {g.gapHigh.toFixed(2)}</span>
                        <span className="sa-gap-size down">-{g.size}%</span>
                      </div>
                    ))
                  ) : (
                    <div className="sa-gap-empty">无未回补向下缺口</div>
                  )}
                </div>
              </div>
              <div className="sa-gap-nearest">
                {gapAnalysis.nearestGapSupport && (
                  <span className="sa-gap-nearest-item">最近缺口支撑: <strong>{gapAnalysis.nearestGapSupport}</strong></span>
                )}
                {gapAnalysis.nearestGapResistance && (
                  <span className="sa-gap-nearest-item">最近缺口压力: <strong>{gapAnalysis.nearestGapResistance}</strong></span>
                )}
              </div>
            </div>
          )}

          {/* 趋势动能评分 */}
          {trendMomentum && (
            <div className="card sa-momentum-card">
              <h3>趋势动能评分</h3>
              <div className="sa-momentum-guide">
                <strong>怎么看动能：</strong>综合均线排列 + MACD柱方向 + 量能变化，判断趋势在<strong>加速还是减速</strong>。高分=趋势加速延续；低分=趋势减速可能反转。
              </div>
              <div className={`sa-momentum-main ${trendMomentum.score >= 2 ? 'm-up' : trendMomentum.score <= -2 ? 'm-down' : 'm-neutral'}`}>
                <span className="sa-momentum-label">{trendMomentum.label}</span>
                <span className="sa-momentum-score">{trendMomentum.score > 0 ? '+' : ''}{trendMomentum.score}</span>
              </div>
              <div className="sa-momentum-details">
                {trendMomentum.details.map((d, i) => (
                  <span key={i} className={`sa-momentum-tag ${d.includes('+') ? 'tag-up' : d.includes('-') ? 'tag-down' : ''}`}>
                    {d}
                  </span>
                ))}
              </div>
              <div className="sa-momentum-breakdown">
                <div className="sa-momentum-item">
                  <span className="sa-momentum-item-label">均线</span>
                  <span className={`sa-momentum-item-val ${trendMomentum.maScore > 0 ? 'up' : trendMomentum.maScore < 0 ? 'down' : ''}`}>
                    {trendMomentum.maScore > 0 ? '+' : ''}{trendMomentum.maScore}
                  </span>
                </div>
                <div className="sa-momentum-item">
                  <span className="sa-momentum-item-label">MACD</span>
                  <span className={`sa-momentum-item-val ${trendMomentum.macdScore > 0 ? 'up' : trendMomentum.macdScore < 0 ? 'down' : ''}`}>
                    {trendMomentum.macdScore > 0 ? '+' : ''}{trendMomentum.macdScore}
                  </span>
                </div>
                <div className="sa-momentum-item">
                  <span className="sa-momentum-item-label">量能</span>
                  <span className={`sa-momentum-item-val ${trendMomentum.volScore > 0 ? 'up' : trendMomentum.volScore < 0 ? 'down' : ''}`}>
                    {trendMomentum.volScore > 0 ? '+' : ''}{trendMomentum.volScore}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* 量价背离 + 资金趋势 */}
          {(divergence || moneyFlowTrend) && (
            <div className="sa-divergence-row">
              {divergence && divergence.type !== 'none' && (
                <div className={`card sa-divergence-card div-${divergence.type}`}>
                  <h3>量价背离预警</h3>
                  <div className="sa-divergence-guide">
                    <strong>什么是背离？</strong>价格往一个方向走，但动能指标往反方向走 = 趋势可能反转。<strong>顶背离=要跌，底背离=可能涨。</strong>
                  </div>
                  <div className={`sa-divergence-badge ${divergence.type}`}>
                    {divergence.type === 'bearish' ? '顶背离（看跌）' : '底背离（看涨）'}
                    <span className="sa-divergence-rel">可靠性: {divergence.reliability === 'high' ? '高' : divergence.reliability === 'medium' ? '中' : '低'}</span>
                  </div>
                  <div className="sa-divergence-detail">
                    <div>{divergence.pricePattern}</div>
                    <div>{divergence.indicatorPattern}</div>
                  </div>
                  <div className="sa-divergence-signal">{divergence.signal}</div>
                </div>
              )}
              {moneyFlowTrend && (
                <div className="card sa-moneyflow-card">
                  <h3>资金流入趋势</h3>
                  <div className="sa-moneyflow-guide">
                    <strong>怎么看：</strong>近2日主力净流入 vs 前3日主力净流入。变多=加速进场，变少=加速离场。
                  </div>
                  <div className={`sa-moneyflow-trend ${moneyFlowTrend.trend.includes('流入') ? 'mf-in' : moneyFlowTrend.trend.includes('流出') ? 'mf-out' : ''}`}>
                    {moneyFlowTrend.trend}
                  </div>
                  <div className="sa-moneyflow-detail">
                    <span>近2日: {(moneyFlowTrend.recent2d / 1e8).toFixed(2)}亿</span>
                    <span>前3日: {(moneyFlowTrend.prev3d / 1e8).toFixed(2)}亿</span>
                    <span className={moneyFlowTrend.change >= 0 ? 'up' : 'down'}>
                      变化: {moneyFlowTrend.change >= 0 ? '+' : ''}{moneyFlowTrend.change}%
                    </span>
                  </div>
                  <div className="sa-moneyflow-signal">{moneyFlowTrend.signal}</div>
                </div>
              )}
            </div>
          )}

          {/* 板块轮动热度 */}
          {sectorHeat && sectorHeat.length > 0 && (
            <div className="card sector-heat-card">
              <h3>🔥 板块轮动热度</h3>
              <p className="sa-section-hint">资金往哪个板块集中。热度越高=资金越关注，选热门板块里的个股更容易上涨。</p>
              <div className="sector-heat-list">
                {sectorHeat.map((h, i) => (
                  <div key={i} className={`sector-heat-item ${h.heatScore >= 60 ? 'hot' : h.heatScore >= 40 ? 'mid' : 'cold'}`}>
                    <span className="sector-heat-rank">#{h.rank}</span>
                    <span className="sector-heat-name">{h.name}</span>
                    <span className="sector-heat-score">{h.heatScore}</span>
                    <span className="sector-heat-change">{h.avgChangePct >= 0 ? '+' : ''}{h.avgChangePct.toFixed(2)}%</span>
                    <span className="sector-heat-leader">{h.leader}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 买卖点 */}
          {analysis.signal && (
            <section className="card">
              <h3>买点 / 卖点</h3>
              <div className="price-targets">
                <div className="target target-buy">
                  <span className="target-label">买入区间</span>
                  <span className="target-val">
                    {analysis.signal.buyLow.toFixed(2)} ~ {analysis.signal.buyHigh.toFixed(2)}
                  </span>
                </div>
                <div className="target target-profit">
                  <span className="target-label">止盈目标（卖点）</span>
                  <span className="target-val">{analysis.signal.takeProfit.toFixed(2)}</span>
                </div>
                <div className="target target-stop">
                  <span className="target-label">止损价（卖点）</span>
                  <span className="target-val">{analysis.signal.stopLoss.toFixed(2)}</span>
                </div>
                <div className="target target-trailing">
                  <span className="target-label">移动止盈</span>
                  <span className="target-val">{analysis.signal.trailingStop.toFixed(2)}</span>
                </div>
              </div>
              <div className="sa-zone">
                {(() => {
                  const s = analysis.signal!
                  const span = Math.max(s.takeProfit - s.buyLow, 0.01)
                  const pos = Math.min(
                    100,
                    Math.max(0, ((analysis.price - s.buyLow) / span) * 100),
                  )
                  return (
                    <>
                      <div
                        className="sa-zone-marker sa-zone-support"
                        style={{ left: '0%' }}
                        title={`支撑 ${s.buyLow.toFixed(2)}`}
                      />
                      <div
                        className="sa-zone-marker sa-zone-price"
                        style={{ left: `${pos}%` }}
                        title={`现价 ${analysis.price.toFixed(2)}`}
                      />
                      <div
                        className="sa-zone-marker sa-zone-target"
                        style={{ left: '100%' }}
                        title={`止盈 ${s.takeProfit.toFixed(2)}`}
                      />
                    </>
                  )
                })()}
              </div>
              <ul className="pick-reasons">
                {analysis.signal.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </section>
          )}

          {/* 逐项检查 */}
          <section className="card">
            <h3>技术面逐项检查</h3>
            <p className="sa-section-hint">每项检查技术面是否达标。✅=达标（好），❌=未达标（差）。6项中通过越多越适合买入。</p>
            <div className="sa-checks">
              {analysis.checks.map((c) => (
                <div key={c.key} className={`sa-check ${c.pass ? 'sa-check-pass' : 'sa-check-fail'}`}>
                  <span className="sa-check-mark">{c.pass ? '✅' : '❌'}</span>
                  <div className="sa-check-body">
                    <div className="sa-check-label">
                      {c.label}
                      <span className={`score-pill ${c.pass ? 'good' : 'bad'}`}>
                        {c.pass ? '达标' : '未达标'}
                      </span>
                    </div>
                    <div className="sa-check-detail">{c.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* K 线图 + 雷达图 + 因子明细 */}
          {kline.length > 0 && (
            <>
              <section className="card">
                <div className="chart-tabs">
                  <button
                    className={`chart-tab ${chartTab === 'kline' ? 'active' : ''}`}
                    onClick={() => setChartTab('kline')}
                  >
                    日K
                  </button>
                  <button
                    className={`chart-tab ${chartTab === 'minute' ? 'active' : ''}`}
                    onClick={() => setChartTab('minute')}
                  >
                    分时
                  </button>
                </div>
                {chartTab === 'kline' ? (
                  <KLineChart kline={kline} height={360} />
                ) : (
                  <MinuteChart points={minute} prevClose={kline[kline.length - 1]?.close} />
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}
