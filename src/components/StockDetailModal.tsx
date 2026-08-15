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
import { computeTradingSignal, type TradingSignal } from '../engine/tradingSignals'
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

export default function StockDetailModal({ stock, onClose }: Props) {
  const [kline, setKline] = useState<Kline[]>([])
  const [loading, setLoading] = useState(true)
  const [chartTab, setChartTab] = useState<ChartTab>('kline')
  const [minute, setMinute] = useState<MinutePoint[]>([])
  const [signal, setSignal] = useState<TradingSignal | null>(null)
  const [financials, setFinancials] = useState<Financials | null>(null)
  const [moneyFlow, setMoneyFlow] = useState<MoneyFlow | null>(null)
  const [moneyFlowHistory, setMoneyFlowHistory] = useState<number[]>([])

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
  }, [stock.code, stock.market, stock.price])

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
                  止盈 {signal ? fmt(signal.takeProfit) : '--'} · 止损 {signal ? fmt(signal.stopLoss) : '--'}
                </span>
              </div>
              <div className="analysis-box">
                <span className="analysis-label">资金面</span>
                <strong>{fmtFlow(moneyFlow?.mainNetInflow)}</strong>
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
