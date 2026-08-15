import { useEffect, useState } from 'react'
import type { FactorDef, SelectConfig } from '../types'
import { DEFAULT_FACTORS, STRATEGY_TEMPLATES, applyTemplate } from '../config/factors'
import { fetchSectorList } from '../data/pipeline'
import StrategyGuideModal from './StrategyGuideModal'

interface Props {
  config: SelectConfig
  onChange: (config: SelectConfig) => void
  onStart: () => void
  disabled: boolean
}

const POOL_LABELS: Record<SelectConfig['pool'], string> = {
  all: '全部A股',
  hs300: '沪深300',
  zz500: '中证500',
}

const POOL_HINTS: Record<SelectConfig['pool'], string> = {
  all: '沪深全市场约 5500 只',
  hs300: '沪深300 成分股 300 只',
  zz500: '中证500 成分股 500 只',
}

const CANDIDATE_LABELS: Record<SelectConfig['candidatePool'], string> = {
  momentum: '今日涨幅（动量）',
  turnover: '换手率（资金活跃）',
  liquid: '流通市值（流动性）',
  marketcap: '总市值（规模）',
}

/** 更新单个因子 */
function updateFactor(
  config: SelectConfig,
  key: string,
  patch: Partial<FactorDef>,
): SelectConfig {
  return {
    ...config,
    factors: config.factors.map((f) => (f.key === key ? { ...f, ...patch } : f)),
  }
}

