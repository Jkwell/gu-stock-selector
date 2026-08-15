import { useCallback, useEffect, useState } from 'react'
import type { StockScore } from '../types'
import { fetchRealtimeQuotes, type Quote } from '../data/api'
import { getPickRecords, type PickRecord } from '../data/records'

interface Props {
  onSelect: (stock: StockScore) => void
}

/** 复盘面板：历史推荐表现统计 */
export default function ReviewPanel({ onSelect }: Props) {
  const [records] = useState<PickRecord[]>(() => getPickRecords())
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map())
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    const recs = getPickRecords()
    if (recs.length === 0) return
    setLoading(true)
    const codes = recs.flatMap((r) => r.picks.map((p) => p.code))
    try {
      const qs = await fetchRealtimeQuotes(codes)
      setQuotes(new Map(qs.map((q) => [q.code, q])))
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (records.length === 0) {
    return (
      <div className="card muted" style={{ textAlign: 'center', padding: 40 }}>
        📋 暂无推荐记录。去「🎯 今日推荐」生成一次推荐，这里就能复盘它的表现。
      </div>
    )
  }

  // 汇总统计
  let total = 0
  let wins = 0
  let sumPct = 0
  let hitStopLoss = 0
  let hitTakeProfit = 0
  for (const r of records) {
    for (const p of r.picks) {
      const q = quotes.get(p.code)
      if (q?.price === undefined) continue
      const pct = q.price / p.price - 1
      total++
      sumPct += pct
      if (pct > 0) wins++
      if (p.stopLoss > 0 && q.price <= p.stopLoss) hitStopLoss++
      if (p.takeProfit > 0 && q.price >= p.takeProfit) hitTakeProfit++
    }
  }
  const winRate = total > 0 ? (wins / total) * 100 : 0
  const avgPct = total > 0 ? (sumPct / total) * 100 : 0

  return (
    <div className="config-panel">
      <section className="card">
        <div className="watch-header">
          <h3 style={{ margin: 0 }}>📋 推荐复盘（{records.length} 天记录）</h3>
          <button className="btn btn-sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '🔄 刷新'}
          </button>
        </div>

        <div className="metric-grid">
          <div className="metric-card">
            <span className="metric-label">累计推荐</span>
            <span className="metric-value">{total}</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">{'胜率（涨>0）'}</span>
            <span className={`metric-value ${winRate >= 50 ? 'up' : 'down'}`}>
              {winRate.toFixed(0)}%
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">平均涨跌</span>
            <span className={`metric-value ${avgPct >= 0 ? 'up' : 'down'}`}>
              {avgPct > 0 ? '+' : ''}
              {avgPct.toFixed(2)}%
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">触发止盈</span>
            <span className="metric-value up">{hitTakeProfit}</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">触发止损</span>
            <span className="metric-value down">{hitStopLoss}</span>
          </div>
        </div>
      </section>

      {records.map((r) => (
        <section key={r.date} className="card">
          <h3>{r.date}</h3>
          <div className="table-wrap" style={{ maxHeight: 'none' }}>
            <table className="result-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>代码</th>
                  <th style={{ textAlign: 'left' }}>名称</th>
                  <th>推荐价</th>
                  <th>现价</th>
                  <th>涨跌幅</th>
                  <th>评分</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {r.picks.map((p) => {
                  const q = quotes.get(p.code)
                  const price = q?.price
                  const pct = price !== undefined ? (price / p.price - 1) * 100 : null
                  const hitSL = price !== undefined && p.stopLoss > 0 && price <= p.stopLoss
                  const hitTP = price !== undefined && p.takeProfit > 0 && price >= p.takeProfit
                  return (
                    <tr
                      key={p.code}
                      style={{ cursor: 'pointer' }}
                      onClick={() =>
                        onSelect({
                          code: p.code,
                          name: p.name,
                          market: p.code.startsWith('6') ? 'sh' : 'sz',
                          totalScore: p.totalScore,
                          factorScores: [],
                        })
                      }
                    >
                      <td className="code">{p.code}</td>
                      <td className="name" style={{ textAlign: 'left' }}>{p.name}</td>
                      <td>{p.price.toFixed(2)}</td>
                      <td>{price !== undefined ? price.toFixed(2) : '—'}</td>
                      <td className={pct !== null && pct >= 0 ? 'up' : 'down'}>
                        {pct !== null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
                      </td>
                      <td>{p.totalScore.toFixed(1)}</td>
                      <td>
                        {hitSL ? (
                          <span className="score-pill bad">跌破止损</span>
                        ) : hitTP ? (
                          <span className="score-pill good">到止盈</span>
                        ) : (
                          <span className="score-pill mid">持有中</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}
