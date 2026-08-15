import { useMemo, useState } from 'react'
import type { SelectionResult, StockScore } from '../types'

interface Props {
  result: SelectionResult
  onSelect: (stock: StockScore) => void
  onBack: () => void
}

type SortKey = 'total' | 'trend' | 'valuation' | 'growth' | 'money' | 'price'

/** 按列排序，null 得分排最后 */
function sortStocks(list: StockScore[], key: SortKey): StockScore[] {
  const get = (s: StockScore): number => {
    if (key === 'total') return s.totalScore
    if (key === 'price') return s.price ?? -Infinity
    const find = (k: string) =>
      s.factorScores.find((f) =>
        key === 'trend' ? f.key === 'trend' || f.key === 'macd' || f.key === 'rsi' : f.key === k,
      )?.score ?? -Infinity
    switch (key) {
      case 'trend':
        return s.factorScores
          .filter((f) => ['trend', 'macd', 'rsi', 'volume'].includes(f.key))
          .reduce((sum, f) => sum + f.score, 0) / 4
      case 'valuation':
        return find('valuation')
      case 'growth':
        return Math.max(find('profitability'), find('growth'))
      case 'money':
        return find('moneyflow')
      default:
        return -Infinity
    }
  }
  return [...list].sort((a, b) => get(b) - get(a))
}

function exportCSV(result: SelectionResult) {
  const headers = ['排名', '代码', '名称', '现价', '涨跌幅%', '总分']
  const factorKeys = result.scored[0]?.factorScores.map((f) => f.name) ?? []
  const rows = result.scored.map((s, i) => {
    const scoreMap = new Map(s.factorScores.map((f) => [f.name, f.score.toFixed(1)]))
    return [
      i + 1,
      s.code,
      s.name,
      s.price ?? '',
      s.changePct ?? '',
      s.totalScore,
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

export default function ResultTable({ result, onSelect, onBack }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('total')
  const sorted = useMemo(() => sortStocks(result.scored, sortKey), [result.scored, sortKey])

  return (
    <div className="result-panel">
      <div className="result-toolbar">
        <div>
          <h2>选股结果</h2>
          <p className="muted">
            扫描 {result.totalScanned} 只，跳过 {result.skipped} 只，入选{' '}
            {result.scored.length} 只
          </p>
        </div>
        <div className="toolbar-actions">
          <button className="btn" onClick={() => setSortKey(sortKey === 'total' ? 'price' : 'total')}>
            排序：{sortKey === 'total' ? '总分' : '价格'}
          </button>
          <button className="btn" onClick={() => exportCSV(result)}>
            ⬇ 导出 CSV
          </button>
          <button className="btn" onClick={onBack}>
            ← 返回配置
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="result-table">
          <thead>
            <tr>
              <th>#</th>
              <th>代码</th>
              <th>名称</th>
              <th>现价</th>
              <th>涨跌幅</th>
              <th>总分</th>
              {result.scored[0]?.factorScores.map((f) => (
                <th key={f.key}>
                  <button className="th-btn" onClick={() => setSortKey(f.key as SortKey)}>
                    {f.name}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => (
              <tr key={s.code} onClick={() => onSelect(s)}>
                <td className="rank">{i + 1}</td>
                <td className="code">{s.code}</td>
                <td className="name">{s.name}</td>
                <td className="price">{s.price?.toFixed(2) ?? '—'}</td>
                <td className={pctClass(s.changePct)}>
                  {s.changePct === undefined ? '—' : `${s.changePct.toFixed(2)}%`}
                </td>
                <td className="total-score">
                  <strong>{s.totalScore.toFixed(1)}</strong>
                </td>
                {s.factorScores.map((f) => (
                  <td key={f.key} className="factor-cell">
                    <span
                      className={`score-pill ${
                        f.score >= 70 ? 'good' : f.score >= 40 ? 'mid' : 'bad'
                      }`}
                      title={f.detail}
                    >
                      {f.score.toFixed(0)}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