export default function ConfigPanel({ config, onChange, onStart, disabled }: Props) {
  const [sectors, setSectors] = useState<string[]>([])
  const [showGuide, setShowGuide] = useState(false)

  // 加载行业列表（供板块下拉）
  useEffect(() => {
    let cancelled = false
    fetchSectorList()
      .then((list) => {
        if (!cancelled) setSectors(list)
      })
      .catch(() => {
        // 加载失败静默，下拉只有"全部板块"
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="config-panel">
      {/* 策略模板 */}
      <section className="card">
        <div className="watch-header">
          <h3 style={{ margin: 0 }}>⚡ 策略模板（一键应用预设权重）</h3>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowGuide(true)}
          >
            📖 策略说明
          </button>
        </div>
        <div className="template-list">
          {STRATEGY_TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              className="template-btn"
              onClick={() => onChange(applyTemplate(t, config))}
              title={t.desc}
            >
              <span className="template-name">{t.name}</span>
              <span className="template-desc">{t.desc}</span>
            </button>
          ))}
          <button
            type="button"
            className="template-btn template-btn-ic"
            onClick={() => {
              try {
                const saved = localStorage.getItem('ic-optimized-factors')
                if (saved) {
                  const factors = JSON.parse(saved) as SelectConfig['factors']
                  if (Array.isArray(factors) && factors.length > 0) {
                    onChange({ ...config, factors })
                    return
                  }
                }
              } catch {
                // 解析失败走下面的提示
              }
              alert('暂无 IC 优化结果。请先到「因子分析」页运行分析并点击"应用这些权重"。')
            }}
            title="应用因子分析页生成的 IC 优化权重（需先跑一次因子分析并应用）"
          >
            <span className="template-name">🧬 IC 优化权重</span>
            <span className="template-desc">应用因子分析页按 IC 自动生成的权重（先跑因子分析）</span>
          </button>
        </div>
      </section>

      {/* 股票池 */}
      <section className="card">
        <h3>① 股票池</h3>
        <div className="pool-options">
          {(Object.keys(POOL_LABELS) as SelectConfig['pool'][]).map((p) => (
            <label
              key={p}
              className={`pool-option ${config.pool === p ? 'active' : ''}`}
            >
              <input
                type="radio"
                name="pool"
                checked={config.pool === p}
                onChange={() => onChange({ ...config, pool: p })}
              />
              <div>
                <span className="pool-name">{POOL_LABELS[p]}</span>
                <span className="pool-hint">{POOL_HINTS[p]}</span>
              </div>
            </label>
          ))}
        </div>

        {/* 板块过滤 */}
        <div className="sector-select" style={{ marginTop: 12 }}>
          <label className="field">
            <span className="field-label">板块过滤</span>
            <select
              value={config.sector}
              onChange={(e) => onChange({ ...config, sector: e.target.value })}
            >
              <option value="all">🌐 全部板块</option>
              {sectors.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* 因子权重 */}
      <section className="card">
        <h3>② 因子权重（拖动调整，可实时重算排序）</h3>
        <div className="factor-list">
          {config.factors.map((f) => {
            const enabledCount = config.factors.filter((x) => x.enabled).length
            return (
              <div key={f.key} className="factor-row">
                <label className="factor-toggle">
                  <input
                    type="checkbox"
                    checked={f.enabled}
                    onChange={(e) =>
                      onChange(updateFactor(config, f.key, { enabled: e.target.checked }))
                    }
                  />
                  <span>{f.name}</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(f.weight * 100)}
                  disabled={!f.enabled}
                  onChange={(e) =>
                    onChange(
                      updateFactor(config, f.key, {
                        weight: Number(e.target.value) / 100,
                      }),
                    )
                  }
                />
                <span className="weight-pct">
                  {f.enabled ? `${Math.round(f.weight * 100)}%` : '—'}
                </span>
                <span className="factor-desc">{f.desc}</span>
                <span className="factor-share">
                  {enabledCount > 0
                    ? `参与权重 ${(
                        (f.weight /
                          config.factors
                            .filter((x) => x.enabled)
                            .reduce((s, x) => s + x.weight, 0)) *
                        100
                      ).toFixed(0)}%`
                    : ''}
                </span>
              </div>
            )
          })}
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            onClick={() => onChange({ ...config, factors: DEFAULT_FACTORS.map((f) => ({ ...f })) })}
          >
            重置默认权重
          </button>
        </div>
      </section>

      {/* 候选池与过滤 */}
      <section className="card">
        <h3>③ 候选池与过滤条件</h3>
        <div className="filter-grid">
          <label className="field">
            <span className="field-label">候选池筛选</span>
            <select
              value={config.candidatePool}
              onChange={(e) =>
                onChange({
                  ...config,
                  candidatePool: e.target.value as SelectConfig['candidatePool'],
                })
              }
            >
              {(Object.keys(CANDIDATE_LABELS) as SelectConfig['candidatePool'][]).map(
                (k) => (
                  <option key={k} value={k}>
                    {CANDIDATE_LABELS[k]}
                  </option>
                ),
              )}
            </select>
          </label>

          <label className="field">
            <span className="field-label">候选数量（拉K线数）</span>
            <input
              type="number"
              min={20}
              max={1000}
              step={10}
              value={config.candidateCount}
              onChange={(e) =>
                onChange({
                  ...config,
                  candidateCount: Math.max(20, Number(e.target.value) || 200),
                })
              }
            />
          </label>

          <label className="field">
            <span className="field-label">最小总市值（亿元）</span>
            <input
              type="number"
              min={0}
              step={10}
              value={config.minMvYiyi}
              onChange={(e) =>
                onChange({
                  ...config,
                  minMvYiyi: Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
          </label>

          <label className="field checkbox-field">
            <input
              type="checkbox"
              checked={config.excludeST}
              onChange={(e) => onChange({ ...config, excludeST: e.target.checked })}
            />
            <span>排除 ST / 退市风险股</span>
          </label>

          <label className="field checkbox-field">
            <input
              type="checkbox"
              checked={config.excludeKcb}
              onChange={(e) => onChange({ ...config, excludeKcb: e.target.checked })}
            />
            <span>排除科创板（688）</span>
          </label>

          <label className="field checkbox-field">
            <input
              type="checkbox"
              checked={config.excludeCyb}
              onChange={(e) => onChange({ ...config, excludeCyb: e.target.checked })}
            />
            <span>排除创业板（300/301）</span>
          </label>

          <label className="field checkbox-field">
            <input
              type="checkbox"
              checked={config.diversify}
              onChange={(e) => onChange({ ...config, diversify: e.target.checked })}
            />
            <span>行业分散（避免结果集中在少数行业）</span>
          </label>

          <label className="field">
            <span className="field-label">每行业上限（只）</span>
            <input
              type="number"
              min={1}
              max={10}
              value={config.maxPerIndustry}
              disabled={!config.diversify}
              onChange={(e) =>
                onChange({
                  ...config,
                  maxPerIndustry: Math.max(1, Math.min(10, Number(e.target.value) || 3)),
                })
              }
            />
          </label>
        </div>
      </section>

      <button
        className="btn btn-primary start-btn"
        onClick={onStart}
        disabled={disabled}
      >
        {disabled ? '选股进行中…' : '🚀 开始选股'}
      </button>

      {showGuide && <StrategyGuideModal onClose={() => setShowGuide(false)} />}
    </div>
  )
}
