import { useCallback, useEffect, useRef, useState } from 'react'
import type { StockScore } from '../types'
import { fetchMarketStocks } from '../data/pipeline'
import { computeConceptHeat, computeSectorHeat, type SectorHeat } from '../engine/sectorHeat'
import { scoreStocks, type ScoringInput } from '../engine/factors'
import { fetchKline, fetchMoneyFlow } from '../data/api'
import { klineCache, moneyflowCache } from '../data/cache'
import { DEFAULT_CONFIG } from '../config/factors'

type HeatTab = 'concept' | 'sector'

interface SectorRecommendation {
  sector: string
  sectorHeat: SectorHeat
  stocks: StockScore[]
}

/** 并发控制 */
async function mapLimit<T, R>(
  items: T[],
  concurrent: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrent, items.length) }, () => run()),
  )
  return results
}

/** 为某个板块的股票打分，返回 Top 10 */
async function scoreSectorStocks(
  sectorStocks: { code: string; name: string; market: 'sh' | 'sz' | 'bj'; industry?: string; concept?: string; price?: number; changePct?: number; totalMv?: number; floatMv?: number; pe?: number; turnoverRate?: number }[],
  factors: typeof DEFAULT_CONFIG.factors,
  onProgress?: (done: number, total: number) => void,
): Promise<StockScore[]> {
  const inputs: ScoringInput[] = []
  let done = 0

  await mapLimit(sectorStocks, 6, async (s) => {
    let kline = await klineCache.get(s.code)
    if (!kline) {
      try {
        kline = await fetchKline(s.market, s.code, 80)
      } catch {
        kline = []
      }
      if (kline.length > 0) await klineCache.set(s.code, kline)
    }

    if (kline.length < 30) {
      done++
      onProgress?.(done, sectorStocks.length)
      return
    }

    let moneyFlow = await moneyflowCache.get(s.code)
    if (!moneyFlow) {
      try {
        moneyFlow = await fetchMoneyFlow(s.market, s.code)
      } catch {
        moneyFlow = null
      }
      if (moneyFlow) await moneyflowCache.set(s.code, moneyFlow)
    }

    inputs.push({
      info: {
        code: s.code,
        name: s.name,
        market: s.market,
        industry: s.industry,
        concept: s.concept,
        price: s.price,
        changePct: s.changePct,
        totalMv: s.totalMv,
        floatMv: s.floatMv,
        pe: s.pe,
        turnoverRate: s.turnoverRate,
      },
      kline,
      moneyFlow: moneyFlow ?? undefined,
    })

    done++
    onProgress?.(done, sectorStocks.length)
  })

  const scored = scoreStocks(inputs, factors)
  return scored.slice(0, 10)
}

