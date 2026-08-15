import { useCallback, useEffect, useRef, useState } from 'react'
import type { StockScore } from '../types'
import { fetchRealtimeQuotes, marketOfCode, type Quote } from '../data/api'
import {
  addToWatchlist,
  clearWatchlist,
  getWatchlist,
  removeFromWatchlist,
  watchItemFrom,
  type WatchItem,
} from '../data/watchlist'
import { watchStatus } from '../engine/monitor'
import { fetchKline } from '../data/api'

interface Props {
  onSelect: (stock: StockScore) => void
}

const REFRESH_MS = 5000 // 5 秒刷新（短线盯盘）

/** 根据代码获取名称（用于手动添加：拉 K 线兜底拿名称） */
async function lookupName(code: string): Promise<string> {
  try {
    const quotes = await fetchRealtimeQuotes([code])
    if (quotes[0]?.name) return quotes[0].name.replace(/\s/g, '')
  } catch {
    // fallthrough
  }
  try {
    const kline = await fetchKline(marketOfCode(code), code, 5)
    return kline.length > 0 ? code : code
  } catch {
    return code
  }
}

export default function WatchlistPanel({ onSelect }: Props) {
  const [items, setItems] = useState<WatchItem[]>(() => getWatchlist())
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map())
  const [input, setInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 刷新实时价
  const refresh = useCallback(async () => {
    const codes = getWatchlist().map((w) => w.code)
    if (codes.length === 0) return
    try {
      const qs = await fetchRealtimeQuotes(codes)
      setQuotes(new Map(qs.map((q) => [q.code, q])))
      setLastUpdated(new Date().toLocaleTimeString('zh-CN'))
    } catch {
      // 网络失败忽略，下次重试
    }
  }, [])

  // 定时刷新
  useEffect(() => {
    void refresh()
    timerRef.current = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refresh])

  const handleAdd = async () => {
    const code = input.trim()
    if (!/^\d{6}$/.test(code)) return
    setAdding(true)
    try {
      const name = await lookupName(code)
      addToWatchlist(watchItemFrom(code, name || code))
      setItems(getWatchlist())
      setInput('')
      void refresh()
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = (code: string) => {
    removeFromWatchlist(code)
    setItems(getWatchlist())
  }

  const handleClear = () => {
    if (confirm('清空全部监控？')) {
      clearWatchlist()
      setItems([])
      setQuotes(new Map())
    }
  }

  // 状态异常优先排序
  const sorted = [...items].sort((a, b) => {
    const wa = watchStatus(quotes.get(a.code)?.price, a).status
    const wb = watchStatus(quotes.get(b.code)?.price, b).status
    const rank = (s: string) =>
      s === 'stop_loss' ? 0 : s === 'take_profit' ? 1 : s === 'buy_zone' ? 2 : 3
    return rank(wa) - rank(wb)
  })

  return (
    <div className="config-panel">
      <section className="card">
        <div className="watch-header">
          <h3 style={{ margin: 0 }}>👁️ 监控列表（{items.length} 只）</h3>
          <div className="toolbar-actions">
            <span className="muted">
              {lastUpdated ? `更新于 ${lastUpdated}` : ''} · 每 5 秒刷新
            </span>
            <button className="btn btn-sm" onClick={() => void refresh()}>
              🔄 刷新
            </button>
            {items.length > 0 && (
              <button className="btn btn-sm" onClick={handleClear}>
                清空
              </button>
            )}
          </div>
        </div>

        <div className="watch-add-row">
          <input
            type="text"
            className="watch-add-input"
            placeholder="输入 6 位代码添加，如 600519"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleAdd()}
          />
          <button className="btn" onClick={() => void handleAdd()} disabled={adding}>
            {adding ? '添加中…' : '+ 添加'}
          </button>
        </div>
      </section>

      {items.length === 0 && (
        <div className="card muted" style={{ textAlign: 'center', padding: 30 }}>
          暂无监控。去「🎯 今日推荐」生成推荐会自动加入，或在上方输入代码手动添加。
        </div>
      )}

      <div className="pick-grid">
        {sorted.map((item) => (
          <WatchCard
            key={item.code}
            item={item}
            quote={quotes.get(item.code)}
            onRemove={handleRemove}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}

/** 单只监控卡片 */
function WatchCard({
  item,
  quote,
  onRemove,
  onSelect,
}: {
  item: WatchItem
  quote?: Quote
  onRemove: (code: string) => void
  onSelect: (s: StockScore) => void
}) {
  const price = quote?.price
  const state = watchStatus(price, item)
  const changeCls = (quote?.changePct ?? 0) >= 0 ? 'up' : 'down'
  // 关键状态（跌破止损/到止盈）高亮卡片边框
  const criticalCls =
    state.status === 'stop_loss' ? 'card-flash-red' : state.status === 'take_profit' ? 'card-flash-green' : ''

  return (
    <div
      className={`pick-card ${criticalCls}`}
      onClick={() =>
        onSelect({
          code: item.code,
          name: item.name,
          market: item.market,
          totalScore: item.totalScore ?? 0,
          factorScores: [],
        })
      }
    >
      <div className="pick-card-head">
        <div className="pick-title">
          <span className="pick-name">{item.name}</span>
          <span className="pick-code">{item.code}</span>
          <span className={`watch-badge ${state.cls}`}>{state.label}</span>
        </div>
        <div className="pick-price">
          <div className="pick-price-val">
            {price !== undefined ? `¥${price.toFixed(2)}` : '—'}
          </div>
          <div className={`pick-change ${changeCls}`}>
            {quote?.changePct !== undefined
              ? `${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}%`
              : '—'}
          </div>
        </div>
      </div>

      <div className="price-targets">
        <div className="target target-buy">
          <span className="target-label">买入区间</span>
          <span className="target-val">
            {item.buyLow !== undefined && item.buyHigh !== undefined
              ? `${item.buyLow.toFixed(2)} ~ ${item.buyHigh.toFixed(2)}`
              : '—'}
          </span>
        </div>
        <div className="target target-profit">
          <span className="target-label">止盈</span>
          <span className="target-val">
            {item.takeProfit !== undefined ? item.takeProfit.toFixed(2) : '—'}
          </span>
        </div>
        <div className="target target-stop">
          <span className="target-label">止损</span>
          <span className="target-val">
            {item.stopLoss !== undefined ? item.stopLoss.toFixed(2) : '—'}
          </span>
        </div>
      </div>

      <div className="watch-hint">{state.hint}</div>

      {quote?.turnover !== undefined && (
        <div className="pick-factor-tags">
          <span className="factor-tag">换手率 {quote.turnover.toFixed(2)}%</span>
          {item.totalScore !== undefined && (
            <span className="factor-tag">评分 {item.totalScore.toFixed(1)}</span>
          )}
        </div>
      )}

      <button
        className="watch-remove"
        onClick={(e) => {
          e.stopPropagation()
          onRemove(item.code)
        }}
      >
        ✕ 移除
      </button>
    </div>
  )
}
