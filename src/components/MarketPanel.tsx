import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchMarketStocks } from '../data/pipeline'
import { fetchKline } from '../data/api'
import { computeMarketSentiment, type MarketSentiment } from '../engine/marketSentiment'
import { computeConceptHeat, computeSectorHeat, type SectorHeat } from '../engine/sectorHeat'
import { computeMarketTiming, type MarketTiming } from '../engine/marketTiming'
import { positionAdvice } from '../engine/positionAdvice'

type HeatTab = 'sector' | 'concept'

/** 市场概览面板：情绪温度 + 热点板块（行业/概念切换） */
export default function MarketPanel() {
  const [sentiment, setSentiment] = useState<MarketSentiment | null>(null)
  const [sectors, setSectors] = useState<SectorHeat[]>([])
  const [concepts, setConcepts] = useState<SectorHeat[]>([])
  const [heatTab, setHeatTab] = useState<HeatTab>('concept') // 默认概念榜（短线更相关）
  const [timings, setTimings] = useState<MarketTiming[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const stocks = await fetchMarketStocks()
      setSentiment(computeMarketSentiment(stocks))
      setSectors(computeSectorHeat(stocks, 12))
      setConcepts(computeConceptHeat(stocks, 12))
      // 大盘择时：上证 + 深成指
      const idxList: Array<[string, string, string]> = [
        ['sh', '000001', '上证指数'],
        ['sz', '399001', '深证成指'],
      ]
      const ts: MarketTiming[] = []
      for (const [mkt, code, name] of idxList) {
        try {
          const kl = await fetchKline(mkt as 'sh' | 'sz', code, 60)
          const t = computeMarketTiming(kl)
          if (t) {
            t.code = code
            t.name = name
            ts.push(t)
          }
        } catch {
          // 单个指数失败不影响其他
        }
      }
      setTimings(ts)
      setLastUpdated(new Date().toLocaleTimeString('zh-CN'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    timerRef.current = setInterval(() => void refresh(), 60000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refresh])

  if (loading && !sentiment) {
    return <div className="card loading-hint">加载市场数据…</div>
  }

  const levelCls =
    sentiment?.level === 'hot' ? 'level-hot' : sentiment?.level === 'cold' ? 'level-cold' : 'level-neutral'
  const levelIcon =
    sentiment?.level === 'hot' ? '🔥' : sentiment?.level === 'cold' ? '🧊' : '😐'

  return (
    <div className="config-panel">
      {error && <div className="error-banner">⚠️ {error}</div>}

      {/* 大盘择时 */}
      {timings.length > 0 && (
        <section className="card">
          <h3 style={{ margin: '0 0 10px' }}>📉 大盘趋势（总闸门）</h3>
          <div className="metric-grid">
            {timings.map((t) => (
              <div key={t.code} className="metric-card">
                <span className="metric-label">{t.name}</span>
                <span className={`metric-value ${t.trend === 'above' ? 'up' : 'down'}`}>
                  {t.trend === 'above' ? '🟢' : '🔴'} {t.price.toFixed(2)}
                </span>
                <span className="muted" style={{ fontSize: 11 }}>
                  MA20 {t.ma20.toFixed(2)} · {t.trend === 'above' ? '多头(可做)' : '破位(降仓)'}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 情绪温度 */}
      {sentiment && (
        <section className="card">
          <div className="sentiment-head">
            <h3 style={{ margin: 0 }}>
              🌡️ 市场情绪 · {levelIcon}{' '}
              {sentiment.level === 'hot' ? '火热' : sentiment.level === 'cold' ? '冰点' : '中性'}
            </h3>
            <span className="muted">
              {lastUpdated ? `更新于 ${lastUpdated}` : ''} · 每 60 秒刷新
            </span>
          </div>

          {/* 温度计 */}
          <div className={`sentiment-meter ${levelCls}`}>
            <div
              className="sentiment-fill"
              style={{ width: `${sentiment.temperature}%` }}
            />
            <span className="sentiment-temp">{sentiment.temperature}°</span>
          </div>

          <p className={`sentiment-advice ${levelCls}`}>{sentiment.advice}</p>

          {/* 仓位建议 */}
          <div className="position-advice">
            <span className="position-advice-icon">
              {sentiment.level === 'hot' ? '💰' : sentiment.level === 'cold' ? '🛑' : '⚠️'}
            </span>
            <span>{positionAdvice(sentiment.temperature).text}</span>
          </div>

          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">涨停</span>
              <span className="metric-value up">{sentiment.limitUpCount}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">跌停</span>
              <span className="metric-value down">{sentiment.limitDownCount}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">上涨</span>
              <span className="metric-value up">{sentiment.upCount}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">下跌</span>
              <span className="metric-value down">{sentiment.downCount}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">平均涨跌</span>
              <span className={`metric-value ${sentiment.avgChangePct >= 0 ? 'up' : 'down'}`}>
                {sentiment.avgChangePct > 0 ? '+' : ''}
                {sentiment.avgChangePct}%
              </span>
            </div>
          </div>
        </section>
      )}

      {/* 热点板块（概念/行业切换） */}
      {(sectors.length > 0 || concepts.length > 0) && (
        <section className="card">
          <div className="watch-header">
            <h3 style={{ margin: 0 }}>🔥 今日热点</h3>
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
          <div className="table-wrap" style={{ maxHeight: 'none' }}>
            <table className="result-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>排名</th>
                  <th style={{ textAlign: 'left' }}>题材</th>
                  <th>平均涨幅</th>
                  <th>涨停</th>
                  <th>上涨占比</th>
                  <th style={{ textAlign: 'left' }}>领涨股</th>
                </tr>
              </thead>
              <tbody>
                {(heatTab === 'concept' ? concepts : sectors).map((s, i) => (
                  <tr key={s.sector}>
                    <td className="rank">{i + 1}</td>
                    <td className="name" style={{ textAlign: 'left' }}>
                      {s.sector}
                      <span className="muted" style={{ marginLeft: 6 }}>({s.stockCount})</span>
                    </td>
                    <td className={s.avgChangePct >= 0 ? 'up' : 'down'}>
                      {s.avgChangePct > 0 ? '+' : ''}
                      {s.avgChangePct}%
                    </td>
                    <td className={s.limitUpCount > 0 ? 'up' : ''}>{s.limitUpCount}</td>
                    <td>{(s.upRatio * 100).toFixed(0)}%</td>
                    <td className="name" style={{ textAlign: 'left', fontSize: 12 }}>
                      {s.leaders.join('、')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
