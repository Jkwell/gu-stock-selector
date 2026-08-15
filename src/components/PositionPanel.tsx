import { useCallback, useEffect, useRef, useState } from 'react'
import type { StockScore } from '../types'
import { fetchRealtimeQuotes, type Quote } from '../data/api'
import { addPosition, getPositions, removePosition, type Position } from '../data/positions'

interface Props {
  onSelect: (stock: StockScore) => void
}

const REFRESH_MS = 10000

export default function PositionPanel({ onSelect }: Props) {
  const [positions, setPositions] = useState<Position[]>(() => getPositions())
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map())
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  // 添加表单
  const [code, setCode] = useState('')
  const [buyPrice, setBuyPrice] = useState('')
  const [shares, setShares] = useState('100')
  const [stopLoss, setStopLoss] = useState('')
  const [adding, setAdding] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    const codes = getPositions().map((p) => p.code)
    if (codes.length === 0) return
    try {
      const qs = await fetchRealtimeQuotes(codes)
      setQuotes(new Map(qs.map((q) => [q.code, q])))
      setLastUpdated(new Date().toLocaleTimeString('zh-CN'))
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void refresh()
    timerRef.current = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refresh])

  const handleAdd = async () => {
    const c = code.trim()
    const bp = Number(buyPrice)
    if (!/^\d{6}$/.test(c) || !Number.isFinite(bp) || bp <= 0) return
    setAdding(true)
    try {
      // 拉名称
      const qs = await fetchRealtimeQuotes([c])
      const name = qs[0]?.name?.replace(/\s/g, '') || c
      addPosition({
        code: c,
        name,
        buyPrice: bp,
        shares: Math.max(1, Number(shares) || 100),
        buyDate: new Date().toISOString().slice(0, 10),
        stopLoss: Number(stopLoss) > 0 ? Number(stopLoss) : undefined,
      })
      setPositions(getPositions())
      setCode('')
      setBuyPrice('')
      setStopLoss('')
      void refresh()
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = (c: string) => {
    removePosition(c)
    setPositions(getPositions())
  }

  // 总市值/盈亏
  let totalCost = 0
  let totalValue = 0
  for (const p of positions) {
    const q = quotes.get(p.code)
    totalCost += p.buyPrice * p.shares
    if (q?.price !== undefined) totalValue += q.price * p.shares
  }
  const totalPnl = totalValue - totalCost
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0

  return (
    <div className="config-panel">
      <section className="card">
        <div className="watch-header">
          <h3 style={{ margin: 0 }}>💰 模拟持仓（{positions.length} 只）</h3>
          <div className="toolbar-actions">
            <span className="muted">
              {lastUpdated ? `更新于 ${lastUpdated}` : ''} · 每 10 秒刷新
            </span>
            <button className="btn btn-sm" onClick={() => void refresh()}>
              🔄 刷新
            </button>
          </div>
        </div>

        {positions.length > 0 && (
          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">总成本</span>
              <span className="metric-value">¥{totalCost.toFixed(0)}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">总市值</span>
              <span className="metric-value">¥{totalValue.toFixed(0)}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">总盈亏</span>
              <span className={`metric-value ${totalPnl >= 0 ? 'up' : 'down'}`}>
                {totalPnl >= 0 ? '+' : ''}¥{totalPnl.toFixed(0)}
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">盈亏率</span>
              <span className={`metric-value ${totalPnlPct >= 0 ? 'up' : 'down'}`}>
                {totalPnlPct >= 0 ? '+' : ''}
                {totalPnlPct.toFixed(2)}%
              </span>
            </div>
          </div>
        )}

        <div className="watch-add-row" style={{ marginTop: 12 }}>
          <input
            type="text"
            className="watch-add-input" style={{ maxWidth: 100 }}
            placeholder="代码"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <input
            type="number"
            className="watch-add-input" style={{ maxWidth: 100 }}
            placeholder="买入价"
            value={buyPrice}
            onChange={(e) => setBuyPrice(e.target.value)}
          />
          <input
            type="number"
            className="watch-add-input" style={{ maxWidth: 90 }}
            placeholder="股数"
            value={shares}
            onChange={(e) => setShares(e.target.value)}
          />
          <input
            type="number"
            className="watch-add-input" style={{ maxWidth: 100 }}
            placeholder="止损(可选)"
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
          />
          <button className="btn" onClick={() => void handleAdd()} disabled={adding}>
            {adding ? '添加中…' : '+ 记录'}
          </button>
        </div>
      </section>

      {positions.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center', padding: 40 }}>
          暂无持仓。输入代码 + 买入价，记录你的模拟持仓。
        </div>
      ) : (
        <section className="card">
          <div className="table-wrap" style={{ maxHeight: 'none' }}>
            <table className="result-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>代码</th>
                  <th style={{ textAlign: 'left' }}>名称</th>
                  <th>买入价</th>
                  <th>现价</th>
                  <th>股数</th>
                  <th>盈亏</th>
                  <th>盈亏率</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const q = quotes.get(p.code)
                  const price = q?.price
                  const pnl = price !== undefined ? (price - p.buyPrice) * p.shares : null
                  const pct = price !== undefined ? (price / p.buyPrice - 1) * 100 : null
                  const hitSL = price !== undefined && p.stopLoss !== undefined && price <= p.stopLoss
                  return (
                    <tr
                      key={p.code}
                      style={{ cursor: 'pointer' }}
                      onClick={() =>
                        onSelect({
                          code: p.code,
                          name: p.name,
                          market: p.code.startsWith('6') ? 'sh' : 'sz',
                          totalScore: 0,
                          factorScores: [],
                        })
                      }
                    >
                      <td className="code">{p.code}</td>
                      <td className="name" style={{ textAlign: 'left' }}>{p.name}</td>
                      <td>{p.buyPrice.toFixed(2)}</td>
                      <td>{price !== undefined ? price.toFixed(2) : '—'}</td>
                      <td>{p.shares}</td>
                      <td className={pnl !== null && pnl >= 0 ? 'up' : 'down'}>
                        {pnl !== null ? `${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(0)}` : '—'}
                      </td>
                      <td className={pct !== null && pct >= 0 ? 'up' : 'down'}>
                        {pct !== null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
                      </td>
                      <td>
                        {hitSL ? (
                          <span className="score-pill bad">跌破止损</span>
                        ) : (
                          <span className="score-pill mid">持有中</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="watch-remove"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRemove(p.code)
                          }}
                        >
                          卖出
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
