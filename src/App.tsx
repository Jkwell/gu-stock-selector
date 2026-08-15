import { useState } from 'react'
import type { SelectionResult, SelectConfig, StockScore } from './types'
import { DEFAULT_CONFIG } from './config/factors'
import { runSelection, type PipelineProgress } from './data/pipeline'
import { clearCache } from './data/cache'
import ConfigPanel from './components/ConfigPanel'
import ResultTable from './components/ResultTable'
import StockDetailModal from './components/StockDetailModal'
import ICPanel from './components/ICPanel'
import BacktestPanel from './components/BacktestPanel'
import DailyPickPanel from './components/DailyPickPanel'
import WatchlistPanel from './components/WatchlistPanel'
import MarketPanel from './components/MarketPanel'
import ReviewPanel from './components/ReviewPanel'
import PositionPanel from './components/PositionPanel'
import AIPanel from './components/AIPanel'
import './App.css'

type Tab = 'market' | 'review' | 'position' | 'watch' | 'daily' | 'select' | 'ic' | 'backtest' | 'ai'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'market', label: '🌡️ 市场' },
  { key: 'review', label: '📋 复盘' },
  { key: 'position', label: '💰 持仓' },
  { key: 'watch', label: '👁️ 监控' },
  { key: 'daily', label: '🎯 今日推荐' },
  { key: 'ai', label: '🤖 AI 研报' },
  { key: 'select', label: '📋 选股' },
  { key: 'ic', label: '🔬 因子分析' },
  { key: 'backtest', label: '📊 策略回测' },
]

export default function App() {
  const [config, setConfig] = useState<SelectConfig>(() =>
    JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
  )
  const [tab, setTab] = useState<Tab>('daily')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<PipelineProgress | null>(null)
  const [result, setResult] = useState<SelectionResult | null>(null)
  const [selected, setSelected] = useState<StockScore | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const r = await runSelection(config, { onProgress: setProgress, concurrency: 8 })
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const backToConfig = () => {
    setResult(null)
    setTab('select')
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>📈 多因子选股工具</h1>
        <div className="header-actions">
          <span className="muted">数据源：东方财富 / 腾讯行情（免费）</span>
          <button
            className="btn btn-sm"
            onClick={() => {
              void clearCache()
              alert('缓存已清空，下次选股将重新拉取数据')
            }}
          >
            清空缓存
          </button>
        </div>
      </header>

      {/* Tab 导航 */}
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab-btn ${tab === t.key ? 'active' : ''}`}
            onClick={() => {
              setTab(t.key)
              setResult(null)
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {tab === 'market' && <MarketPanel />}

      {tab === 'review' && <ReviewPanel onSelect={setSelected} />}

      {tab === 'position' && <PositionPanel onSelect={setSelected} />}

      {tab === 'watch' && <WatchlistPanel onSelect={setSelected} />}

      {tab === 'daily' && (
        <DailyPickPanel config={config} onSelect={setSelected} />
      )}

      {tab === 'ai' && <AIPanel />}

      {tab === 'select' &&
        (!result ? (
          <ConfigPanel
            config={config}
            onChange={setConfig}
            onStart={() => void start()}
            disabled={running}
          />
        ) : (
          <ResultTable result={result} onSelect={setSelected} onBack={backToConfig} />
        ))}

      {tab === 'ic' && <ICPanel config={config} />}
      {tab === 'backtest' && <BacktestPanel config={config} />}

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

      {selected && (
        <StockDetailModal stock={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
