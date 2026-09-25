import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SelectionResult, StockScore, TradingSignalBrief } from '../types'
import { fetchRealtimeQuotes } from '../data/api'
import { addToWatchlist, getWatchlist, removeFromWatchlist, watchItemFrom } from '../data/watchlist'
import { addPosition, getPositions } from '../data/positions'

interface Props {
  result: SelectionResult
  onSelect: (stock: StockScore) => void
  onBack: () => void
}

type SortKey = 'total' | 'trend' | 'valuation' | 'growth' | 'money' | 'stability' | 'buy' | 'concentration' | 'sector' | 'change' | 'composite' | 'pullback'
type SortKeyExtra = SortKey | 'rr' | string

/** 按列排序，null/无信号 排最后 */
function sortStocks(list: StockScore[], key: SortKey | SortKeyExtra): StockScore[] {
  const get = (s: StockScore): number => {
    if (key === 'composite') return s.compositeScore ?? -Infinity
    if (key === 'total') return s.totalScore
    if (key === 'rr') return s.signal?.riskReward ?? -Infinity
    if (key === 'buy') return s.buyScore ?? -Infinity
    if (key === 'stability') return s.stabilityScore ?? -Infinity
    if (key === 'concentration') return s.fundConcentration?.ratio ?? -Infinity
    if (key === 'sector') return s.sectorStrength?.vsSector ?? -Infinity
    if (key === 'change') return s.changePct ?? -Infinity
    if (key === 'trend')
      return s.factorScores
        .filter((f) => ['trend', 'macd', 'rsi', 'volume'].includes(f.key))
        .reduce((sum, f) => sum + f.score, 0) / 4
    if (key === 'valuation') return findScore(s, 'valuation')
    if (key === 'growth') return Math.max(findScore(s, 'profitability'), findScore(s, 'growth'))
    if (key === 'money') return findScore(s, 'moneyflow')
    return findScore(s, key)
  }
  return [...list].sort((a, b) => get(b) - get(a))
}

function findScore(s: StockScore, key: string): number {
  return s.factorScores.find((f) => f.key === key)?.score ?? -Infinity
}

