import { useEffect, useState } from 'react'
import type { DailyPickResult, SelectConfig, StockScore } from '../types'
import { fetchMarketStocks, fetchSectorList, runDailyPick, type PipelineProgress } from '../data/pipeline'
import { STRATEGY_TEMPLATES, applyTemplate } from '../config/factors'
import { computeMarketSentiment, type MarketSentiment } from '../engine/marketSentiment'
import { positionAdvice } from '../engine/positionAdvice'
import { addToWatchlist, watchItemFrom } from '../data/watchlist'
import { recordFromPicks, savePickRecord } from '../data/records'
import StrategyGuideModal from './StrategyGuideModal'
import type { DailyPick } from '../types'

interface Props {
  config: SelectConfig
  onSelect: (stock: StockScore) => void
}

/** 判断当前是否为尾盘时段 */
function tailStatus(): { isTail: boolean; text: string } {
  const now = new Date()
  const h = now.getHours()
  const m = now.getMinutes()
  const isTail = (h === 14 && m >= 30) || (h === 14 && m <= 59) || h === 15
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  if (isTail) {
    return { isTail: true, text: `当前 ${hh}:${mm} · 尾盘时段，数据实时，可收盘前下单` }
  }
  return {
    isTail: false,
    text: `当前 ${hh}:${mm} · 建议尾盘 14:45-14:55 运行，此时数据实时且可下单`,
  }
}

