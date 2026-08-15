import { useMemo, useState } from 'react'
import type { SelectConfig } from '../types'
import { loadKlineStocks } from '../data/pipeline'
import { runBacktest, type BacktestConfig, type BacktestResult } from '../engine/backtest'
import { STRATEGY_TEMPLATES, applyTemplate } from '../config/factors'
import { useECharts } from './charts/useECharts'
import type * as echarts from 'echarts'

interface Props {
  config: SelectConfig
}

const POOL_LABELS: Record<string, string> = {
  all: '全部A股',
  hs300: '沪深300',
  zz500: '中证500',
}

export default function BacktestPanel({ config }: Props) {
  const [count, setCount] = useState(100)
  const [topN, setTopN] = useState(10)
  const [rebalanceDays, setRebalanceDays] = useState(20)
  const [costRatePct, setCostRatePct] = useState(0.15) // 交易成本 %（买卖双向）
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [compareResults, setCompareResults] = useState<Array<{ name: string; desc: string; result: BacktestResult }> | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 多策略对比回测
  const runCompare = async () => {
    setRunning(true)
    setError(null)
    setCompareResults(null)
    setResult(null)
    try {
      const stocks = await loadKlineStocks(
        // 回测不使用当前涨幅/换手率截断候选，避免把今天的信息泄漏到历史。
        { ...config, candidatePool: 'liquid', candidateCount: count },
        { onProgress: (d, t) => setProgress(`拉取K线 ${d}/${t}…`) },
      )
      if (stocks.length < 20) throw new Error('有效股票不足 20 只')
      const results: Array<{ name: string; desc: string; result: BacktestResult }> = []
      let i = 0
      for (const t of STRATEGY_TEMPLATES) {
        setProgress(`回测 ${t.name} (${++i}/${STRATEGY_TEMPLATES.length})…`)
        const btConfig: BacktestConfig = {
          startDate: '0000-01-01',
          endDate: '2050-01-01',
          topN,
          rebalanceDays,
          factors: applyTemplate(t, config).factors,
          costRate: costRatePct / 100,
        }
        results.push({ name: t.name, desc: t.desc, result: runBacktest(stocks, btConfig) })
      }
      setCompareResults(results)
      setProgress('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const run = async (factorConfig?: SelectConfig) => {
    setRunning(true)
    setError(null)
    setResult(null)
    const btFactors = factorConfig ?? config
    try {
      const stocks = await loadKlineStocks(
        // 回测统一使用流通市值排序的候选池，策略因子负责历史截面排序。
        { ...btFactors, candidatePool: 'liquid', candidateCount: count },
        { onProgress: (d, t) => setProgress(`拉取K线 ${d}/${t}…`) },
      )
      if (stocks.length < 20) throw new Error('有效股票不足 20 只')
      setProgress('回测计算中…')
      const btConfig: BacktestConfig = {
        startDate: '0000-01-01', // 用全部数据，受 K 线长度限制
        endDate: '2050-01-01',
        topN,
        rebalanceDays,
        factors: btFactors.factors,
        costRate: costRatePct / 100,
      }
      const r = runBacktest(stocks, btConfig)
      setResult(r)
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
        <h3>📊 策略回测（仅技术因子）</h3>
        <div
          style={{
            background: 'rgba(255, 193, 7, 0.12)',
            border: '1px solid rgba(255, 193, 7, 0.4)',
            borderRadius: 8,
            padding: '8px 12px',
            margin: '0 0 12px',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          ⚠️ <b>回测仅使用技术面因子</b>（趋势/动量/MACD/量能等），不包含基本面（估值/盈利/成长）
          和资金流因子。实盘选股使用全部因子，回测结果可能偏乐观，仅供参考。
        </div>
        <p className="muted" style={{ margin: '0 0 12px' }}>
          按当前因子配置，在历史区间模拟"定期打分 → Top N 等权持有 → 滚动调仓"。使用当前候选股票池的 K 线数据，尚未还原历史成分股变更。
        </p>
        <div className="filter-grid">
          <label className="field">
            <span className="field-label">候选股票数</span>
            <input
              type="number" min={30} max={500} step={10}
              value={count}
              onChange={(e) => setCount(Math.max(30, Number(e.target.value) || 100))}
            />
          </label>
          <label className="field">
            <span className="field-label">每期持仓 Top N</span>
            <input
              type="number" min={1} max={50}
              value={topN}
              onChange={(e) => setTopN(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
            />
          </label>
          <label className="field">
            <span className="field-label">调仓间隔（交易日）</span>
            <input
              type="number" min={5} max={60} step={5}
              value={rebalanceDays}
              onChange={(e) => setRebalanceDays(Math.max(5, Math.min(60, Number(e.target.value) || 20)))}
            />
          </label>
          <label className="field">
            <span className="field-label">交易成本 %（买卖双向）</span>
            <input
              type="number" min={0} max={1} step={0.05}
              value={costRatePct}
              onChange={(e) =>
                setCostRatePct(Math.max(0, Math.min(1, Number(e.target.value) || 0.15)))
              }
            />
          </label>
          <div className="field checkbox-field">
            <span className="field-label">股票池：{POOL_LABELS[config.pool]} · 回测候选按流通市值</span>
          </div>
        </div>
        <div className="btn-row" style={{ gap: 10 }}>
          <button className="btn btn-primary" onClick={() => void run()} disabled={running}>
            {running ? `回测中… ${progress}` : '▶ 运行回测'}
          </button>
          <button
            className="btn btn-strong"
            onClick={() => void run(applyTemplate(STRATEGY_TEMPLATES.find((t) => t.key === 'strong')!, config))}
            disabled={running}
            title="用强势领涨模板的因子权重回测，验证短线策略历史胜率"
          >
            🔥 一键回测强势领涨
          </button>
          <button
            className="btn btn-compare"
            onClick={() => void runCompare()}
            disabled={running}
            title="7 个策略全部回测，横向对比哪个历史最强"
          >
            🔍 多策略对比回测
          </button>
        </div>
      </section>

      {error && <div className="error-banner">⚠️ {error}</div>}
      {result && <BacktestResults result={result} />}
      {compareResults && <CompareResults results={compareResults} />}
    </div>
  )
}

/** 多策略对比回测结果表 */
function CompareResults({
  results,
}: {
  results: Array<{ name: string; desc: string; result: BacktestResult }>
}) {
  const sorted = [...results].sort(
    (a, b) => b.result.totalReturn - a.result.totalReturn,
  )
  return (
    <section className="card">
      <h3>🔍 多策略对比（按累计收益排序）</h3>
      <p className="muted" style={{ margin: '0 0 12px' }}>
        所有策略用相同当前股票池/周期回测，横向比较相对表现；当前结果仍受短样本和历史成分股缺失影响。收益高≠适合你，还要看回撤和胜率。
      </p>
      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table className="result-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>排名</th>
              <th style={{ textAlign: 'left' }}>策略</th>
              <th style={{ textAlign: 'left' }}>回测因子</th>
              <th>累计收益</th>
              <th>年化</th>
              <th>后半段</th>
              <th>夏普</th>
              <th>最大回撤</th>
              <th>胜率</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.name}>
                <td className="rank">{i + 1}</td>
                <td className="name" style={{ textAlign: 'left' }} title={r.desc}>
                  {r.name}
                </td>
                <td style={{ textAlign: 'left', fontSize: 12 }} title={r.result.omittedFactorKeys.join(', ')}>
                  {r.result.usedFactorKeys.length > 0 ? r.result.usedFactorKeys.join('、') : '无可用因子'}
                  {r.result.omittedFactorKeys.length > 0 ? '（已忽略非技术因子）' : ''}
                </td>
                <td className={r.result.totalReturn >= 0 ? 'up' : 'down'}>
                  {r.result.totalReturn.toFixed(1)}%
                </td>
                <td className={r.result.annualReturn >= 0 ? 'up' : 'down'}>
                  {r.result.annualReturn.toFixed(1)}%
                </td>
                <td className={r.result.secondHalfReturn >= 0 ? 'up' : 'down'}>
                  {r.result.secondHalfReturn.toFixed(1)}%
                </td>
                <td className={r.result.sharpe >= 1 ? 'up' : ''}>
                  {r.result.sharpe.toFixed(2)}
                </td>
                <td className="down">{r.result.maxDrawdown.toFixed(1)}%</td>
                <td>{r.result.winRate.toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function BacktestResults({ result }: { result: BacktestResult }) {
  const equityOption: echarts.EChartsOption = useMemo(() => {
    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) =>
          (typeof v === 'number' ? ((v - 1) * 100).toFixed(1) + '%' : String(v)),
      },
      legend: { top: 0 },
      grid: { left: 60, right: 20, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: result.dates },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: {
          formatter: (v: number) => ((v - 1) * 100).toFixed(0) + '%',
        },
      },
      series: [
        {
          name: '组合策略',
          type: 'line',
          data: result.portfolio.map((v) => Number(v.toFixed(4))),
          showSymbol: false,
          lineStyle: { width: 2, color: '#1971c2' },
          areaStyle: { color: 'rgba(25,113,194,0.1)' },
        },
        {
          name: '基准（等权）',
          type: 'line',
          data: result.benchmark.map((v) => Number(v.toFixed(4))),
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#868e96' },
        },
      ],
    }
  }, [result])
  const eqRef = useECharts(equityOption, [equityOption])

  const metric = (label: string, value: string, cls = '') => (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <span className={`metric-value ${cls}`}>{value}</span>
    </div>
  )

  return (
    <>
      <section className="card">
        <h3>净值曲线 vs 基准</h3>
        <div className="metric-grid">
          {metric('累计收益', `${result.totalReturn.toFixed(1)}%`, result.totalReturn >= 0 ? 'up' : 'down')}
          {metric('年化收益', `${result.annualReturn.toFixed(1)}%`, result.annualReturn >= 0 ? 'up' : 'down')}
          {metric('超额收益', `${result.excessReturn.toFixed(1)}%`, result.excessReturn >= 0 ? 'up' : 'down')}
          {metric('夏普比率', result.sharpe.toFixed(2), result.sharpe >= 1 ? 'up' : '')}
          {metric('最大回撤', `${result.maxDrawdown.toFixed(1)}%`, 'down')}
          {metric('调仓胜率', `${result.winRate.toFixed(0)}%`)}
        </div>
      <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
          已扣除交易成本 {result.costRate * 100}% / 次（买卖双向）
          {result.excludedCount > 0 && `；因涨停买不进跳过 ${result.excludedCount} 只`}
        </p>
        {result.omittedFactorKeys.length > 0 && (
          <div
            style={{
              background: 'rgba(255, 193, 7, 0.12)',
              border: '1px solid rgba(255, 193, 7, 0.4)',
              borderRadius: 8,
              padding: '8px 12px',
              margin: '8px 0 0',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            注意：本次历史回测实际只使用技术因子（{result.usedFactorKeys.join('、') || '无'}）；
            已忽略 {result.omittedFactorKeys.join('、')}。基本面和资金面没有按历史日期还原，不能据此比较完整策略。
          </div>
        )}
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
          稳定性拆分：前半段 {result.firstHalfReturn.toFixed(1)}%，后半段 {result.secondHalfReturn.toFixed(1)}%，
          后半段超额 {result.secondHalfExcessReturn.toFixed(1)}%。后半段仅用于检验表现是否延续，不代表真正样本外结果。
        </p>
        {result.sampleDays < 252 && (
          <div
            style={{
              background: 'rgba(255, 193, 7, 0.12)',
              border: '1px solid rgba(255, 193, 7, 0.4)',
              borderRadius: 8,
              padding: '8px 12px',
              margin: '8px 0 0',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            ⚠️ 当前只有 {result.sampleDays} 个交易日，少于约 1 年样本；同时使用当前股票池，结果不适合直接证明策略有效。
          </div>
        )}
        <div ref={eqRef} style={{ width: '100%', height: 320 }} />
      </section>

      <section className="card">
        <h3>调仓记录（{result.trades.length} 期）</h3>
        <div className="table-wrap" style={{ maxHeight: 320 }}>
          <table className="result-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>调仓日</th>
                <th style={{ textAlign: 'left' }}>持仓代码</th>
                <th>本期收益</th>
                <th>基准收益</th>
                <th>超额</th>
              </tr>
            </thead>
            <tbody>
              {result.trades.map((t, i) => (
                <tr key={i}>
                  <td>{t.rebalanceDate}</td>
                  <td className="name" style={{ textAlign: 'left', fontSize: 12 }}>
                    {t.codes.slice(0, 5).join(' ')}{t.codes.length > 5 ? ` 等${t.codes.length}只` : ''}
                  </td>
                  <td className={t.periodReturn >= 0 ? 'up' : 'down'}>
                    {t.periodReturn.toFixed(1)}%
                  </td>
                  <td className={t.benchmarkReturn >= 0 ? 'up' : 'down'}>
                    {t.benchmarkReturn.toFixed(1)}%
                  </td>
                  <td className={(t.periodReturn - t.benchmarkReturn) >= 0 ? 'up' : 'down'}>
                    {(t.periodReturn - t.benchmarkReturn).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
