import { useEffect, useRef, useState } from 'react'
import type { AIJobInfo, AIReport, AIStage } from '../types'
import { AI_REPORT_TITLES, AI_RATING_MAP, AI_STAGES } from '../types'
import { fetchAIReportResult, pollAIReportJob, startAIReport } from '../data/api'
import { deleteAIReport, getAIReports, saveAIReport } from '../data/aiReports'
import { getPickRecords } from '../data/records'

const POLL_MS = 2000
const MAX_WAIT_MS = 5 * 60 * 1000

/** 报告正文是 markdown，自写迷你渲染器(不引第三方库，网络受限)。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inlineMd(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

function renderMarkdown(text: string): string {
  const lines = escapeHtml(text).split('\n')
  const out: string[] = []
  let listTag: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`)
      listTag = null
    }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      closeList()
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      closeList()
      const lv = Math.min(h[1].length, 6)
      out.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`)
      continue
    }
    const ul = line.match(/^[-*]\s+(.*)$/)
    if (ul) {
      if (listTag !== 'ul') {
        closeList()
        listTag = 'ul'
        out.push('<ul>')
      }
      out.push(`<li>${inlineMd(ul[1])}</li>`)
      continue
    }
    const ol = line.match(/^\d+[.)]\s+(.*)$/)
    if (ol) {
      if (listTag !== 'ol') {
        closeList()
        listTag = 'ol'
        out.push('<ol>')
      }
      out.push(`<li>${inlineMd(ol[1])}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inlineMd(line)}</p>`)
  }
  closeList()
  return out.join('\n')
}

export default function AIPanel() {
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [jobInfo, setJobInfo] = useState<AIJobInfo | null>(null)
  const [report, setReport] = useState<AIReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<AIReport[]>(() => getAIReports())
  const timerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)

  const quickPicks = (getPickRecords()[0]?.picks ?? []).slice(0, 4)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => clearTimer, [])

  const run = async () => {
    if (!/^\d{6}$/.test(code) || phase === 'running') return
    setError(null)
    setReport(null)
    setPhase('running')
    setJobInfo(null)
    try {
      const { job_id } = await startAIReport(code)
      startedAtRef.current = Date.now()
      const timer = window.setInterval(() => {
        void poll(job_id)
      }, POLL_MS)
      timerRef.current = timer
      await poll(job_id)
    } catch (e) {
      clearTimer()
      setPhase('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const poll = async (jobId: string) => {
    try {
      const info = await pollAIReportJob(jobId)
      setJobInfo(info)
      if (info.status === 'done') {
        clearTimer()
        const r = await fetchAIReportResult(jobId)
        const named = r.name ? r : { ...r, name: quickPicks.find((p) => p.code === r.ticker)?.name }
        setReport(named)
        saveAIReport(named, jobId)
        setHistory(getAIReports())
        setPhase('done')
      } else if (info.status === 'error') {
        clearTimer()
        setPhase('error')
        setError(info.error || '分析失败')
      } else if (Date.now() - startedAtRef.current > MAX_WAIT_MS) {
        clearTimer()
        setPhase('error')
        setError('分析超时(超过 5 分钟)，请重试')
      }
    } catch (e) {
      clearTimer()
      setPhase('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const stageStatus = (id: string): AIStage['status'] => {
    if (!jobInfo) return 'pending'
    const s = jobInfo.progress.find((p) => p.id === id)
    return s?.status ?? 'pending'
  }
  const currentStage = jobInfo?.progress.find((s) => s.status === 'active')

  const rating = report ? AI_RATING_MAP[report.signal] : undefined
  const sections = report
    ? Object.entries(report.reports)
        .filter(([k, v]) => v && AI_REPORT_TITLES[k])
        .map(([k, v]) => ({ key: k, ...AI_REPORT_TITLES[k], body: v }))
    : []

  return (
    <div className="config-panel">
      <h2 className="section-title">🤖 AI 研报</h2>
      <p className="muted" style={{ margin: '0 0 12px' }}>
        多智能体深度分析：7 个 AI 分析师（技术 / 情绪 / 新闻 / 基本面 / 政策 / 游资 / 解禁）→ 多空辩论 → 风控 → 五档评级。每次约 1-3 分钟、消耗 DeepSeek API 额度。报告仅供参考，不构成投资建议。
      </p>

      <div className="ai-input">
        <div className="ai-input-row">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="输入 6 位股票代码"
            disabled={phase === 'running'}
          />
          <button
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={phase === 'running' || !/^\d{6}$/.test(code)}
          >
            {phase === 'running' ? '分析中…' : '🚀 开始 AI 分析'}
          </button>
        </div>
        {quickPicks.length > 0 && (
          <div className="ai-quickpicks">
            <span className="muted">今日推荐：</span>
            {quickPicks.map((p) => (
              <button
                key={p.code}
                className="chip"
                disabled={phase === 'running'}
                onClick={() => setCode(p.code)}
              >
                {p.code} {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {phase === 'running' && (
        <div className="ai-progress">
          <div className="progress-label">
            <span>多智能体分析中{currentStage ? ` · ${currentStage.icon} ${currentStage.name}` : '…'}</span>
          </div>
          <ul className="ai-stages">
            {AI_STAGES.map((s) => {
              const st = stageStatus(s.id)
              return (
                <li key={s.id} className={`ai-stage ai-stage-${st}`}>
                  <span className="ai-stage-icon">{s.icon}</span>
                  <span className="ai-stage-name">{s.name}</span>
                  <span className="ai-stage-mark">{st === 'done' ? '✓' : st === 'active' ? '●' : '○'}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {report && (
        <div className="ai-report">
          <div className="ai-report-head">
            <h3>
              {report.name || report.label}（{report.ticker}）· {report.trade_date}
            </h3>
            <span className={`ai-rating ${rating?.cls ?? 'rating-hold'}`}>
              {rating ? `${rating.label} · ${report.signal}` : report.signal}
            </span>
            {report.duration_seconds != null && (
              <span className="muted">耗时 {report.duration_seconds}s</span>
            )}
          </div>
          {sections.map((s) => (
            <details key={s.key} className="ai-section" open={s.key === 'final_trade_decision' || s.key === 'portfolio_manager'}>
              <summary>
                {s.icon} {s.title}
              </summary>
              <div className="ai-section-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.body) }} />
            </details>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="ai-history">
          <h4>📚 历史研报（{history.length}）</h4>
          <ul>
            {history.map((r) => (
              <li key={r.jobId}>
                <button className="btn btn-sm" onClick={() => setReport(r)}>
                  {r.name || r.label}（{r.ticker}）· {r.signal} · {r.trade_date}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    deleteAIReport(r.jobId ?? '')
                    setHistory(getAIReports())
                    if (report?.jobId === r.jobId) setReport(null)
                  }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
