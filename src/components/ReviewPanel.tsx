import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Kline, StockScore } from '../types'
import { fetchKline, fetchRealtimeQuotes, marketOfCode, type Quote } from '../data/api'
import { klineCache } from '../data/cache'
import { getPickRecords, type PickRecord } from '../data/records'
import { getTrades, type TradeRecord } from '../data/trades'
import { settlePick, type SettleResult } from '../engine/settle'
import { computeStrategyStats, type StrategyStats } from '../engine/strategyStats'

interface Props {
  onSelect: (stock: StockScore) => void
}

/** 简单并发池：拉 K 线用 */
async function mapLimit<T>(
  items: T[],
  concurrent: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrent, items.length) }, () => run()))
}

/**
 * 复盘面板：历史推荐表现统计。
 * 两种口径并存：
 *  - 实时口径：推荐价 → 今天现价（简单快照）
 *  - 规则结算口径：推荐日次日起 N 个交易日内，先触止盈按止盈结算、先触止损按止损结算、都没触按窗口末收盘结算
 */
export default function ReviewPanel({ onSelect }: Props) {
  const [records] = useState<PickRecord[]>(() => getPickRecords())
  const [trades] = useState<TradeRecord[]>(() => getTrades())
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map())
  const [settled, setSettled] = useState<Map<string, SettleResult>>(new Map())
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    const recs = getPickRecords()
    if (recs.length === 0) return
    setLoading(true)
    const codes = recs.flatMap((r) => r.picks.map((p) => p.code))
    try {
      // 实时价（实时口径）
      const qs = await fetchRealtimeQuotes(codes)
      setQuotes(new Map(qs.map((q) => [q.code, q])))
    } catch {
      // 实时价失败不影响结算
    }
    // 拉 K 线并结算（并发 6 路，klineCache 吸收重复请求）
    const uniqueCodes = [...new Set(codes)]
    const klineByCode = new Map<string, Kline[]>()
    await mapLimit(uniqueCodes, 6, async (code) => {
      let kl = await klineCache.get(code)
      if (!kl) {
        try {
          kl = await fetchKline(marketOfCode(code), code, 160)
        } catch {
          kl = []
        }
        if (kl.length > 0) await klineCache.set(code, kl)
      }
      if (kl.length > 0) klineByCode.set(code, kl)
    })
    const map = new Map<string, SettleResult>()
    for (const r of recs) {
      for (const p of r.picks) {
        const kl = klineByCode.get(p.code)
        if (!kl) continue
        map.set(
          `${r.date}:${p.code}`,
          settlePick({
            entryPrice: p.price,
            stopLoss: p.stopLoss,
            takeProfit: p.takeProfit,
            recommendDate: r.date,
            klines: kl,
          }),
        )
      }
    }
    setSettled(map)
    setLoading(false)
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

  // ---- 实时口径汇总 ----
  let total = 0
  let wins = 0
  let sumPct = 0
  for (const r of records) {
    for (const p of r.picks) {
      const q = quotes.get(p.code)
      if (q?.price === undefined) continue
      const pct = q.price / p.price - 1
      total++
      sumPct += pct
      if (pct > 0) wins++
    }
  }
  const winRate = total > 0 ? (wins / total) * 100 : 0
  const avgPct = total > 0 ? (sumPct / total) * 100 : 0

  // ---- 规则结算口径汇总（排除 pending） ----
  let settledTotal = 0
  let tpCount = 0
  let slCount = 0
  let profitCount = 0
  let sumSettledPct = 0
  for (const [, s] of settled) {
    if (s.pct === null || s.status === 'pending') continue
    settledTotal++
    sumSettledPct += s.pct
    if (s.pct > 0) profitCount++
    if (s.status === 'take_profit') tpCount++
    else if (s.status === 'stop_loss') slCount++
  }
  const tpRate = settledTotal > 0 ? (tpCount / settledTotal) * 100 : 0
  const slRate = settledTotal > 0 ? (slCount / settledTotal) * 100 : 0
  const profitRate = settledTotal > 0 ? (profitCount / settledTotal) * 100 : 0
  const avgSettledPct = settledTotal > 0 ? sumSettledPct / settledTotal : 0

  // 按策略模板聚合表现
  const strategyStats: StrategyStats[] = useMemo(
    () => computeStrategyStats(records, settled),
    [records, settled],
  )
  const bestStrategy = strategyStats.find(
    (s) => !s.legacy && s.sampleCount >= 3 && s.sampleCount > 0,
  )

  // 最近两次推荐（按日期降序前 2 条）
  const recentRecords = [...records].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 2)

  return (
    <div className="config-panel">
      <section className="card">
        <div className="watch-header">
          <h3 style={{ margin: 0 }}>📋 推荐复盘（{records.length} 天记录）</h3>
          <button className="btn btn-sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '🔄 刷新'}
          </button>
        </div>

        {/* 实时口径 */}
        <h4 className="settle-group-title">实时口径（推荐价 → 今天现价）</h4>
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
        </div>

        {/* 规则结算口径 */}
        <h4 className="settle-group-title">规则结算口径（推荐次日起 N 个交易日内先到先结算）</h4>
        <div className="metric-grid">
          <div className="metric-card">
            <span className="metric-label">已结算样本</span>
            <span className="metric-value">{settledTotal}</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">按规则止盈触发率</span>
            <span className={`metric-value ${tpRate >= 50 ? 'up' : ''}`}>
              {settledTotal > 0 ? tpRate.toFixed(0) : '—'}%
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">按规则止损触发率</span>
            <span className={`metric-value ${slRate > 0 ? 'down' : ''}`}>
              {settledTotal > 0 ? slRate.toFixed(0) : '—'}%
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">窗口内获利胜率</span>
            <span className={`metric-value ${profitRate >= 50 ? 'up' : 'down'}`}>
              {settledTotal > 0 ? profitRate.toFixed(0) : '—'}%
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">平均结算收益</span>
            <span className={`metric-value ${avgSettledPct >= 0 ? 'up' : 'down'}`}>
              {settledTotal > 0 ? `${avgSettledPct > 0 ? '+' : ''}${avgSettledPct.toFixed(2)}%` : '—'}
            </span>
          </div>
        </div>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
          规则口径模拟"按推荐规则执行"：止盈/止损触发即按对应价位结算，窗口（5 个交易日）结束未触发按收盘价持有结算。
          ⏳待结算 = 窗口尚未走完。
        </p>

        {/* 策略表现追踪 */}
        <h4 className="settle-group-title">策略表现追踪（哪个模板真实表现好）</h4>
        {strategyStats.length === 0 ? (
          <p className="muted" style={{ fontSize: 12 }}>
            暂无已结算的策略样本。多生成几次今日推荐、并积累几天后这里会按策略模板显示表现对比。
          </p>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 'none' }}>
            <table className="result-table strategy-stats">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>策略</th>
                  <th>已结算</th>
                  <th>止盈触发率</th>
                  <th>止损触发率</th>
                  <th>获利胜率</th>
                  <th>平均收益</th>
                </tr>
              </thead>
              <tbody>
                {strategyStats.map((s) => (
                  <tr
                    key={s.key}
                    className={`${s.legacy ? 'strategy-legacy' : ''} ${
                      bestStrategy?.key === s.key ? 'strategy-best' : ''
                    }`}
                  >
                    <td style={{ textAlign: 'left' }}>
                      {s.name}
                      {!s.legacy && s.sampleCount > 0 && s.sampleCount < 3 && (
                        <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                          样本不足
                        </span>
                      )}
                    </td>
                    <td>{s.sampleCount}</td>
                    <td className={s.tpRate >= 50 ? 'up' : ''}>{s.tpRate.toFixed(0)}%</td>
                    <td className={s.slRate > 0 ? 'down' : ''}>{s.slRate.toFixed(0)}%</td>
                    <td className={s.profitRate >= 50 ? 'up' : 'down'}>
                      {s.profitRate.toFixed(0)}%
                    </td>
                    <td className={s.avgPct >= 0 ? 'up' : 'down'}>
                      {s.avgPct > 0 ? '+' : ''}
                      {s.avgPct.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {bestStrategy && (
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            ✅ 当前表现最好：<b>{bestStrategy.name}</b>（平均收益 {bestStrategy.avgPct.toFixed(2)}%，
            {bestStrategy.sampleCount} 个已结算样本）。样本越多越可信，固定用它观察 2-3 周再下结论。
          </p>
        )}
      </section>

      {/* 最近两次推荐对比 */}
      {recentRecords.length >= 2 && (
        <section className="card">
          <h3 style={{ margin: '0 0 10px' }}>🆚 最近两次推荐对比</h3>
          <div className="compare-grid">
            {recentRecords.map((r) => (
              <div key={r.date} className="compare-col">
                <div className="compare-head">
                  <b>{r.date}</b>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {r.strategy?.name ?? '未记录策略'}
                  </span>
                </div>
                {r.picks.map((p) => {
                  const s = settled.get(`${r.date}:${p.code}`)
                  return (
                    <div key={p.code} className="compare-pick">
                      <span className="compare-name">{p.name}</span>
                      <span className="muted" style={{ fontSize: 11 }}>
                        {p.code}
                      </span>
                      <span className="muted" style={{ fontSize: 11 }}>
                        评分 {p.totalScore.toFixed(1)}
                      </span>
                      <span className="compare-status">
                        {!s
                          ? '—'
                          : s.status === 'take_profit'
                            ? '🔵 止盈'
                            : s.status === 'stop_loss'
                              ? '🔴 止损'
                              : s.status === 'holding'
                                ? '⚪ 持有'
                                : '⏳ 待结算'}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </section>
      )}

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
                  <th>实时价</th>
                  <th>实时涨跌</th>
                  <th style={{ textAlign: 'left' }}>结算结果</th>
                  <th>结算收益</th>
                </tr>
              </thead>
              <tbody>
                {r.picks.map((p) => {
                  const q = quotes.get(p.code)
                  const price = q?.price
                  const pct = price !== undefined ? (price / p.price - 1) * 100 : null
                  const s = settled.get(`${r.date}:${p.code}`)
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
                      <td style={{ textAlign: 'left', fontSize: 12 }}>
                        {!s ? (
                          <span className="score-pill mid">—</span>
                        ) : s.status === 'take_profit' ? (
                          <span className="score-pill good" title={`${s.exitDate} 触及止盈`}>
                            🔵 止盈 @{s.exitDate}
                          </span>
                        ) : s.status === 'stop_loss' ? (
                          <span className="score-pill bad" title={`${s.exitDate} 触及止损`}>
                            🔴 止损 @{s.exitDate}
                          </span>
                        ) : s.status === 'holding' ? (
                          <span className="score-pill mid" title={`窗口末 ${s.exitDate} 收盘`}>
                            ⚪ 持有(窗口末)
                          </span>
                        ) : (
                          <span
                            className="score-pill mid"
                            title="观察窗口（5 个交易日）尚未走完，走完后自动出结果"
                          >
                            ⏳ 待结算（{s.barsUsed}/{s.windowDays} 交易日）
                          </span>
                        )}
                      </td>
                      <td className={s?.pct !== null && (s?.pct ?? 0) >= 0 ? 'up' : 'down'}>
                        {s?.pct !== null && s?.pct !== undefined
                          ? `${s.pct > 0 ? '+' : ''}${s.pct.toFixed(2)}%`
                          : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {/* 手动交易复盘（模拟持仓卖出沉淀） */}
      {trades.length > 0 && (
        <section className="card" style={{ marginTop: 14 }}>
          <div className="watch-header">
            <h3 style={{ margin: 0 }}>💼 手动交易复盘（{trades.length} 笔已卖出）</h3>
          </div>
          {(() => {
            let winCount = 0
            let sumPct = 0
            let sumPnl = 0
            for (const t of trades) {
              if (t.pnl > 0) winCount++
              sumPct += t.pnlPct
              sumPnl += t.pnl
            }
            const winRate = trades.length > 0 ? (winCount / trades.length) * 100 : 0
            return (
              <div className="metric-grid">
                <div className="metric-card">
                  <span className="metric-label">胜率</span>
                  <span className="metric-value">{winRate.toFixed(1)}%</span>
                </div>
                <div className="metric-card">
                  <span className="metric-label">累计盈亏</span>
                  <span className={`metric-value ${sumPnl >= 0 ? 'up' : 'down'}`}>
                    {sumPnl >= 0 ? '+' : ''}¥{sumPnl.toFixed(0)}
                  </span>
                </div>
                <div className="metric-card">
                  <span className="metric-label">平均盈亏率</span>
                  <span className={`metric-value ${sumPct >= 0 ? 'up' : 'down'}`}>
                    {sumPct >= 0 ? '+' : ''}{sumPct.toFixed(2)}%
                  </span>
                </div>
              </div>
            )
          })()}
          <div className="table-wrap" style={{ maxHeight: 'none', marginTop: 10 }}>
            <table className="result-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>代码</th>
                  <th style={{ textAlign: 'left' }}>名称</th>
                  <th>买入日</th>
                  <th>卖出日</th>
                  <th>买入价</th>
                  <th>卖出价</th>
                  <th>股数</th>
                  <th>盈亏</th>
                  <th>盈亏率</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={i}>
                    <td className="code">{t.code}</td>
                    <td className="name" style={{ textAlign: 'left' }}>{t.name}</td>
                    <td>{t.buyDate}</td>
                    <td>{t.sellDate}</td>
                    <td>{t.buyPrice.toFixed(2)}</td>
                    <td>{t.sellPrice.toFixed(2)}</td>
                    <td>{t.shares}</td>
                    <td className={t.pnl >= 0 ? 'up' : 'down'}>
                      {t.pnl >= 0 ? '+' : ''}¥{t.pnl.toFixed(0)}
                    </td>
                    <td className={t.pnlPct >= 0 ? 'up' : 'down'}>
                      {t.pnlPct > 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%
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