function exportCSV(result: SelectionResult) {
  const headers = ['排名', '代码', '名称', '现价', '涨跌幅%', '总分', '买入区间', '止盈', '止损', '性价比']
  const factorKeys = result.scored[0]?.factorScores.map((f) => f.name) ?? []
  const rows = result.scored.map((s, i) => {
    const scoreMap = new Map(s.factorScores.map((f) => [f.name, f.score.toFixed(1)]))
    const sig = s.signal
    return [
      i + 1,
      s.code,
      s.name,
      s.price ?? '',
      s.changePct ?? '',
      s.totalScore,
      sig ? `${sig.buyLow.toFixed(2)}~${sig.buyHigh.toFixed(2)}` : '',
      sig ? sig.takeProfit.toFixed(2) : '',
      sig ? sig.stopLoss.toFixed(2) : '',
      sig ? sig.riskReward.toFixed(2) : '',
      ...factorKeys.map((k) => scoreMap.get(k) ?? ''),
    ].join(',')
  })
  const csv = '﻿' + [headers.concat(factorKeys).join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `选股结果_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const pctClass = (v?: number) => (v === undefined ? '' : v >= 0 ? 'up' : 'down')

/** 手动加入监控按钮（点击行不触发） */
function WatchButton({
  stock,
  watched,
  onToggle,
}: {
  stock: StockScore
  watched: boolean
  onToggle: (s: StockScore, nowWatched: boolean) => void
}) {
  return (
    <button
      className={`watch-add-btn ${watched ? 'watched' : ''}`}
      title={watched ? '已加入监控，点击移除' : '加入监控'}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(stock, !watched)
      }}
    >
      {watched ? '★ 监控中' : '☆ 监控'}
    </button>
  )
}

/** 模拟买入按钮（点击行不触发） */
function BuyButton({
  stock,
  held,
  onBuy,
}: {
  stock: StockScore
  held: boolean
  onBuy: (s: StockScore) => void
}) {
  return (
    <button
      className={`buy-add-btn ${held ? 'held' : ''}`}
      title={held ? '已加入模拟持仓' : '模拟买入（进入持仓页跟踪）'}
      onClick={(e) => {
        e.stopPropagation()
        onBuy(stock)
      }}
    >
      {held ? '💼 已持仓' : '💼 买入'}
    </button>
  )
}

/** 单只股票的买卖点摘要单元格（含实时买点状态） */
function SignalCell({ sig, price }: { sig: TradingSignalBrief; price?: number }) {
  const rrCls = sig.riskReward >= 1.5 ? 'good' : sig.riskReward >= 0.8 ? 'mid' : 'bad'

  // 实时买点状态（用最新现价 vs 买点区间）
  let status: { label: string; cls: string } | null = null
  if (price !== undefined && Number.isFinite(price)) {
    if (price >= sig.buyLow && price <= sig.buyHigh) {
      status = { label: '✅ 在买点', cls: 'entry-in' }
    } else if (price < sig.buyLow) {
      status = { label: '⚠️ 破支撑', cls: 'entry-below' }
    } else if (price <= sig.buyHigh * 1.03) {
      status = { label: '⏳ 略高', cls: 'entry-near' }
    } else if (price <= sig.buyHigh * 1.08) {
      status = { label: '⏳ 等回踩', cls: 'entry-wait' }
    } else {
      status = { label: '❌ 已涨离', cls: 'entry-high' }
    }
  }

  return (
    <td className="signal-cell">
      <div className="signal-row">
        <span
          className="signal-chip signal-buy"
          title="低吸买点：回踩支撑位买入，现价上方2%内可小幅追入"
        >
          买 {sig.buyLow.toFixed(2)}~{sig.buyHigh.toFixed(2)}
        </span>
        <span className="signal-chip signal-profit" title="止盈目标：前20日高点或+5%">
          盈 {sig.takeProfit.toFixed(2)}
        </span>
        <span className="signal-chip signal-stop" title="止损价：ATR波动率止损，结合支撑位">
          损 {sig.stopLoss.toFixed(2)}
        </span>
      </div>
      <div className="signal-meta-row">
        {status && (
          <span className={`entry-status ${status.cls}`} title="根据最新现价与买点区间实时计算">
            {status.label}
          </span>
        )}
        <span className={`signal-rr score-pill ${rrCls}`}>
          性价比 {sig.riskReward.toFixed(2)}
          {sig.shortMode ? ' · 短线' : ''}
        </span>
      </div>
    </td>
  )
}

export default function ResultTable({ result, onSelect, onBack }: Props) {
  const [sortKey, setSortKey] = useState<SortKey | SortKeyExtra>('pullback')

  // 板块筛选状态
  const [industryFilter, setIndustryFilter] = useState<string>('all')
  const [conceptFilter, setConceptFilter] = useState<string>('all')

  // 行业名称归一化
  const normalizeSector = (name: string): string =>
    name.replace(/[ⅡⅢⅣⅤ]$/u, '').trim()

  // 当前策略的主因子（权重最高的技术因子，如 回踩低吸/平台突破）
  const primaryFactor = useMemo(() => {
    const tech = result.config.factors.filter(
      (f) => f.enabled && f.group === 'technical' && f.key !== 'sector_heat',
    )
    const sorted = [...tech].sort((a, b) => b.weight - a.weight)
    return sorted[0]
      ? { key: sorted[0].key, name: sorted[0].name }
      : { key: 'pullback', name: '回踩形态' }
  }, [result.config.factors])

  useEffect(() => {
    setSortKey(primaryFactor.key)
  }, [primaryFactor.key])

  // 从结果提取可筛选的行业/概念列表
  const industryList = useMemo(() => {
    const set = new Set<string>()
    for (const s of result.scored) {
      if (s.industry) set.add(normalizeSector(s.industry))
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [result.scored])
  const conceptList = useMemo(() => {
    const set = new Set<string>()
    for (const s of result.scored) {
      if (s.concept) {
        for (const c of s.concept.split(',').map((x) => x.trim())) {
          if (c) set.add(c)
        }
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [result.scored])

  // 客户端筛选：行业 + 概念
  const filtered = useMemo(() => {
    const indTarget = industryFilter !== 'all' ? industryFilter : null
    const conTarget = conceptFilter !== 'all' ? conceptFilter : null
    if (!indTarget && !conTarget) return result.scored
    return result.scored.filter((s) => {
      if (indTarget && normalizeSector(s.industry ?? '') !== indTarget) return false
      if (conTarget) {
        const concepts = (s.concept ?? '').split(',').map((c) => c.trim()).filter(Boolean)
        if (!concepts.includes(conTarget)) return false
      }
      return true
    })
  }, [result.scored, industryFilter, conceptFilter])

  // 资金趋势加成：持续流入（moneyflow_5d 分数）作为排序参考
  const moneyBonus = (s: StockScore): number => {
    const v = findScore(s, 'moneyflow_5d')
    if (v === -Infinity) return 0
    // 持续流入(+最高30) / 流出(-最高30)，低吸策略重点参考
    return (v - 50) * 0.6
  }

  // 按主因子排序时，叠加资金趋势加成（持续流入优先，流出靠后）
  const sorted = useMemo(() => {
    if (sortKey === primaryFactor.key) {
      return [...filtered].sort((a, b) => {
        const pa = findScore(a, primaryFactor.key) + moneyBonus(a)
        const pb = findScore(b, primaryFactor.key) + moneyBonus(b)
        return pb - pa
      })
    }
    return sortStocks(filtered, sortKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, primaryFactor.key])

  // 现价/涨跌幅：定时刷新实时行情（默认每 10 秒，可调/可关）
  const [quotes, setQuotes] = useState<Record<string, { price?: number; changePct?: number }>>({})
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [lastQuoteUpdate, setLastQuoteUpdate] = useState<string | null>(null)
  const [refreshInterval, setRefreshInterval] = useState<number>(10) // 秒，0=关闭

  const refreshQuotes = useCallback(async () => {
    if (result.scored.length === 0) return
    setQuoteLoading(true)
    try {
      const list = await fetchRealtimeQuotes(result.scored.map((s) => s.code))
      const map: Record<string, { price?: number; changePct?: number }> = {}
      for (const q of list) {
        map[q.code] = { price: q.price, changePct: q.changePct }
      }
      setQuotes(map)
      setLastQuoteUpdate(new Date().toLocaleTimeString('zh-CN'))
    } catch {
      // 行情拉取失败则保留原样
    } finally {
      setQuoteLoading(false)
    }
  }, [result.scored])

  // 首次加载 + 按设置的间隔自动刷新（默认 10 秒）
  useEffect(() => {
    void refreshQuotes()
    if (refreshInterval <= 0) return
    const timer = setInterval(() => void refreshQuotes(), refreshInterval * 1000)
    return () => clearInterval(timer)
  }, [refreshQuotes, refreshInterval])

  // 监控状态：已加入的股票 code 集合
  const [watchedCodes, setWatchedCodes] = useState<Set<string>>(() => new Set(getWatchlist().map((w) => w.code)))
  useEffect(() => {
    setWatchedCodes(new Set(getWatchlist().map((w) => w.code)))
  }, [])

  // 持仓状态：已模拟买入的 code 集合
  const [heldCodes, setHeldCodes] = useState<Set<string>>(() => new Set(getPositions().map((p) => p.code)))
  useEffect(() => {
    setHeldCodes(new Set(getPositions().map((p) => p.code)))
  }, [])

  const toggleWatch = (s: StockScore, add: boolean) => {
    if (add) {
      addToWatchlist(watchItemFrom(s.code, s.name, { totalScore: s.totalScore }))
    } else {
      removeFromWatchlist(s.code)
    }
    setWatchedCodes(new Set(getWatchlist().map((w) => w.code)))
  }

  const buyStock = (s: StockScore) => {
    const price = s.price ?? quotes[s.code]?.price
    if (price === undefined) {
      alert('暂无实时价格，无法模拟买入')
      return
    }
    // 按现价买入 100 股（1手），默认止损 8%
    addPosition({
      code: s.code,
      name: s.name,
      buyPrice: price,
      shares: 100,
      buyDate: new Date().toISOString().slice(0, 10),
      stopLoss: price * 0.92,
      takeProfit: price * 1.15,
    })
    setHeldCodes(new Set(getPositions().map((p) => p.code)))
    alert(`已模拟买入 ${s.name} 100股 @ ¥${price.toFixed(2)}（可到「💰 持仓」查看）`)
  }

  const displayPrice = (s: StockScore) => {
    const v = s.price ?? quotes[s.code]?.price
    return v !== undefined ? v.toFixed(2) : '—'
  }
  const displayChange = (s: StockScore) => {
    const v = s.changePct ?? quotes[s.code]?.changePct
    return v === undefined ? null : v
  }

  return (
    <div className="result-panel">
      <div className="result-toolbar">
        <div>
          <h2>选股结果</h2>
          <p className="muted">
            扫描 {result.totalScanned} 只，跳过 {result.skipped} 只，入选{' '}
            {result.scored.length} 只
            {lastQuoteUpdate && <span className="update-time"> · 行情 {lastQuoteUpdate}</span>}
          </p>
        </div>
        <div className="toolbar-actions">
          <button
            className="btn"
            onClick={() => void refreshQuotes()}
            disabled={quoteLoading}
            title="手动刷新实时行情"
          >
            {quoteLoading ? '⟳ 刷新中…' : '⟳ 刷新'}
          </button>
          <select
            className="refresh-interval-select"
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            title="自动刷新间隔"
          >
            <option value={10}>每10秒</option>
            <option value={30}>每30秒</option>
            <option value={60}>每60秒</option>
            <option value={0}>不自动</option>
          </select>
          <button className="btn" onClick={() => exportCSV(result)}>
            ⬇ 导出 CSV
          </button>
          <button className="btn" onClick={onBack}>
            ← 返回配置
          </button>
        </div>
      </div>

      {/* 板块筛选 */}
      <div className="result-filter-bar">
        <div className="filter-group">
          <span className="filter-label">🏭 行业：</span>
          <select
            value={industryFilter}
            onChange={(e) => setIndustryFilter(e.target.value)}
          >
            <option value="all">全部（{result.scored.length}）</option>
            {industryList.map((ind) => (
              <option key={ind} value={ind}>{ind}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <span className="filter-label">🧠 概念：</span>
          <select
            value={conceptFilter}
            onChange={(e) => setConceptFilter(e.target.value)}
          >
            <option value="all">全部</option>
            {conceptList.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        {(industryFilter !== 'all' || conceptFilter !== 'all') && (
          <button
            className="filter-clear"
            onClick={() => {
              setIndustryFilter('all')
              setConceptFilter('all')
            }}
          >
            ✕ 清除筛选
          </button>
        )}
        <span className="filter-count">当前显示 {sorted.length} 只</span>
      </div>

      <div className="signal-hint">
        <strong>买卖点说明：</strong>买 = 低吸区间（回踩支撑位买入，现价上方2%内可小幅追入）· 盈 = 止盈目标（前20日高点或+5%）· 损 = 止损价（ATR波动率止损）· 性价比 = 回报÷风险（≥1.5 划算）
      </div>

      <div className="table-stack">
        <div className="table-wrap" style={{ maxHeight: 'none', overflowX: 'auto' }}>
          <table className="result-table">
            <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>板块</th>
              <th>现价</th>
              <th style={{ minWidth: 80 }}>
                <button
                  className={`th-btn${sortKey === 'change' ? ' th-active' : ''}`}
                  onClick={() => setSortKey('change')}
                  title="当日涨跌幅"
                >
                  涨跌幅{sortKey === 'change' && ' ↓'}
                </button>
              </th>
              <th>
                <button
                  className={`th-btn${sortKey === primaryFactor.key ? ' th-active' : ''}`}
                  onClick={() => setSortKey(primaryFactor.key)}
                  title={`${primaryFactor.name}评分（越高越符合策略，默认排序）`}
                >
                  {primaryFactor.name}{sortKey !== 'change' ? ' ↓' : ''}
                </button>
              </th>
              <th title="近5日主力资金趋势（持续流入优先）">资金趋势</th>
              <th className="signal-th">买卖点</th>
            </tr>
            </thead>
            <tbody>
              {sorted.map((s) => {
                const chg = displayChange(s)
                return (
                <tr key={s.code} onClick={() => onSelect(s)}>
                  <td className="code">{s.code}</td>
                  <td className="name">
                    <span className="name-text">{s.name}</span>
                    <WatchButton
                      stock={s}
                      watched={watchedCodes.has(s.code)}
                      onToggle={toggleWatch}
                    />
                    <BuyButton
                      stock={s}
                      held={heldCodes.has(s.code)}
                      onBuy={buyStock}
                    />
                  </td>
                  <td className="sector-cell">
                    {s.industry && <span className="sector-tag">{s.industry}</span>}
                    {s.concept && s.concept.split(',').slice(0, 2).map((c, i) => (
                      <span key={i} className="concept-tag">{c.trim()}</span>
                    ))}
                    {!s.concept && !s.industry && <span className="muted">—</span>}
                  </td>
                  <td className="price">{displayPrice(s)}</td>
                  <td className={pctClass(chg ?? undefined)}>
                    {chg === null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`}
                  </td>
                   <td className="pullback-score-cell" title={`${primaryFactor.name}评分（越高越符合策略）`}>
                     {(() => {
                       const v = findScore(s, primaryFactor.key)
                       if (v === -Infinity) return <span className="muted">—</span>
                       return (
                         <span className={`score-pill ${v >= 70 ? 'good' : v >= 40 ? 'mid' : 'bad'}`}>
                           {v.toFixed(0)}
                         </span>
                       )
                     })()}
                   </td>
                   <td className="money-trend-cell">
                     {(() => {
                       const f = s.factorScores.find((x) => x.key === 'moneyflow_5d')
                       if (!f) return <span className="muted">—</span>
                       const cls = f.score >= 70 ? 'mt-in' : f.score >= 50 ? 'mt-mid' : 'mt-out'
                       const label = f.score >= 70 ? '持续流入' : f.score >= 50 ? '流入' : '流出'
                       return (
                         <span className={`money-trend ${cls}`} title={f.detail}>
                           {label}
                         </span>
                       )
                     })()}
                   </td>
                   {s.signal ? <SignalCell sig={s.signal} price={s.price ?? quotes[s.code]?.price} /> : <td className="signal-cell muted">—</td>}
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
