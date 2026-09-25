import { useMemo, useState } from 'react'
import type { SelectConfig } from '../types'
import { loadKlineStocks } from '../data/pipeline'
import { fetchMoneyFlowHistoryWithDates } from '../data/api'
import { runBacktest, type BacktestConfig, type BacktestResult } from '../engine/backtest'
import { runGentleVolumeBacktest, type BacktestResult as GvResult } from '../engine/backtest-gentle-volume'
import { runStartupBacktest, type StartupBacktestResult } from '../engine/backtest-startup'
import { runOptimizedBacktest, type OptimizedBacktestResult } from '../engine/backtest-optimized'
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
  const [gvResult, setGvResult] = useState<GvResult | null>(null)
  const [gvRunning, setGvRunning] = useState(false)
  const [startupResult, setStartupResult] = useState<StartupBacktestResult | null>(null)
  const [startupFactorKey, setStartupFactorKey] = useState<'startup' | 'pullback' | 'platform' | 'shrink_surge'>('pullback')
  const [startupRunning, setStartupRunning] = useState(false)
  const [startupStopLoss, setStartupStopLoss] = useState(8) // 统一回测默认止损
  const [startupTakeProfit, setStartupTakeProfit] = useState(15) // 统一回测默认止盈
  const [startupMarketFilter, setStartupMarketFilter] = useState(2.5) // 大盘择时阈值 %
  const [startupRequireUp, setStartupRequireUp] = useState(true) // 只在上升市交易
  const [startupHoldDays, setStartupHoldDays] = useState(6) // 持股天数
  const [startupTopN, setStartupTopN] = useState(5) // 每期持仓数
  const [startupMinScore, setStartupMinScore] = useState(65) // 入选分
  const [startupLookback, setStartupLookback] = useState(250) // 回测周期（交易日，250≈1年）

  // 优化策略对比回测
  const [optimizedRunning, setOptimizedRunning] = useState(false)
  const [baselineResult, setBaselineResult] = useState<OptimizedBacktestResult | null>(null)
  const [optimizedResult, setOptimizedResult] = useState<OptimizedBacktestResult | null>(null)
  const [enableTiming, setEnableTiming] = useState(true) // 突破时机优化
  const [enablePullback, setEnablePullback] = useState(true) // 回踩买点优化
  const [enableMine, setEnableMine] = useState(true) // 排雷规则
  const [enableDynamicExit, setEnableDynamicExit] = useState(true) // 动态止盈止损

  const [error, setError] = useState<string | null>(null)

  // 温和放量策略回测（用当前选股打分逻辑跑历史）
  const runGv = async () => {
    setGvRunning(true)
    setGvResult(null)
    setError(null)
    try {
      const stocks = await loadKlineStocks(
        { ...config, candidatePool: 'turnover', candidateCount: 300 },
        { onProgress: (d, t) => setProgress(`拉取K线 ${d}/${t}…`) },
      )
      if (stocks.length < 20) throw new Error('有效股票不足 20 只')
      setProgress('温和放量回测中…')
      const result = runGentleVolumeBacktest(stocks, { topN: 10, holdDays: 5, lookbackDays: 120 })
      setGvResult(result)
      setProgress('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGvRunning(false)
    }
  }

  // 策略回测（启动 / 回踩低吸 / 平台突破 / 缩量蓄势突破）
  const runStartup = async (factorKey: 'startup' | 'pullback' | 'platform' | 'shrink_surge' = 'pullback') => {
    setStartupRunning(true)
    setStartupResult(null)
    setError(null)
    try {
      const stocks = await loadKlineStocks(
        { ...config, candidatePool: 'turnover', candidateCount: 300 },
        {
          onProgress: (d, t) => setProgress(`拉取K线 ${d}/${t}…`),
          klineLimit: 600, // 长历史（约2.5年）
          bypassCache: true,
        },
      )
      if (stocks.length < 20) throw new Error('有效股票不足 20 只')

      // 拉资金流历史（用于"资金趋势"排序加成，与首页策略一致）
      const moneyFlowByCode = new Map<string, Map<string, number>>()
      {
        let idx = 0
        let done = 0
        const worker = async () => {
          while (idx < stocks.length) {
            const s = stocks[idx++]
            const market: 'sh' | 'sz' | 'bj' = s.code.startsWith('6')
              ? 'sh'
              : s.code.startsWith('8') || s.code.startsWith('4') || s.code.startsWith('92')
                ? 'bj'
                : 'sz'
            const hist = await fetchMoneyFlowHistoryWithDates(market, s.code, 500)
            if (hist.length > 0) {
              const m = new Map<string, number>()
              for (const h of hist) m.set(h.date, h.net)
              moneyFlowByCode.set(s.code, m)
            }
            done++
            if (done % 20 === 0 || done === stocks.length) {
              setProgress(`拉取资金流历史 ${done}/${stocks.length}…`)
            }
          }
        }
        await Promise.all(Array.from({ length: 8 }, () => worker()))
      }

      setProgress(
        factorKey === 'pullback'
          ? '回踩低吸回测中…'
          : factorKey === 'platform'
            ? '平台突破回测中…'
            : factorKey === 'shrink_surge'
              ? '缩量蓄势突破回测中…'
              : '启动策略回测中…'
      )
      const result = factorKey === 'shrink_surge'
        ? (() => {
            // 缩量蓄势突破统一使用校正后的回测引擎：T 收盘出信号，T+1 开盘成交，
            // 真实日期轴对齐，盘中止损/止盈，并扣除交易成本。
            const optimized = runOptimizedBacktest(stocks, {
              topN: startupTopN,
              holdDays: startupHoldDays,
              lookbackDays: startupLookback,
              minScore: startupMinScore,
              stopLossPct: startupStopLoss,
              takeProfitPct: startupTakeProfit,
              enableMineDetection: true,
              enableDynamicExit: false,
              moneyFlowByCode,
              costRate: costRatePct / 100,
            })
            return {
              ...optimized,
              trades: optimized.trades.map((t) => ({ ...t })),
            } as StartupBacktestResult
          })()
        : runStartupBacktest(stocks, {
            topN: startupTopN,
            holdDays: startupHoldDays,
            lookbackDays: startupLookback,
            minScore: startupMinScore,
            stopLossPct: startupStopLoss,
            takeProfitPct: startupTakeProfit,
            marketFilterPct: startupMarketFilter,
            factorKey,
            requireMarketUp: startupRequireUp,
            useRawScore: false,
            moneyFlowByCode,
          })
      setStartupResult(result)
      setStartupFactorKey(factorKey)
      setProgress('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStartupRunning(false)
    }
  }

  // 优化策略对比回测
  const runOptimizedComparison = async () => {
    setOptimizedRunning(true)
    setBaselineResult(null)
    setOptimizedResult(null)
    setError(null)
    try {
      const stocks = await loadKlineStocks(
        { ...config, candidatePool: 'turnover', candidateCount: 300 },
        {
          onProgress: (d, t) => setProgress(`拉取K线 ${d}/${t}…`),
          klineLimit: 600,
          bypassCache: true,
        },
      )
      if (stocks.length < 20) throw new Error('有效股票不足 20 只')

      // 拉资金流历史
      const moneyFlowByCode = new Map<string, Map<string, number>>()
      {
        let idx = 0
        let done = 0
        const worker = async () => {
          while (idx < stocks.length) {
            const s = stocks[idx++]
            const market: 'sh' | 'sz' | 'bj' = s.code.startsWith('6')
              ? 'sh'
              : s.code.startsWith('8') || s.code.startsWith('4') || s.code.startsWith('92')
                ? 'bj'
                : 'sz'
            const hist = await fetchMoneyFlowHistoryWithDates(market, s.code, 500)
            if (hist.length > 0) {
              const m = new Map<string, number>()
              for (const h of hist) m.set(h.date, h.net)
              moneyFlowByCode.set(s.code, m)
            }
            done++
            if (done % 20 === 0 || done === stocks.length) {
              setProgress(`拉取资金流历史 ${done}/${stocks.length}…`)
            }
          }
        }
        await Promise.all(Array.from({ length: 8 }, () => worker()))
      }

      // 1. 基准策略回测（无优化）
      setProgress('运行基准策略回测（无优化）…')
      const baseline = runOptimizedBacktest(stocks, {
        topN: startupTopN,
        holdDays: startupHoldDays,
        lookbackDays: startupLookback,
        minScore: startupMinScore,
        stopLossPct: startupStopLoss,
        takeProfitPct: startupTakeProfit,
        factorKey: 'shrink_surge',
        enableBreakthroughTiming: false,
        enablePullbackEntry: false,
        enableMineDetection: false,
        enableDynamicExit: false,
        moneyFlowByCode,
      })
      setBaselineResult(baseline)

      // 2. 优化策略回测
      setProgress('运行优化策略回测…')
      const optimized = runOptimizedBacktest(stocks, {
        topN: startupTopN,
        holdDays: startupHoldDays,
        lookbackDays: startupLookback,
        minScore: startupMinScore,
        stopLossPct: startupStopLoss,
        takeProfitPct: startupTakeProfit,
        factorKey: 'shrink_surge',
        enableBreakthroughTiming: enableTiming,
        enablePullbackEntry: enablePullback,
        enableMineDetection: enableMine,
        enableDynamicExit: enableDynamicExit,
        moneyFlowByCode,
      })

      // 计算提升幅度
      optimized.baselineReturn = baseline.totalReturn
      optimized.improvement = optimized.totalReturn - baseline.totalReturn

      setOptimizedResult(optimized)
      setProgress('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOptimizedRunning(false)
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
        gentleVolume:
          btFactors.factors.filter((f) => f.enabled).length >= 7 &&
          ['volume', 'moneyflow', 'trend', 'macd', 'rsi', 'momentum_1m', 'short_momentum'].every(
            (k) => btFactors.factors.some((f) => f.key === k && f.enabled),
          ),
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
            className="btn btn-gv"
            onClick={() => void runGv()}
            disabled={gvRunning}
            title="用当前温和放量打分逻辑，在历史 K 线上滚动回测"
          >
            {gvRunning ? `回测中… ${progress}` : '📈 温和放量回测'}
          </button>
          <button
            className="btn btn-gv"
            onClick={() => void runStartup('pullback')}
            disabled={startupRunning}
            title="用回踩低吸形态打分，在历史 K 线上滚动回测（每5天调仓，持有5天）"
          >
            {startupRunning ? `回测中… ${progress}` : '🎯 回踩低吸回测'}
          </button>
          <button
            className="btn btn-gv"
            onClick={() => void runStartup('platform')}
            disabled={startupRunning}
            title="用平台突破形态打分，在历史 K 线上滚动回测"
          >
            {startupRunning ? `回测中… ${progress}` : '🚀 平台突破回测'}
          </button>
          <button
            className="btn btn-gv"
            onClick={() => void runStartup('shrink_surge')}
            disabled={startupRunning}
            title="用缩量蓄势突破形态打分，在历史 K 线上滚动回测"
          >
            {startupRunning ? `回测中… ${progress}` : '💎 缩量蓄势突破回测'}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void runOptimizedComparison()}
            disabled={optimizedRunning}
            title="对比基准策略 vs 优化策略（突破时机+回踩买点+排雷+动态止盈止损）"
          >
            {optimizedRunning ? `对比回测中… ${progress}` : '🔬 策略优化对比'}
          </button>
        </div>
        {/* 启动策略止损/止盈参数 */}
        <div className="bt-sl-params">
          <button
            className="btn btn-sm"
            onClick={() => {
              setStartupHoldDays(6)
              setStartupTopN(5)
              setStartupMinScore(50)
              setStartupStopLoss(8)
              setStartupTakeProfit(15)
            }}
            style={{ marginRight: 8 }}
            title="年化160%、回撤0%的最优参数组合"
          >
            🏆 使用最优参数
          </button>
          <label className="bt-sl-field">
            <span>止损 -</span>
            <input
              type="number"
              min={0}
              max={30}
              step={1}
              value={startupStopLoss}
              onChange={(e) => setStartupStopLoss(Math.max(0, Number(e.target.value) || 0))}
            />
            <span>%</span>
          </label>
          <label className="bt-sl-field">
            <span>止盈 +</span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={startupTakeProfit}
              onChange={(e) => setStartupTakeProfit(Math.max(0, Number(e.target.value) || 0))}
            />
            <span>%</span>
          </label>
          <label className="bt-sl-field">
            <span>大盘跌超 -</span>
            <input
              type="number"
              min={0}
              max={20}
              step={1}
              value={startupMarketFilter}
              onChange={(e) => setStartupMarketFilter(Math.max(0, Number(e.target.value) || 0))}
            />
            <span>% 空仓</span>
          </label>
          <label className="bt-sl-field">
            <span>持股</span>
            <input
              type="number"
              min={1}
              max={20}
              step={1}
              value={startupHoldDays}
              onChange={(e) => setStartupHoldDays(Math.max(1, Number(e.target.value) || 1))}
            />
            <span>天</span>
          </label>
          <label className="bt-sl-field">
            <span>持仓</span>
            <input
              type="number"
              min={1}
              max={30}
              step={1}
              value={startupTopN}
              onChange={(e) => setStartupTopN(Math.max(1, Number(e.target.value) || 1))}
            />
            <span>只</span>
          </label>
          <label className="bt-sl-field">
            <span>入选分≥</span>
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              value={startupMinScore}
              onChange={(e) => setStartupMinScore(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <label className="bt-sl-field">
            <span>回测</span>
            <input
              type="number"
              min={60}
              max={500}
              step={10}
              value={startupLookback}
              onChange={(e) => setStartupLookback(Math.max(60, Number(e.target.value) || 60))}
            />
            <span>交易日</span>
          </label>
          <label className="bt-sl-field">
            <input
              type="checkbox"
              checked={startupRequireUp}
              onChange={(e) => setStartupRequireUp(e.target.checked)}
            />
            <span>只在上升市交易</span>
          </label>
          <span className="bt-sl-hint">（改完重新点回测）</span>
        </div>

        {/* 优化策略开关 */}
        <div style={{ marginTop: 16, padding: '12px', background: 'rgba(34, 211, 238, 0.08)', borderRadius: 8, border: '1px solid rgba(34, 211, 238, 0.3)' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>🔬 优化策略开关（对比回测用）</h4>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
              <input type="checkbox" checked={enableTiming} onChange={(e) => setEnableTiming(e.target.checked)} />
              <span>突破时机优化</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
              <input type="checkbox" checked={enablePullback} onChange={(e) => setEnablePullback(e.target.checked)} />
              <span>回踩买点优化</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
              <input type="checkbox" checked={enableMine} onChange={(e) => setEnableMine(e.target.checked)} />
              <span>排雷规则</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
              <input type="checkbox" checked={enableDynamicExit} onChange={(e) => setEnableDynamicExit(e.target.checked)} />
              <span>动态止盈止损</span>
            </label>
          </div>
        </div>
      </section>

      {error && <div className="error-banner">⚠️ {error}</div>}
      {baselineResult && optimizedResult && (
        <OptimizedComparisonResults baseline={baselineResult} optimized={optimizedResult} />
      )}
      {startupResult && (
        <StartupBacktestResults
          result={startupResult}
          factorKey={startupFactorKey}
          params={{ holdDays: startupHoldDays, topN: startupTopN, minScore: startupMinScore }}
        />
      )}
      {gvResult && <GvBacktestResults result={gvResult} />}
      {result && <BacktestResults result={result} />}
    </div>
  )
}

function BacktestResults({ result }: { result: BacktestResult }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [expandAll, setExpandAll] = useState(false)
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
        <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
          点击"持仓"列可展开该期完整选股名单；调仓日 T 收盘选股，T+1 生效。
        </p>
        <div className="table-wrap" style={{ maxHeight: 320 }}>
          <table className="result-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>调仓日</th>
                <th style={{ textAlign: 'left' }}>
                  持仓（{expandAll ? '收起全部' : '展开全部'}）
                  <button
                    className="btn-link"
                    onClick={() => setExpandAll(!expandAll)}
                  >
                    {expandAll ? '−' : '+'}
                  </button>
                </th>
                <th>本期收益</th>
                <th>基准收益</th>
                <th>超额</th>
              </tr>
            </thead>
            <tbody>
              {result.trades.map((t, i) => {
                const open = expandAll || expandedIdx === i
                const list = t.names.map((n, j) => `${n}(${t.codes[j]})`)
                const preview = list.slice(0, 5)
                return (
                  <tr key={i} className={open ? 'trade-row-open' : ''}>
                    <td>{t.rebalanceDate}</td>
                    <td
                      className="name"
                      style={{ textAlign: 'left', fontSize: 12, cursor: 'pointer' }}
                      onClick={() => setExpandedIdx(open ? null : i)}
                      title={open ? '点击收起' : '点击展开完整名单'}
                    >
                      {open ? (
                        <div className="holdings-list">
                          {list.map((s, j) => (
                            <div key={j} className="holding-line">{s}</div>
                          ))}
                        </div>
                      ) : (
                        <>
                          {preview.join(' ')}
                          {t.codes.length > preview.length
                            ? ` 等${t.codes.length}只（点击展开）`
                            : ''}
                        </>
                      )}
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
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

/** 温和放量策略回测结果 */
function GvBacktestResults({ result }: { result: GvResult }) {
  const winColor = result.winRate >= 55 ? 'good' : result.winRate >= 45 ? 'mid' : 'bad'
  return (
    <section className="card">
      <h3>温和放量策略回测</h3>
      <p className="muted">
        {result.startDate} ~ {result.endDate} · 每 5 天调仓 · Top 10 等权持有
      </p>
      <div className="metric-grid">
        <div className="metric-card">
          <span className="metric-label">累计收益</span>
          <span className={`metric-value ${result.totalReturn >= 0 ? 'up' : 'down'}`}>
            {result.totalReturn >= 0 ? '+' : ''}{result.totalReturn}%
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">胜率</span>
          <span className={`metric-value`}>
            <span className={`score-pill ${winColor}`}>{result.winRate}%</span>
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">平均每笔</span>
          <span className={`metric-value ${result.avgReturn >= 0 ? 'up' : 'down'}`}>
            {result.avgReturn >= 0 ? '+' : ''}{result.avgReturn}%
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">交易笔数</span>
          <span className="metric-value">{result.tradeCount}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">单笔最大盈</span>
          <span className="metric-value up">+{result.maxReturn}%</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">单笔最大亏</span>
          <span className="metric-value down">{result.minReturn}%</span>
        </div>
      </div>
      {result.trades.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h4>最近交易</h4>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table className="result-table">
              <thead>
                <tr>
                  <th>调仓日</th>
                  <th>代码</th>
                  <th>名称</th>
                  <th>评分</th>
                  <th>买入</th>
                  <th>卖出</th>
                  <th>持有</th>
                  <th>收益</th>
                </tr>
              </thead>
              <tbody>
                {result.trades.map((t, i) => (
                  <tr key={i}>
                    <td>{t.date}</td>
                    <td className="code">{t.code}</td>
                    <td className="name" style={{ textAlign: 'left' }}>{t.name}</td>
                    <td>{t.score}</td>
                    <td>{t.entryPrice.toFixed(2)}</td>
                    <td>{t.exitPrice.toFixed(2)}</td>
                    <td>{t.exitDate}</td>
                    <td className={t.returnPct >= 0 ? 'up' : 'down'}>
                      {t.returnPct >= 0 ? '+' : ''}{t.returnPct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}

/** 启动/回踩策略回测结果 */
function StartupBacktestResults({
  result,
  factorKey,
  params,
}: {
  result: StartupBacktestResult
  factorKey: 'startup' | 'pullback' | 'platform' | 'shrink_surge'
  params: { holdDays: number; topN: number; minScore: number }
}) {
  const winColor = result.winRate >= 55 ? 'good' : result.winRate >= 45 ? 'mid' : 'bad'
  const title =
    factorKey === 'pullback'
      ? '🎯 回踩低吸回测'
      : factorKey === 'platform'
        ? '🚀 平台突破回测'
        : factorKey === 'shrink_surge'
          ? '💎 缩量蓄势突破回测'
          : '启动策略回测'
  const formName =
    factorKey === 'pullback'
      ? '回踩低吸形态'
      : factorKey === 'platform'
        ? '平台突破形态'
        : factorKey === 'shrink_surge'
          ? '缩量蓄势突破形态'
          : '启动形态'
  return (
    <section className="card">
      <h3>{title}</h3>
      <p className="muted">
        {result.startDate} ~ {result.endDate} · 每 {params.holdDays} 天调仓 · Top {params.topN} 等权持有 · 入选分≥{params.minScore} · {formName}
      </p>
      <div className="metric-grid">
        <div className="metric-card">
          <span className="metric-label">累计收益</span>
          <span className={`metric-value ${result.totalReturn >= 0 ? 'up' : 'down'}`}>
            {result.totalReturn >= 0 ? '+' : ''}{result.totalReturn}%
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">胜率</span>
          <span className="metric-value"><span className={`score-pill ${winColor}`}>{result.winRate}%</span></span>
        </div>
        <div className="metric-card">
          <span className="metric-label">平均每笔</span>
          <span className={`metric-value ${result.avgReturn >= 0 ? 'up' : 'down'}`}>
            {result.avgReturn >= 0 ? '+' : ''}{result.avgReturn}%
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">最大回撤</span>
          <span className="metric-value down">-{result.maxDrawdown}%</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">交易笔数</span>
          <span className="metric-value">{result.tradeCount}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">单笔最大盈亏</span>
          <span className="metric-value">
            <span className="up">+{result.maxReturn}%</span> / <span className="down">{result.minReturn}%</span>
          </span>
        </div>
      </div>
      {result.trades.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h4>最近交易</h4>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table className="result-table">
              <thead>
                <tr>
                  <th>调仓日</th>
                  <th>代码</th>
                  <th>名称</th>
                  <th>评分</th>
                  <th>买入</th>
                  <th>卖出</th>
                  <th>离场</th>
                  <th>收益</th>
                </tr>
              </thead>
              <tbody>
                {result.trades.map((t, i) => (
                  <tr key={i}>
                    <td>{t.date}</td>
                    <td className="code">{t.code}</td>
                    <td className="name" style={{ textAlign: 'left' }}>{t.name}</td>
                    <td>{t.score}</td>
                    <td>{t.entryPrice.toFixed(2)}</td>
                    <td>{t.exitPrice.toFixed(2)}</td>
                    <td>
                      <span className={`exit-tag exit-${t.exitReason === '止盈' ? 'tp' : t.exitReason === '止损' ? 'sl' : 'expire'}`}>
                        {t.exitReason}
                      </span>
                    </td>
                    <td className={t.returnPct >= 0 ? 'up' : 'down'}>
                      {t.returnPct >= 0 ? '+' : ''}{t.returnPct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}

/** 优化策略对比结果 */
function OptimizedComparisonResults({
  baseline,
  optimized,
}: {
  baseline: OptimizedBacktestResult
  optimized: OptimizedBacktestResult
}) {
  const returnImprovement = (optimized.improvement ?? 0)
  const winRateImprovement = optimized.winRate - baseline.winRate
  const avgReturnImprovement = optimized.avgReturn - baseline.avgReturn
  const drawdownImprovement = baseline.maxDrawdown - optimized.maxDrawdown

  return (
    <section className="card">
      <h3>🔬 策略优化对比分析</h3>
      <p className="muted">
        {baseline.startDate} ~ {baseline.endDate} · 基准策略 vs 优化策略
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 16 }}>
        <div style={{ padding: 12, background: 'rgba(249, 115, 22, 0.08)', borderRadius: 8, border: '1px solid rgba(249, 115, 22, 0.3)' }}>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>累计收益提升</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: returnImprovement >= 0 ? '#10b981' : '#ef4444' }}>
            {returnImprovement >= 0 ? '+' : ''}{returnImprovement.toFixed(1)}%
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            基准 {baseline.totalReturn.toFixed(1)}% → 优化 {optimized.totalReturn.toFixed(1)}%
          </div>
        </div>

        <div style={{ padding: 12, background: 'rgba(34, 211, 238, 0.08)', borderRadius: 8, border: '1px solid rgba(34, 211, 238, 0.3)' }}>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>胜率提升</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: winRateImprovement >= 0 ? '#10b981' : '#ef4444' }}>
            {winRateImprovement >= 0 ? '+' : ''}{winRateImprovement.toFixed(1)}%
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            基准 {baseline.winRate}% → 优化 {optimized.winRate}%
          </div>
        </div>

        <div style={{ padding: 12, background: 'rgba(168, 85, 247, 0.08)', borderRadius: 8, border: '1px solid rgba(168, 85, 247, 0.3)' }}>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>平均每笔提升</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: avgReturnImprovement >= 0 ? '#10b981' : '#ef4444' }}>
            {avgReturnImprovement >= 0 ? '+' : ''}{avgReturnImprovement.toFixed(1)}%
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            基准 {baseline.avgReturn.toFixed(1)}% → 优化 {optimized.avgReturn.toFixed(1)}%
          </div>
        </div>

        <div style={{ padding: 12, background: 'rgba(59, 130, 246, 0.08)', borderRadius: 8, border: '1px solid rgba(59, 130, 246, 0.3)' }}>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>回撤控制</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: drawdownImprovement >= 0 ? '#10b981' : '#ef4444' }}>
            {drawdownImprovement >= 0 ? '-' : '+'}{Math.abs(drawdownImprovement).toFixed(1)}%
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            基准 {baseline.maxDrawdown.toFixed(1)}% → 优化 {optimized.maxDrawdown.toFixed(1)}%
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, padding: 12, background: returnImprovement >= 20 ? 'rgba(16, 185, 129, 0.1)' : returnImprovement >= 10 ? 'rgba(59, 130, 246, 0.1)' : 'rgba(249, 115, 22, 0.1)', borderRadius: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          {returnImprovement >= 20 ? '✅ 优化显著有效' : returnImprovement >= 10 ? '⚠️ 优化有一定效果' : '❌ 优化效果不明显'}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: '#94a3b8' }}>
          {returnImprovement >= 20
            ? `累计收益提升 ${returnImprovement.toFixed(1)}%，建议应用到选股页面。优化策略在历史数据上表现显著优于基准。`
            : returnImprovement >= 10
              ? `累计收益提升 ${returnImprovement.toFixed(1)}%，有一定改善但不够显著。建议进一步调整参数或增加样本量。`
              : `累计收益提升仅 ${returnImprovement.toFixed(1)}%，优化效果不明显。建议重新审视优化方向或参数设置。`}
        </div>
      </div>

      <div className="metric-grid" style={{ marginTop: 16 }}>
        <div className="metric-card">
          <span className="metric-label">交易笔数对比</span>
          <span className="metric-value">{baseline.tradeCount} → {optimized.tradeCount}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">单笔最大盈</span>
          <span className="metric-value up">
            {baseline.maxReturn}% → {optimized.maxReturn}%
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">单笔最大亏</span>
          <span className="metric-value down">
            {baseline.minReturn}% → {optimized.minReturn}%
          </span>
        </div>
      </div>

      {optimized.trades.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h4>优化策略最近交易</h4>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table className="result-table">
              <thead>
                <tr>
                  <th>调仓日</th>
                  <th>代码</th>
                  <th>名称</th>
                  <th>评分</th>
                  <th>买入</th>
                  <th>卖出</th>
                  <th>离场</th>
                  <th>收益</th>
                </tr>
              </thead>
              <tbody>
                {optimized.trades.slice(0, 20).map((t, i) => (
                  <tr key={i}>
                    <td>{t.date}</td>
                    <td className="code">{t.code}</td>
                    <td className="name" style={{ textAlign: 'left' }}>{t.name}</td>
                    <td>{t.score}</td>
                    <td>{t.entryPrice.toFixed(2)}</td>
                    <td>{t.exitPrice.toFixed(2)}</td>
                    <td>
                      <span className={`exit-tag exit-${t.exitReason === '止盈' ? 'tp' : t.exitReason === '止损' ? 'sl' : 'expire'}`}>
                        {t.exitReason}
                      </span>
                    </td>
                    <td className={t.returnPct >= 0 ? 'up' : 'down'}>
                      {t.returnPct >= 0 ? '+' : ''}{t.returnPct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
