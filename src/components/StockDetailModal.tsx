import { useEffect, useMemo, useState } from 'react'
import type { Financials, Kline, MoneyFlow, StockScore } from '../types'
import { klineCache } from '../data/cache'
import {
  fetchFinancials,
  fetchKline,
  fetchMinuteData,
  fetchMoneyFlow,
  fetchMoneyFlowHistory,
  type MinutePoint,
} from '../data/api'
import { fetchMarketStocks } from '../data/pipeline'
import { computeTradingSignal, analyzeStockSelection, analyzeKlinePatterns, analyzeGaps, analyzeTrendMomentum, analyzeBuyDecision, type TradingSignal, type SelectionMetrics, type KlinePatternAnalysis, type GapAnalysis, type TrendMomentum, type BuyDecision } from '../engine/tradingSignals'
import { computeStockSectorInfo, judgeSector, type StockSectorInfo } from '../engine/sectorInfo'
import { computeMarketSentiment } from '../engine/marketSentiment'
import { scoreStocks } from '../engine/factors'
import { DEFAULT_FACTORS } from '../config/factors'
import type { MarketSentiment } from '../engine/marketSentiment'
import { addToWatchlist, getWatchlist, watchItemFrom } from '../data/watchlist'
import { addPosition, getPositions } from '../data/positions'
import KLineChart from './charts/KLineChart'
import MinuteChart from './charts/MinuteChart'
import RadarChart from './charts/RadarChart'

interface Props {
  stock: StockScore
  onClose: () => void
}

const GROUP_LABELS: Record<string, string> = {
  technical: '技术面',
  fundamental: '基本面',
  money: '资金面',
}

type ChartTab = 'kline' | 'minute'

const fmt = (v?: number, digits = 2) =>
  v === undefined || v === null || Number.isNaN(v) ? '--' : v.toFixed(digits)

const fmtPct = (v?: number) =>
  v === undefined || v === null || Number.isNaN(v) ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`

function fmtFlow(v?: number) {
  if (v === undefined || v === null || Number.isNaN(v)) return '--'
  const yi = v / 10000
  if (Math.abs(yi) >= 1) return `${yi >= 0 ? '+' : ''}${yi.toFixed(2)}亿`
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)}万`
}

/** 市值格式化：>=1亿 显示"xx亿"，否则"xx万" */
function fmtMv(v?: number) {
  if (v === undefined || v === null || Number.isNaN(v)) return '--'
  const yi = v / 1e8
  if (yi >= 1) return `${yi.toFixed(1)}亿`
  return `${(v / 1e4).toFixed(0)}万`
}

/** 板块相对表现：强于/弱于板块均值 */
function SectorBadge({ brief }: { brief: { name: string; avgChangePct: number; vsAvg: number; rank: number } }) {
  const strong = brief.vsAvg >= 0
  return (
    <div className={`sector-brief ${strong ? 'sector-strong' : 'sector-weak'}`}>
      <span className="sector-brief-name">{brief.name}</span>
      <span className="sector-brief-avg">板块均 {brief.avgChangePct >= 0 ? '+' : ''}{brief.avgChangePct.toFixed(2)}%</span>
      <span className="sector-brief-rank">
        板块第 {brief.rank} · {strong ? '强于' : '弱于'}板块 {Math.abs(brief.vsAvg).toFixed(1)}pt
      </span>
    </div>
  )
}