export default function DailyPickPanel({ config, onSelect }: Props) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<PipelineProgress | null>(null)
  const [result, setResult] = useState<DailyPickResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [templateKey, setTemplateKey] = useState('gentle_volume') // 默认轻量资金流
  const [sentiment, setSentiment] = useState<MarketSentiment | null>(null)
  const [sector, setSector] = useState('all') // 板块过滤
  const [sectors, setSectors] = useState<string[]>([])
  const [showGuide, setShowGuide] = useState(false)
  const [requireUptrend, setRequireUptrend] = useState(true) // 温和放量：是否要求上升趋势

  // 加载行业列表（板块下拉）
  useEffect(() => {
    let cancelled = false
    fetchSectorList()
      .then((list) => {
        if (!cancelled) setSectors(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 加载市场情绪（决定今天做不做）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stocks = await fetchMarketStocks()
        if (!cancelled) setSentiment(computeMarketSentiment(stocks))
      } catch {
        // 情绪数据失败不影响主流程
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const activeTemplate =
    STRATEGY_TEMPLATES.find((t) => t.key === templateKey) ?? STRATEGY_TEMPLATES[0]

  const run = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      // 用选中的策略模板覆盖 config + 板块过滤 + 上升趋势开关
      const pickConfig = {
        ...applyTemplate(activeTemplate, config),
        sector,
        requireUptrend,
      }
      const r = await runDailyPick(pickConfig, { onProgress: setProgress, concurrency: 8 })
      setResult(r)
      // 自动把推荐的 4 只票加入监控（含买卖点）+ 存档复盘
      if (r.picks.length > 0) {
        r.picks.forEach((p) =>
          addToWatchlist(
            watchItemFrom(p.code, p.name, {
              buyLow: p.buyLow,
              buyHigh: p.buyHigh,
              takeProfit: p.takeProfit,
              stopLoss: p.stopLoss,
              totalScore: p.totalScore,
            }),
          ),
        )
        savePickRecord(recordFromPicks(new Date().toISOString().slice(0, 10), r.picks))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const status = tailStatus()

  return (
    <div className="config-panel">
      <section className="card">
        <h3>🎯 今日推荐（4 只 + 买卖点）</h3>
        <p className={`tail-hint ${status.isTail ? 'tail-active' : ''}`}>{status.text}</p>

        {/* 市场情绪提示 */}
        {sentiment && (
          <div
            className={`sentiment-strip ${
              sentiment.level === 'hot'
                ? 'level-hot'
                : sentiment.level === 'cold'
                  ? 'level-cold'
                  : 'level-neutral'
            }`}
          >
            <span className="sentiment-icon">
              {sentiment.level === 'hot' ? '🔥' : sentiment.level === 'cold' ? '🧊' : '😐'}
            </span>
            <span>
              情绪 {sentiment.temperature}° · 涨停 {sentiment.limitUpCount} 家 ·{' '}
              {sentiment.advice}
            </span>
            <span className="position-advice-tag">
              {positionAdvice(sentiment.temperature).text}
            </span>
          </div>
        )}

        {/* 策略选择 */}
        <div className="strategy-select">
          <span className="field-label">选股策略：</span>
          {STRATEGY_TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`strategy-chip ${templateKey === t.key ? 'active' : ''}`}
              onClick={() => setTemplateKey(t.key)}
              title={t.desc}
            >
              {t.name}
            </button>
          ))}
          <button
            type="button"
            className="guide-btn"
            onClick={() => setShowGuide(true)}
            title="查看每个策略和因子的详细说明"
          >
            📖 策略说明
          </button>
        </div>

        {/* 板块过滤 */}
        <div className="strategy-select" style={{ marginTop: 8 }}>
          <span className="field-label">板块：</span>
          <select
            className="sector-dropdown"
            value={sector}
            onChange={(e) => setSector(e.target.value)}
          >
            <option value="all">🌐 全部板块</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {/* 温和放量：上升趋势开关（同花顺风格宽松放量可选） */}
        {templateKey === 'gentle_volume' && (
          <div className="strategy-select" style={{ marginTop: 8 }}>
            <label className="uptrend-toggle">
              <input
                type="checkbox"
                checked={requireUptrend}
                onChange={(e) => setRequireUptrend(e.target.checked)}
              />
              要求上升趋势（MA20&gt;MA60 + 站上MA20 + MA20拐头）— 关闭后为同花顺式宽松放量
            </label>
          </div>
        )}

        <p className="muted" style={{ margin: '8px 0 12px' }}>
          {activeTemplate.desc}。打分选 Top 4（行业分散），基于均线/前期高低点给出买入区间、止盈、止损。买卖点仅供参考，不构成投资建议。
        </p>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={() => void run()} disabled={running}>
            {running ? '生成中…' : '🚀 生成今日推荐'}
          </button>
        </div>
      </section>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {running && progress && (
        <div className="progress-bar-wrap">
          <div className="progress-label">
            <span>{progress.message}</span>
            <span>{progress.total > 0 ? `${progress.done}/${progress.total}` : ''}</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 30}%`,
              }}
            />
          </div>
        </div>
      )}

      {result && (
        <>
          <div className="pick-summary muted">
            生成时间：{new Date(result.computedAt).toLocaleTimeString('zh-CN')} · 共{' '}
            {result.picks.length} 只
          </div>
          {result.gateReason && result.picks.length > 0 && (
            <div className="pick-summary muted">筛选说明：{result.gateReason}</div>
          )}
          <div className="pick-grid">
            {result.picks.map((p, i) => (
              <PickCard key={p.code} pick={p} rank={i + 1} onSelect={onSelect} />
            ))}
          </div>
          {result.picks.length === 0 && (
            <div className="error-banner">
              ⚠️ {result.gateReason ?? '未选出符合条件的股票，请稍后重试'}
            </div>
          )}
        </>
      )}

      {showGuide && <StrategyGuideModal onClose={() => setShowGuide(false)} />}
    </div>
  )
}

/** 单只推荐卡片 */
function PickCard({
  pick,
  rank,
  onSelect,
}: {
  pick: DailyPick
  rank: number
  onSelect: (s: StockScore) => void
}) {
  const changeCls = (pick.changePct ?? 0) >= 0 ? 'up' : 'down'
  const rrCls = pick.riskReward >= 1.5 ? 'good' : pick.riskReward >= 0.8 ? 'mid' : 'bad'
  const rrText =
    pick.riskReward >= 2
      ? '性价比优'
      : pick.riskReward >= 1
        ? '性价比适中'
        : '性价比偏低'

  return (
    <div
      className="pick-card"
      onClick={() =>
        onSelect({
          code: pick.code,
          name: pick.name,
          market: pick.market,
          industry: pick.industry,
          totalScore: pick.totalScore,
          price: pick.price,
          changePct: pick.changePct,
          factorScores: pick.factorScores,
        })
      }
    >
      <div className="pick-card-head">
        <span className="pick-rank">#{rank}</span>
        <div className="pick-title">
          <span className="pick-name">{pick.name}</span>
          <span className="pick-code">{pick.code}</span>
          {pick.concept && <span className="pick-concept">{pick.concept}</span>}
          {pick.industry && <span className="pick-industry">{pick.industry}</span>}
          {pick.oneWord && <span className="one-word-badge">⚠️ 一字板买不进</span>}
          {pick.highRisk && <span className="one-word-badge">🔴 高位风险</span>}
        </div>
        <div className="pick-price">
          <div className="pick-price-val">¥{pick.price?.toFixed(2)}</div>
          <div className={`pick-change ${changeCls}`}>
            {pick.changePct !== undefined
              ? `${pick.changePct >= 0 ? '+' : ''}${pick.changePct.toFixed(2)}%`
              : '—'}
          </div>
        </div>
      </div>

      <div className="pick-score-row">
        <span className="pick-score-label">综合评分</span>
        <strong className="pick-score-val">{pick.totalScore.toFixed(1)}</strong>
        <span className={`score-pill ${rrCls}`}>风险回报 {pick.riskReward} · {rrText}</span>
      </div>

      <div className="price-targets">
        <div className="target target-buy">
          <span className="target-label">买入区间</span>
          <span className="target-val">
            {pick.buyLow.toFixed(2)} ~ {pick.buyHigh.toFixed(2)}
          </span>
        </div>
        <div className="target target-profit">
          <span className="target-label">止盈目标</span>
          <span className="target-val">{pick.takeProfit.toFixed(2)}</span>
        </div>
        <div className="target target-stop">
          <span className="target-label">止损价</span>
          <span className="target-val">{pick.stopLoss.toFixed(2)}</span>
        </div>
      </div>

      <ul className="pick-reasons">
        {pick.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>

      <div className="pick-factor-tags">
        {pick.factorScores
          .filter((f) => f.score >= 60)
          .slice(0, 4)
          .map((f) => (
            <span key={f.key} className="factor-tag">
              {f.name} {f.score.toFixed(0)}
            </span>
          ))}
      </div>
    </div>
  )
}