export default function SectorAnalysisPanel() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [heatTab, setHeatTab] = useState<HeatTab>('concept')
  const [sectors, setSectors] = useState<SectorHeat[]>([])
  const [recommendations, setRecommendations] = useState<SectorRecommendation[]>([])
  const [scoring, setScoring] = useState(false)
  const [scoreProgress, setScoreProgress] = useState<{ current: number; total: number; sector: string } | null>(null)
  const [expandedSector, setExpandedSector] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadHeat = useCallback(async () => {
    try {
      const stocks = await fetchMarketStocks()
      const data = heatTab === 'concept' ? computeConceptHeat(stocks, 8) : computeSectorHeat(stocks, 8)
      setSectors(data)
      setLastUpdated(new Date().toLocaleTimeString('zh-CN'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [heatTab])

  useEffect(() => {
    setLoading(true)
    setRecommendations([])
    setExpandedSector(null)
    void loadHeat()
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => void loadHeat(), 120000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [loadHeat])

  const handleRecommend = async (sectorHeat: SectorHeat) => {
    setScoring(true)
    setScoreProgress({ current: 0, total: 0, sector: sectorHeat.sector })
    setExpandedSector(sectorHeat.sector)

    try {
      const stocks = await fetchMarketStocks()
      const sector = sectorHeat.sector

      // 筛选属于该板块的股票
      const sectorStocks = stocks.filter((s) => {
        if (heatTab === 'concept') return s.concept === sector
        return s.industry === sector
      })

      // 使用动量+资金流因子模板进行打分
      const factors = DEFAULT_CONFIG.factors.map((f) => {
        const enabled = ['trend', 'macd', 'volume', 'momentum_1m', 'short_momentum', 'moneyflow'].includes(f.key)
        const weights: Record<string, number> = {
          trend: 0.2,
          macd: 0.15,
          volume: 0.15,
          momentum_1m: 0.2,
          short_momentum: 0.15,
          moneyflow: 0.15,
        }
        return {
          ...f,
          enabled,
          weight: enabled ? (weights[f.key] ?? 0) : 0,
        }
      })

      const scored = await scoreSectorStocks(sectorStocks, factors, (done, total) => {
        setScoreProgress({ current: done, total, sector: sectorHeat.sector })
      })

      setRecommendations((prev) => [
        ...prev.filter((r) => r.sector !== sector),
        { sector, sectorHeat, stocks: scored },
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setScoring(false)
      setScoreProgress(null)
    }
  }

  const getRec = (sector: string) => recommendations.find((r) => r.sector === sector)

  if (loading) {
    return <div className="card loading-hint">加载板块数据…</div>
  }

  return (
    <div className="config-panel">
      <section className="card">
        <div className="watch-header">
          <h3 style={{ margin: 0 }}>🔥 板块分析 · 热门板块荐股</h3>
          <div className="chart-tabs">
            <button
              className={`chart-tab ${heatTab === 'concept' ? 'active' : ''}`}
              onClick={() => setHeatTab('concept')}
            >
              概念题材
            </button>
            <button
              className={`chart-tab ${heatTab === 'sector' ? 'active' : ''}`}
              onClick={() => setHeatTab('sector')}
            >
              行业
            </button>
          </div>
        </div>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          基于当日热度识别最热门的板块，每个板块用多因子模型推荐 Top 10 个股。
          {lastUpdated && ` 更新于 ${lastUpdated} · 每 2 分钟刷新`}
        </p>
      </section>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {sectors.length > 0 && (
        <section className="card">
          <div className="sector-analysis-list">
            {sectors.map((s, idx) => {
              const rec = getRec(s.sector)
              const isExpanded = expandedSector === s.sector
              return (
                <div key={s.sector} className="sector-analysis-item">
                  <div className="sector-analysis-head">
                    <div className="sector-rank-badge">#{idx + 1}</div>
                    <div className="sector-info">
                      <span className="sector-name">{s.sector}</span>
                      <span className="sector-stats">
                        <span className={s.avgChangePct >= 0 ? 'up' : 'down'}>
                          均涨 {s.avgChangePct > 0 ? '+' : ''}{s.avgChangePct}%
                        </span>
                        <span className="muted">·</span>
                        <span className={s.limitUpCount > 0 ? 'up' : ''}>
                          涨停 {s.limitUpCount}
                        </span>
                        <span className="muted">·</span>
                        <span>上涨占比 {(s.upRatio * 100).toFixed(0)}%</span>
                        <span className="muted">·</span>
                        <span>{s.stockCount} 只</span>
                      </span>
                    </div>
                    <div className="sector-leaders">
                      <span className="muted" style={{ fontSize: 11 }}>领涨：</span>
                      {s.leaders.map((l) => (
                        <span key={l} className="leader-tag">{l}</span>
                      ))}
                    </div>
                    <button
                      className="btn btn-sm sector-recommend-btn"
                      onClick={() => void handleRecommend(s)}
                      disabled={scoring}
                    >
                      {scoring && isExpanded ? '分析中…' : '📊 推荐 10 只'}
                    </button>
                  </div>

                  {scoreProgress && isExpanded && scoring && (
                    <div className="sector-progress">
                      <span className="muted" style={{ fontSize: 12 }}>
                        正在分析 {scoreProgress.sector} 的个股… {scoreProgress.current}/{scoreProgress.total || '?'}
                      </span>
                    </div>
                  )}

                  {rec && isExpanded && (
                    <div className="sector-stocks">
                      <table className="result-table sector-stocks-table">
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left' }}>排名</th>
                            <th style={{ textAlign: 'left' }}>股票</th>
                            <th>评分</th>
                            <th>涨幅</th>
                            <th>价格</th>
                            <th>行业</th>
                            <th style={{ textAlign: 'left' }}>优势因子</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rec.stocks.map((stock, i) => {
                            const topFactors = stock.factorScores
                              .filter((f) => f.score >= 65)
                              .sort((a, b) => b.score - a.score)
                              .slice(0, 3)
                            return (
                              <tr key={stock.code}>
                                <td className="rank">{i + 1}</td>
                                <td style={{ textAlign: 'left' }}>
                                  <span className="name">{stock.name}</span>
                                  <span className="code-muted" style={{ marginLeft: 6, fontSize: 11 }}>{stock.code}</span>
                                  {stock.highRisk && <span className="risk-badge">高位</span>}
                                </td>
                                <td className="total-score">
                                  <strong>{stock.totalScore.toFixed(1)}</strong>
                                </td>
                                <td className={(stock.changePct ?? 0) >= 0 ? 'up' : 'down'}>
                                  {stock.changePct !== undefined
                                    ? `${stock.changePct >= 0 ? '+' : ''}${stock.changePct.toFixed(2)}%`
                                    : '—'}
                                </td>
                                <td>{stock.price?.toFixed(2) ?? '—'}</td>
                                <td style={{ fontSize: 12, color: '#6b7280' }}>{stock.industry ?? '—'}</td>
                                <td style={{ textAlign: 'left' }}>
                                  <div className="factor-mini-tags">
                                    {topFactors.map((f) => (
                                      <span key={f.key} className="factor-mini-tag">
                                        {f.name} {f.score.toFixed(0)}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      {rec.stocks.length === 0 && (
                        <p className="muted" style={{ padding: 12, textAlign: 'center' }}>
                          该板块暂无足够数据打分，请稍后重试
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {sectors.length === 0 && !loading && (
        <div className="card">
          <p className="muted" style={{ textAlign: 'center', padding: 20 }}>
            暂无板块数据，请稍后刷新重试
          </p>
        </div>
      )}
    </div>
  )
}
