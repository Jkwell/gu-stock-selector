import type { AIReport } from '../types'

/**
 * AI 研报本地持久化（localStorage）
 * 后端 job 在服务重启后丢失，这里保存已完成的研报供回看。
 */

const STORAGE_KEY = 'ai-reports-history'
const MAX_ITEMS = 50

export function getAIReports(): AIReport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as AIReport[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 保存一份研报（同 jobId 覆盖，最新放最前） */
export function saveAIReport(report: AIReport, jobId: string): AIReport[] {
  const saved: AIReport = { ...report, jobId, savedAt: new Date().toISOString() }
  const list = getAIReports().filter((r) => r.jobId !== jobId)
  list.unshift(saved)
  const trimmed = list.slice(0, MAX_ITEMS)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // 存满忽略
  }
  return trimmed
}

export function deleteAIReport(jobId: string): AIReport[] {
  const list = getAIReports().filter((r) => r.jobId !== jobId)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // ignore
  }
  return list
}