export default function StockDetailModal({ stock, onClose }: Props) {
  const [kline, setKline] = useState<Kline[]>([])
  const [loading, setLoading] = useState(true)
  const [chartTab, setChartTab] = useState<ChartTab>('kline')
  const [minute, setMinute] = useState<MinutePoint[]>([])
  const [signal, setSignal] = useState<TradingSignal | null>(null)
  const [financials, setFinancials] = useState<Financials | null>(null)
  const [moneyFlow, setMoneyFlow] = useState<MoneyFlow | null>(null)
  const [moneyFlowHistory, setMoneyFlowHistory] = useState<number[]>([])
  const [sectorInfo, setSectorInfo] = useState<StockSectorInfo | null>(null)
  const [selectionMetrics, setSelectionMetrics] = useState<SelectionMetrics | null>(null)
  const [klinePatterns, setKlinePatterns] = useState<KlinePatternAnalysis | null>(null)
  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysis | null>(null)
  const [trendMomentum, setTrendMomentum] = useState<TrendMomentum | null>(null)
  const [buyDecision, setBuyDecision] = useState<BuyDecision | null>(null)
  const [sentiment, setSentiment] = useState<MarketSentiment | null>(null)
  const sectorJudgment = useMemo(
    () => (sectorInfo ? judgeSector(sectorInfo) : null),
    [sectorInfo],
  )

  // 买入决策分析
  useEffect(() => {
    if (!signal?.stability || !trendMomentum || !sectorJudgment) {
      setBuyDecision(null)
      return
    }
    const secScore = sectorJudgment.industry?.score ?? sectorJudgment.concept?.score
    setBuyDecision(analyzeBuyDecision(signal, signal.stability, trendMomentum, secScore, sentiment?.level))
  }, [signal, trendMomentum, sectorJudgment, sentiment])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      let data = await klineCache.get(stock.code)
      if (!data) {
        try {
          data = await fetchKline(stock.market, stock.code, 200)
        } catch {
          data = []
        }
        if (data.length > 0) await klineCache.set(stock.code, data)
      }

      if (cancelled) return
      setKline(data)
      setLoading(false)
      const currentPrice = stock.price ?? data[data.length - 1]?.close
      setSignal(data.length > 0 ? computeTradingSignal(data, currentPrice, false) : null)
      setKlinePatterns(analyzeKlinePatterns(data, stock.turnoverRate))
      setGapAnalysis(analyzeGaps(data))
      setTrendMomentum(analyzeTrendMomentum(data))

      // 因子评分（如果外部未传入则自行计算）
      if (!stock.factorScores || stock.factorScores.length === 0) {
        const input = { info: { code: stock.code, name: stock.name, market: stock.market }, kline: data }
        const scored = scoreStocks([input], DEFAULT_FACTORS.filter((f) => f.enabled))
        if (scored.length > 0) stock.factorScores = scored[0].factorScores
      }

      // 板块 + 选股维度（等 K 线就绪后，用同一份全市场快照）
      try {
        const market = await fetchMarketStocks()
        if (cancelled) return
        setSentiment(computeMarketSentiment(market))
        setSectorInfo(
          computeStockSectorInfo(market, stock.code, stock.industry, stock.concept),
        )
        setSelectionMetrics(analyzeStockSelection(data, market))
      } catch {
        // 市场数据失败不影响主流程
      }
    })()

    fetchMinuteData(stock.code)
      .then((pts) => {
        if (!cancelled) setMinute(pts)
      })
      .catch(() => {})

    Promise.allSettled([
      fetchFinancials(stock.code),
      fetchMoneyFlow(stock.market, stock.code),
      fetchMoneyFlowHistory(stock.market, stock.code, 5),
    ]).then(([fin, flow, hist]) => {
      if (cancelled) return
      setFinancials(fin.status === 'fulfilled' ? fin.value : null)
      setMoneyFlow(flow.status === 'fulfilled' ? flow.value : null)
      setMoneyFlowHistory(hist.status === 'fulfilled' ? hist.value : [])
    })

    return () => {
      cancelled = true
    }
  }, [stock.code, stock.market, stock.price, stock.industry, stock.concept])

  const groups = useMemo(
    () => [...new Set(stock.factorScores.map((f) => f.group))],
    [stock.factorScores],
  )

  const currentPrice = stock.price ?? kline[kline.length - 1]?.close
  const moneyFlowSum = moneyFlowHistory.reduce((sum, v) => sum + v, 0)
  const moneyFlowTrend =
    moneyFlowHistory.length > 1
      ? moneyFlowHistory[moneyFlowHistory.length - 1] - moneyFlowHistory[0]
      : 0

  // 监控/持仓状态
  const [watched, setWatched] = useState(() => getWatchlist().some((w) => w.code === stock.code))
  const [held, setHeld] = useState(() => getPositions().some((p) => p.code === stock.code))

  const toggleWatchFromDetail = () => {
    if (watched) {
      // 已监控则跳过（详情页不提供移除，保持简单）
      alert('已在监控列表中')
      return
    }
    addToWatchlist(
      watchItemFrom(stock.code, stock.name, {
        buyLow: signal?.buyLow,
        buyHigh: signal?.buyHigh,
        takeProfit: signal?.takeProfit,
        stopLoss: signal?.stopLoss,
        totalScore: stock.totalScore,
      }),
    )
    setWatched(true)
    alert(`已加入「👁️ 监控」：${stock.name}`)
  }

  const buyFromDetail = () => {
    if (currentPrice === undefined) {
      alert('暂无实时价格，无法模拟买入')
      return
    }
    if (held) {
      alert('已在模拟持仓中')
      return
    }
    addPosition({
      code: stock.code,
      name: stock.name,
      buyPrice: currentPrice,
      shares: 100,
      buyDate: new Date().toISOString().slice(0, 10),
      stopLoss: signal?.stopLoss,
      takeProfit: signal?.takeProfit,
    })
    setHeld(true)
    alert(`已模拟买入 ${stock.name} 100股 @ ¥${currentPrice.toFixed(2)}（可到「💰 持仓」查看）`)
  }

  const riskLabel = (() => {
    if (!signal || currentPrice === undefined) return '待计算'
    if (currentPrice <= signal.stopLoss) return '止损风险'
    if (currentPrice >= signal.takeProfit) return '接近止盈'
    const supportGap = ((currentPrice - signal.buyLow) / signal.buyLow) * 100
    if (supportGap <= 3) return '靠近支撑'
    return '观察等待'
  })()

  const zoneSpan = signal ? Math.max(signal.takeProfit - signal.buyLow, 0.01) : 1
  const pricePos =
    signal && currentPrice !== undefined
      ? Math.min(100, Math.max(0, ((currentPrice - signal.buyLow) / zoneSpan) * 100))
      : 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {stock.name} <span className="code-muted">{stock.code}</span>
            {currentPrice !== undefined && (
              <span className="modal-price">
                {fmt(currentPrice)}
                {stock.changePct !== undefined && (
                  <span className={stock.changePct >= 0 ? 'up' : 'down'}>
                    {' '}
                    {fmtPct(stock.changePct)}
                  </span>
                )}
              </span>
            )}
          </h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {(stock.industry || stock.concept) && (
            <div className="stock-tags">
              {stock.industry && <span className="tag tag-industry">🏭 {stock.industry}</span>}
              {stock.concept && (
                <span className="tag tag-concept">🧠 {stock.concept.split(',').slice(0, 3).join(' · ')}</span>
              )}
            </div>
          )}

          <div className="score-banner">
            <div className="total-score-big">
              <span className="label">综合评分</span>
              <span className="value">{stock.totalScore.toFixed(1)}</span>
              <span className="unit">/ 100</span>
            </div>
            <div className="factor-chips">
              {stock.factorScores.length > 0 ? (
                stock.factorScores.map((f) => (
                  <span key={f.key} className="chip">
                    <b>{f.name}</b> {f.score.toFixed(0)}
                  </span>
                ))
              ) : (
                <span className="chip">暂无因子明细</span>
              )}
            </div>
          </div>

          {/* 综合分析卡片 */}
          <section className="analysis-card">
            <div className="analysis-head">
              <div>
                <div className="analysis-kicker">智能诊断</div>
                <h3>个股综合分析</h3>
              </div>
              <span
                className={`analysis-badge ${
                  riskLabel === '止损风险'
                    ? 'bad'
                    : riskLabel === '接近止盈'
                      ? 'good'
                      : 'mid'
                }`}
              >
                {riskLabel}
              </span>
            </div>

            <div className="analysis-grid">
              <div className="analysis-box">
                <span className="analysis-label">技术位</span>
                <strong>{signal ? `${fmt(signal.buyLow)} ~ ${fmt(signal.buyHigh)}` : '--'}</strong>
                <span className="analysis-sub">
                  止盈 {signal ? fmt(signal.takeProfit) : '--'} · 止损 {signal ? fmt(signal.stopLoss) : '--'} · 移动止盈 {signal ? fmt(signal.trailingStop) : '--'}
                </span>
                {signal?.box && (
                  <div className="box-breakout-line">
                    <span
                      className={`box-badge ${
                        signal.box.active ? (signal.box.breakoutDay ? 'box-hot' : 'box-active') : 'box-idle'
                      }`}
                    >
                      {signal.box.active
                        ? signal.box.breakoutDay
                          ? '🔥 今日放量突破'
                          : '📈 已突破箱体'
                        : `📦 横盘中 ${signal.box.boxDays} 日`}
                    </span>
                    <span className="box-sub">
                      {signal.box.active ? (
                        <>
                          箱体 {fmt(signal.box.boxLow)}~{fmt(signal.box.boxHigh)} · 打开空间目标{' '}
                          {fmt(signal.box.measuredTarget)}
                        </>
                      ) : (
                        <>箱体 {fmt(signal.box.boxLow)}~{fmt(signal.box.boxHigh)} · 等待放量突破</>
                      )}
                    </span>
                    {signal.box.active && (
                      <span className="box-sub">
                        突破买 {fmt(signal.box.buyLow)}~{fmt(signal.box.buyHigh)} · 突破止损{' '}
                        {fmt(signal.box.stopLoss)} · 空间比 {fmt(signal.box.riskReward, 1)}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="analysis-box">
                <span className="analysis-label">资金面</span>
                <strong>{fmtFlow(moneyFlow?.mainNetInflow)}</strong>
                <span className="analysis-sub">
                  超大单 {fmtFlow(moneyFlow?.superNetInflow)} · 大单 {fmtFlow(moneyFlow?.bigNetInflow)}
                </span>
                <span className="analysis-sub">
                  5日合计 {fmtFlow(moneyFlowSum)} · 趋势 {fmtFlow(moneyFlowTrend)}
                </span>
              </div>
              <div className="analysis-box">
                <span className="analysis-label">基本面</span>
                <strong>{fmtPct(financials?.roe)} ROE</strong>
                <span className="analysis-sub">
                  营收 {fmtPct(financials?.revenueGrowth)} · 净利 {fmtPct(financials?.profitGrowth)} · 负债 {fmtPct(financials?.debtRatio)}
                </span>
              </div>
            </div>

            <div className="analysis-zone">
              <div className="analysis-zone-track" />
              {signal && currentPrice !== undefined && (
                <>
                  <div className="analysis-zone-fill" />
                  <div
                    className="analysis-marker support"
                    style={{ left: '0%' }}
                    title={`支撑 ${fmt(signal.buyLow)}`}
                  />
                  <div
                    className="analysis-marker price"
                    style={{ left: `${pricePos}%` }}
                    title={`现价 ${fmt(currentPrice)}`}
                  />
                  <div
                    className="analysis-marker target"
                    style={{ left: '100%' }}
                    title={`止盈 ${fmt(signal.takeProfit)}`}
                  />
                </>
              )}
            </div>

            <div className="analysis-tags">
              {signal?.reasons.slice(0, 3).map((reason, i) => (
                <span key={i} className="analysis-tag">
                  {reason}
                </span>
              ))}
              {stock.highRisk && <span className="analysis-tag bad">高位风险预警</span>}
            </div>
          </section>

          {/* 企稳状态大标识 */}
          {signal?.stability && (
            <div className={`verdict-card verdict-${signal.stability.verdict.color}`}>
              <div className="verdict-main">
                <span className="verdict-label">{signal.stability.verdict.label}</span>
                <span className="verdict-score">评分 {signal.stability.verdict.score > 0 ? '+' : ''}{signal.stability.verdict.score}</span>
                <span className="verdict-confidence">置信度 {signal.stability.verdict.confidence === 'high' ? '高' : signal.stability.verdict.confidence === 'medium' ? '中' : '低'}</span>
              </div>
              <p className="verdict-summary">{signal.stability.verdict.summary}</p>
              <div className="verdict-signals">
                {signal.stability.verdict.signals.map((s, i) => (
                  <span key={i} className="verdict-signal good">✓ {s}</span>
                ))}
                {signal.stability.verdict.risks.map((r, i) => (
                  <span key={i} className="verdict-signal risk">✗ {r}</span>
                ))}
              </div>
            </div>
          )}

          {/* 买入决策 */}
          {buyDecision && (
            <div className={`buy-decision-card buy-decision-${buyDecision.summary.color}`}>
              <div className="buy-decision-head">
                <span className="buy-decision-verdict">{buyDecision.summary.verdict}</span>
                {stock.buyScore !== undefined && (
                  <span className="buy-decision-count">列表评分 {stock.buyScore}/9</span>
                )}
                <span className="buy-decision-count">详细 {buyDecision.summary.passCount}/{buyDecision.summary.total}</span>
              </div>
              <p className="buy-decision-hint">
                {buyDecision.summary.hint}（列表评分与详细评分算法不同，详细评分含板块/大盘/动能，更全面）
              </p>
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
                  onClick={toggleWatchFromDetail}
                  disabled={watched}
                >
                  {watched ? '👁️ 已监控' : '👁️ 加入监控'}
                </button>
                <button
                  className={`btn btn-sm btn-primary ${held ? 'btn-disabled' : ''}`}
                  onClick={buyFromDetail}
                  disabled={held}
                >
                  {held ? '💼 已持仓' : '💼 模拟买入'}
                </button>
              </div>
            </div>
          )}

          {/* 板块判断条件 */}
          {sectorJudgment && (sectorJudgment.industry || sectorJudgment.concept) && (
            <div className="card sector-judge-card">
              <h3>📊 板块判断条件</h3>
              <div className="sector-judge-grid">
                {sectorJudgment.industry && (
                  <div className={`sector-judge-item c-${sectorJudgment.industry.color}`}>
                    <span className="sector-judge-label">🏭 {sectorJudgment.industry.name}</span>
                    <span className="sector-judge-status">{sectorJudgment.industry.label}</span>
                    <span className="sector-judge-detail">
                      {sectorJudgment.industry.signals.join(' · ') || sectorJudgment.industry.risks.join(' · ')}
                    </span>
                  </div>
                )}
                {sectorJudgment.concept && (
                  <div className={`sector-judge-item c-${sectorJudgment.concept.color}`}>
                    <span className="sector-judge-label">🧠 {sectorJudgment.concept.name}</span>
                    <span className="sector-judge-status">{sectorJudgment.concept.label}</span>
                    <span className="sector-judge-detail">
                      {sectorJudgment.concept.signals.join(' · ') || sectorJudgment.concept.risks.join(' · ')}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 看盘指南 */}
          <div className="card guide-card">
            <h3>📖 看盘指南：优先看什么指标</h3>
            <div className="guide-list">
              <div className="guide-item guide-1">
                <span className="guide-rank">1</span>
                <div>
                  <span className="guide-title">是否创新低（最重要）</span>
                  <span className="guide-desc">近5日是否创20日新低 → 创新低=没企稳，不创新低=可能止跌</span>
                </div>
              </div>
              <div className="guide-item guide-2">
                <span className="guide-rank">2</span>
                <div>
                  <span className="guide-title">均线位置（MA20/MA60）</span>
                  <span className="guide-desc">站上MA20=短期转强，站上MA60=中期转强，跌破=趋势走弱</span>
                </div>
              </div>
              <div className="guide-item guide-3">
                <span className="guide-rank">3</span>
                <div>
                  <span className="guide-title">MACD柱方向</span>
                  <span className="guide-desc">柱体放大=动能转强，柱体收窄=动能减弱，金叉后红柱放大最佳</span>
                </div>
              </div>
              <div className="guide-item guide-4">
                <span className="guide-rank">4</span>
                <div>
                  <span className="guide-title">量能配合</span>
                  <span className="guide-desc">缩量企稳→放量上涨=健康，放量滞涨=警惕，持续缩量=无方向</span>
                </div>
              </div>
              <div className="guide-item guide-5">
                <span className="guide-rank">5</span>
                <div>
                  <span className="guide-title">板块是否助力</span>
                  <span className="guide-desc">板块上涨+领涨=顺风，板块下跌+跑输=逆风，板块比个股更重要</span>
                </div>
              </div>
            </div>
          </div>

          {/* 企稳相关指标 */}
          {signal?.stability && (
            <div className="card stability-card">
              <h3>🛟 企稳相关指标</h3>
              <p className="sa-section-hint">绿边=好的信号，黄边=风险信号。综合判断是否企稳：均线向上+MACD转好+未创新低+量能温和=企稳。</p>
              <div className="stability-grid">
                <div className={`stability-item ${signal.stability.aboveMa20 ? 'ok' : 'warn'}`}>
                  <span className="stability-label">MA20</span>
                  <span className="stability-value">
                    {signal.stability.aboveMa20 ? '站上' : '跌破'} {fmt(signal.stability.ma20)}
                  </span>
                  <span className="stability-note">
                    距MA20 {signal.stability.distToMa20Pct >= 0 ? '+' : ''}
                    {signal.stability.distToMa20Pct.toFixed(1)}%
                  </span>
                </div>
                <div className={`stability-item ${signal.stability.aboveMa60 ? 'ok' : 'warn'}`}>
                  <span className="stability-label">MA60</span>
                  <span className="stability-value">
                    {signal.stability.aboveMa60 ? '站上' : '跌破'} {fmt(signal.stability.ma60)}
                  </span>
                </div>
                <div className={`stability-item ${signal.stability.macdTrend === 'improving' ? 'ok' : 'warn'}`}>
                  <span className="stability-label">MACD柱</span>
                  <span className="stability-value">
                    {signal.stability.macdHist >= 0 ? '+' : ''}
                    {fmt(signal.stability.macdHist)} →
                    {signal.stability.macdHistPrev >= 0 ? '+' : ''}
                    {fmt(signal.stability.macdHistPrev)}
                  </span>
                  <span className="stability-note">
                    {signal.stability.macdTrend === 'improving' ? '柱体放大（转好）' : '柱体收窄（转弱）'}
                  </span>
                </div>
                <div className={`stability-item ${signal.stability.volRatio >= 0.8 && signal.stability.volRatio <= 1.3 ? 'ok' : 'warn'}`}>
                  <span className="stability-label">量能</span>
                  <span className="stability-value">量比 {signal.stability.volRatio.toFixed(2)}</span>
                  <span className="stability-note">
                    {signal.stability.volRatio < 0.8
                      ? '缩量'
                      : signal.stability.volRatio > 1.5
                        ? '放量'
                        : '温和'}
                  </span>
                </div>
                <div className={`stability-item ${signal.stability.makeNewLow ? 'bad' : 'ok'}`}>
                  <span className="stability-label">近期低点</span>
                  <span className="stability-value">
                    {signal.stability.makeNewLow ? '⚠️ 创20日新低' : '未创新低'}
                  </span>
                  <span className="stability-note">
                    {signal.stability.nearLow ? '仍处低位' : '已脱离低位'}
                  </span>
                </div>
                <div className={`stability-item ${signal.stability.rsi !== null && signal.stability.rsi >= 40 && signal.stability.rsi <= 70 ? 'ok' : signal.stability.rsi !== null && signal.stability.rsi < 30 ? 'warn' : 'mid'}`}>
                  <span className="stability-label">RSI</span>
                  <span className="stability-value">
                    {signal.stability.rsi !== null ? signal.stability.rsi.toFixed(0) : '--'}
                  </span>
                  <span className="stability-note">
                    {signal.stability.rsi === null
                      ? '数据不足'
                      : signal.stability.rsi < 30
                        ? '超卖区'
                        : signal.stability.rsi > 70
                          ? '超买区'
                          : '健康区'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* 估值与市值指标 */}
          <div className="metric-strip">
            <div className="metric-item">
              <span className="metric-label">市盈率</span>
              <span className="metric-value">{stock.pe !== undefined ? `${stock.pe.toFixed(1)}x` : '--'}</span>
            </div>
            <div className="metric-item">
              <span className="metric-label">市净率</span>
              <span className="metric-value">{stock.pb !== undefined ? `${stock.pb.toFixed(2)}x` : '--'}</span>
            </div>
            <div className="metric-item">
              <span className="metric-label">总市值</span>
              <span className="metric-value">{fmtMv(stock.totalMv)}</span>
            </div>
            <div className="metric-item">
              <span className="metric-label">流通市值</span>
              <span className="metric-value">{fmtMv(stock.floatMv)}</span>
            </div>
            <div className="metric-item">
              <span className="metric-label">换手率</span>
              <span className="metric-value">
                {stock.turnoverRate !== undefined ? `${stock.turnoverRate.toFixed(2)}%` : '--'}
              </span>
            </div>
          </div>

          {/* 所属板块行情/热度 */}
          {(sectorInfo?.industry || sectorInfo?.concept) && (
            <div className="card sector-card">
              <h3>📊 所属板块表现</h3>
              <div className="sector-list">
                {sectorInfo.industry && (
                  <div className="sector-row">
                    <span className="sector-row-label">🏭 行业</span>
                    <SectorBadge
                      brief={{
                        name: sectorInfo.industry.name,
                        avgChangePct: sectorInfo.industry.avgChangePct,
                        vsAvg: sectorInfo.industry.vsAvg,
                        rank: sectorInfo.industry.rank,
                      }}
                    />
                    <span className="sector-row-stat">
                      涨停 {sectorInfo.industry.limitUpCount} 家 · 上涨占比{' '}
                      {(sectorInfo.industry.upRatio * 100).toFixed(0)}%
                    </span>
                  </div>
                )}
                {sectorInfo.concept && (
                  <div className="sector-row">
                    <span className="sector-row-label">🧠 概念</span>
                    <SectorBadge
                      brief={{
                        name: sectorInfo.concept.name,
                        avgChangePct: sectorInfo.concept.avgChangePct,
                        vsAvg: sectorInfo.concept.vsAvg,
                        rank: sectorInfo.concept.rank,
                      }}
                    />
                    <span className="sector-row-stat">
                      涨停 {sectorInfo.concept.limitUpCount} 家 · 上涨占比{' '}
                      {(sectorInfo.concept.upRatio * 100).toFixed(0)}%
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 选股维度数据 */}
          {selectionMetrics && (
            <div className="card sa-selection-card">
              <h3>📊 选股维度数据（供自行判断）</h3>
              <div className="sa-selection-grid">
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

          {/* K线形态 + 支撑压力 + 量能趋势 */}
          {klinePatterns && (
            <div className="card sa-pattern-card">
              <h3>K线形态 / 支撑压力 / 量能趋势</h3>
              <div className="sa-pattern-grid">
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

          {chartTab === 'kline' &&
            (loading ? (
              <div className="loading-hint">加载 K 线数据...</div>
            ) : (
              <KLineChart kline={kline} />
            ))}

          {chartTab === 'minute' &&
            (minute.length > 0 ? (
              <MinuteChart points={minute} prevClose={kline[kline.length - 1]?.close} />
            ) : (
              <div className="loading-hint">加载分时数据...</div>
            ))}

          <div className="detail-grid">
            <div className="card">
              <h3>因子雷达图</h3>
              <RadarChart factorScores={stock.factorScores} />
            </div>
            <div className="card">
              <h3>因子明细</h3>
              {groups.length > 0 ? (
                groups.map((g) => (
                  <div key={g} className="factor-group">
                    <h4>{GROUP_LABELS[g]}</h4>
                    <table className="detail-table">
                      <tbody>
                        {stock.factorScores
                          .filter((f) => f.group === g)
                          .map((f) => (
                            <tr key={f.key}>
                              <td className="d-name">{f.name}</td>
                              <td className="d-detail" title={f.detail}>
                                {f.detail}
                              </td>
                              <td className="d-score">
                                <span
                                  className={`score-pill ${
                                    f.score >= 70 ? 'good' : f.score >= 40 ? 'mid' : 'bad'
                                  }`}
                                >
                                  {f.score.toFixed(0)}
                                </span>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ))
              ) : (
                <div className="loading-hint">暂无因子明细</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
