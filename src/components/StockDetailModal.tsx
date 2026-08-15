import { useEffect, useState } from 'react'
import type { Kline, StockScore } from '../types'
import { klineCache } from '../data/cache'
import { fetchKline, fetchMinuteData, type MinutePoint } from '../data/api'
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

export default function StockDetailModal({ stock, onClose }: Props) {
  const [kline, setKline] = useState<Kline[]>([])
  const [loading, setLoading] = useState(true)
  const [chartTab, setChartTab] = useState<ChartTab>('kline')
  const [minute, setMinute] = useState<MinutePoint[]>([])

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
      if (!cancelled) {
        setKline(data)
        setLoading(false)
      }
    })()
    // 拉分时数据
    fetchMinuteData(stock.code)
      .then((pts) => {
        if (!cancelled) setMinute(pts)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [stock.code, stock.market])

  const groups = [...new Set(stock.factorScores.map((f) => f.group))]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {stock.name} <span className="code-muted">{stock.code}</span>
            {stock.price !== undefined && (
              <span className="modal-price">
                {' '}
                ¥{stock.price.toFixed(2)}
                {stock.changePct !== undefined && (
                  <span
                    className={stock.changePct >= 0 ? 'up' : 'down'}
                  >
                    {' '}
                    {stock.changePct >= 0 ? '+' : ''}
                    {stock.changePct.toFixed(2)}%
                  </span>
                )}
              </span>
            )}
          </h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {/* 总分横幅 */}
          <div className="score-banner">
            <div className="total-score-big">
              <span className="label">综合评分</span>
              <span className="value">{stock.totalScore.toFixed(1)}</span>
              <span className="unit">/ 100</span>
            </div>
            <div className="factor-chips">
              {stock.factorScores.map((f) => (
                <span key={f.key} className="chip">
                  <b>{f.name}</b> {f.score.toFixed(0)}
                </span>
              ))}
            </div>
          </div>

          {/* 图表切换 */}
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
              <div className="loading-hint">加载K线数据…</div>
            ) : (
              <KLineChart kline={kline} />
            ))}

          {chartTab === 'minute' &&
            (minute.length > 0 ? (
              <MinuteChart
                points={minute}
                prevClose={kline[kline.length - 1]?.close}
              />
            ) : (
              <div className="loading-hint">加载分时数据…</div>
            ))}

          <div className="detail-grid">
            <div className="card">
              <h3>因子得分雷达图</h3>
              <RadarChart factorScores={stock.factorScores} />
            </div>
            <div className="card">
              <h3>因子明细</h3>
              {groups.map((g) => (
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
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
