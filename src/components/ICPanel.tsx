import { useMemo, useState } from 'react'
import type { FactorDef, SelectConfig } from '../types'
import { loadKlineStocks } from '../data/pipeline'
import { computeFactorICs, computeFactorCorrelation, type FactorIC } from '../engine/icAnalysis'
import { optimizeWeightsFromIC, type WeightSuggestion } from '../engine/weightOptimizer'
import { useECharts } from './charts/useECharts'
import type * as echarts from 'echarts'

interface Props {
  config: SelectConfig
  onApplyWeights: (factors: FactorDef[]) => void
}

const POOL_LABELS: Record<string, string> = {
  all: '全部A股',
  hs300: '沪深300',
  zz500: '中证500',
}

export default function ICPanel({ config, onApplyWeights }: Props) {
  const [count, setCount] = useState(80)
  const [forwardDays, setForwardDays] = useState(5)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string>('')
  const [factors, setFactors] = useState<FactorIC[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setRunning(true)
    setError(null)
    setFactors(null)
    try {
      const stocks = await loadKlineStocks(
        { ...config, candidateCount: count },
        { onProgress: (d, t) => setProgress(`拉取K线 ${d}/${t}…`) },
      )
      if (stocks.length < 20) {
        throw new Error('有效股票不足 20 只，请增大样本数')
      }
      setProgress(`计算 ${stocks.length} 只股票的因子 IC…`)
      const res = computeFactorICs(stocks, forwardDays, 10)
      setFactors(res)
      setProgress('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="config-panel">
      <section className="card">
        <h3>🔬 因子有效性分析（IC / IR）</h3>
        <p className="muted" style={{ margin: '0 0 12px' }}>
          衡量每个因子对"未来 {forwardDays} 日收益"的预测能力。IC 为正且稳定（IR 高）的因子更有效。
        </p>
        <div className="filter-grid">
          <label className="field">
            <span className="field-label">样本股票数</span>
            <input
              type="number"
              min={30}
              max={500}
              step={10}
              value={count}
              onChange={(e) => setCount(Math.max(30, Number(e.target.value) || 80))}
            />
          </label>
          <label className="field">
            <span className="field-label">预测窗口（未来 N 日收益）</span>
            <input
              type="number"
              min={1}
              max={20}
              value={forwardDays}
              onChange={(e) => setForwardDays(Math.max(1, Number(e.target.value) || 5))}
            />
          </label>
          <div className="field checkbox-field">
            <span className="field-label">股票池：{POOL_LABELS[config.pool]}</span>
          </div>
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={() => void run()} disabled={running}>
            {running ? `分析中… ${progress}` : '▶ 运行因子分析'}
          </button>
        </div>
      </section>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {factors && (
        <ICResults
          factors={factors}
          forwardDays={forwardDays}
          factorDefs={config.factors}
          onApplyWeights={onApplyWeights}
        />
      )}
    </div>
  )
}

/** 因子 IC 结果展示：柱状图 + 累计 IC 曲线 + 统计表 + 权重优化建议 */
function ICResults({
  factors,
  forwardDays,
  factorDefs,
  onApplyWeights,
}: {
  factors: FactorIC[]
  forwardDays: number
  factorDefs: FactorDef[]
  onApplyWeights: (factors: FactorDef[]) => void
}) {
  const [suggestion, setSuggestion] = useState<{ suggestions: WeightSuggestion[]; factors: FactorDef[] } | null>(null)
  const [applied, setApplied] = useState(false)
  const sorted = useMemo(
    () => [...factors].sort((a, b) => Math.abs(b.meanIC) - Math.abs(a.meanIC)),
    [factors],
  )

  // IC 均值柱状图
  const barOption: echarts.EChartsOption = useMemo(
    () => ({
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 50, right: 20, top: 20, bottom: 60 },
      xAxis: {
        type: 'category',
        data: sorted.map((f) => f.name),
        axisLabel: { rotate: 30, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        min: (v: { min: number; max: number }) => Math.min(-0.3, v.min - 0.05),
        max: (v: { min: number; max: number }) => Math.max(0.3, v.max + 0.05),
        axisLabel: { formatter: '{value}' },
      },
      series: [
        {
          type: 'bar',
          data: sorted.map((f) => ({
            value: Number(f.meanIC.toFixed(3)),
            itemStyle: {
              color:
                f.meanIC > 0.02 ? '#2f9e44' : f.meanIC < -0.02 ? '#e03131' : '#fab005',
            },
          })),
          label: { show: true, position: 'top', fontSize: 10 },
        },
      ],
    }),
    [sorted],
  )
  const barRef = useECharts(barOption, [barOption])

  // 累计 IC 曲线（取 IC 最强的前 4 个因子）
  const top4 = sorted.slice(0, 4)
  const cumLineOption: echarts.EChartsOption = useMemo(() => {
    return {
      animation: false,
      tooltip: { trigger: 'axis' },
      legend: { top: 0, type: 'scroll' },
      grid: { left: 50, right: 20, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: top4[0]?.dates ?? [] },
      yAxis: { type: 'value', name: '累计IC' },
      series: top4.map((f) => {
        let cum = 0
        const data = f.icSeries.map((v) => {
          cum += v
          return Number(cum.toFixed(4))
        })
        return {
          name: f.name,
          type: 'line',
          showSymbol: false,
          data,
          lineStyle: { width: 1.5 },
        }
      }),
    }
  }, [top4])
  const cumRef = useECharts(cumLineOption, [cumLineOption])

  const generateSuggestion = () => {
    const corr = computeFactorCorrelation(factors)
    const result = optimizeWeightsFromIC(factors, factorDefs, corr)
    setSuggestion(result)
    setApplied(false)
  }

  return (
    <>
      <section className="card">
        <h3>各因子平均 IC（预测未来 {forwardDays} 日收益）</h3>
        <div ref={barRef} style={{ width: '100%', height: 280 }} />
      </section>

      <section className="card">
        <h3>最强因子累计 IC 曲线</h3>
        <div ref={cumRef} style={{ width: '100%', height: 320 }} />
      </section>

      <section className="card">
        <h3>因子统计明细</h3>
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="result-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>因子</th>
                <th>平均 IC</th>
                <th>IC 标准差</th>
                <th>IR</th>
                <th>t 值</th>
                <th>IC&gt;0 胜率</th>
                <th>评级</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((f) => {
                const grade =
                  Math.abs(f.meanIC) > 0.04 && Math.abs(f.ir) > 0.3
                    ? '⭐ 强'
                    : Math.abs(f.meanIC) > 0.02 && Math.abs(f.ir) > 0.15
                      ? '✔ 有效'
                      : Math.abs(f.meanIC) > 0.01
                        ? '· 弱'
                        : '✖ 无效'
                return (
                  <tr key={f.key}>
                    <td className="name" style={{ textAlign: 'left' }}>{f.name}</td>
                    <td className={f.meanIC > 0 ? 'up' : 'down'}>
                      {f.meanIC.toFixed(3)}
                    </td>
                    <td>{f.stdIC.toFixed(3)}</td>
                    <td className={f.ir > 0 ? 'up' : 'down'}>{f.ir.toFixed(2)}</td>
                    <td>{f.tStat.toFixed(2)}</td>
                    <td>{(f.winRate * 100).toFixed(0)}%</td>
                    <td>{grade}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3>🧬 IC 驱动权重优化</h3>
        <p className="muted" style={{ margin: '0 0 12px' }}>
          基于上面 IC 分析结果自动生成因子权重：IC 越强越稳定 → 权重越高；显著负 IC /
          不稳定的因子降权或禁用。替代人工"拍脑袋"权重。技术因子被优化，基本面/资金流因子保留原配置。
        </p>
        {!suggestion ? (
          <div className="btn-row">
            <button className="btn btn-primary" onClick={generateSuggestion}>
              📊 基于 IC 生成权重建议
            </button>
          </div>
        ) : (
          <>
            {applied && (
              <div
                style={{
                  background: 'rgba(47, 158, 68, 0.12)',
                  border: '1px solid rgba(47, 158, 68, 0.4)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  margin: '0 0 12px',
                  fontSize: 13,
                }}
              >
                ✅ 权重已应用，可切到「选股 / 今日推荐」页查看效果。
              </div>
            )}
            <div className="table-wrap" style={{ maxHeight: 'none' }}>
              <table className="result-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>因子</th>
                    <th>平均 IC</th>
                    <th>当前权重</th>
                    <th>建议权重</th>
                    <th>变化</th>
                    <th style={{ textAlign: 'left' }}>理由</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestion.suggestions.map((s) => {
                    const delta = s.suggestedWeight - s.currentWeight
                    return (
                      <tr key={s.key}>
                        <td className="name" style={{ textAlign: 'left' }}>{s.name}</td>
                        <td>
                          {s.meanIC === null ? '—' : (
                            <span className={s.meanIC > 0 ? 'up' : 'down'}>
                              {s.meanIC.toFixed(3)}
                            </span>
                          )}
                        </td>
                        <td>{(s.currentWeight * 100).toFixed(0)}%</td>
                        <td>
                          {s.disabled ? (
                            <span className="down">禁用</span>
                          ) : (
                            (s.suggestedWeight * 100).toFixed(0) + '%'
                          )}
                        </td>
                        <td className={delta > 0.001 ? 'up' : delta < -0.001 ? 'down' : ''}>
                          {s.disabled
                            ? '→ 禁用'
                            : delta > 0.001
                              ? `↑ +${(delta * 100).toFixed(0)}%`
                              : delta < -0.001
                                ? `↓ ${(delta * 100).toFixed(0)}%`
                                : '→ 持平'}
                        </td>
                        <td className="muted" style={{ textAlign: 'left', fontSize: 12 }}>
                          {s.note}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button
                className="btn btn-strong"
                onClick={() => {
                  onApplyWeights(suggestion.factors)
                  setApplied(true)
                }}
              >
                ✅ 应用这些权重
              </button>
              <button className="btn" onClick={() => setSuggestion(null)}>
                取消
              </button>
            </div>
          </>
        )}
      </section>
    </>
  )
}
