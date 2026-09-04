import type { PickRecord } from '../data/records'
import type { SettleResult } from './settle'

/**
 * 策略表现追踪（纯函数）
 * 按策略模板聚合"规则结算口径"表现，帮用户判断长期该用哪个模板。
 * 旧记录（无 strategy）归为 legacy 组，不参与"表现最好"判定。
 */

export interface StrategyStats {
  key: string
  name: string
  legacy: boolean // 是否为未记录策略的历史数据
  sampleCount: number // 已结算样本数（排除 pending）
  tpCount: number
  slCount: number
  profitCount: number // 结算收益 > 0 的样本数（含窗口末持有的盈利）
  tpRate: number // 止盈率 %
  slRate: number // 止损率 %
  profitRate: number // 窗口内获利胜率 %
  avgPct: number // 平均结算收益 %
}

/** 未记录策略的旧数据分组 key */
export const LEGACY_KEY = '__legacy__'

export function computeStrategyStats(
  records: PickRecord[],
  settled: Map<string, SettleResult>,
): StrategyStats[] {
  interface Acc {
    key: string
    name: string
    legacy: boolean
    sampleCount: number
    tpCount: number
    slCount: number
    profitCount: number
    sumPct: number
  }
  const groups = new Map<string, Acc>()
  const ensure = (key: string, name: string, legacy: boolean): Acc => {
    let g = groups.get(key)
    if (!g) {
      g = { key, name, legacy, sampleCount: 0, tpCount: 0, slCount: 0, profitCount: 0, sumPct: 0 }
      groups.set(key, g)
    }
    return g
  }

  for (const r of records) {
    const key = r.strategy?.key ?? LEGACY_KEY
    const name = r.strategy?.name ?? '历史（未记录策略）'
    const g = ensure(key, name, !r.strategy)
    for (const p of r.picks) {
      const s = settled.get(`${r.date}:${p.code}`)
      if (!s || s.pct === null || s.status === 'pending') continue
      g.sampleCount++
      g.sumPct += s.pct
      if (s.pct > 0) g.profitCount++
      if (s.status === 'take_profit') g.tpCount++
      else if (s.status === 'stop_loss') g.slCount++
    }
  }

  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      name: g.name,
      legacy: g.legacy,
      sampleCount: g.sampleCount,
      tpCount: g.tpCount,
      slCount: g.slCount,
      profitCount: g.profitCount,
      tpRate: g.sampleCount > 0 ? (g.tpCount / g.sampleCount) * 100 : 0,
      slRate: g.sampleCount > 0 ? (g.slCount / g.sampleCount) * 100 : 0,
      profitRate: g.sampleCount > 0 ? (g.profitCount / g.sampleCount) * 100 : 0,
      avgPct: g.sampleCount > 0 ? g.sumPct / g.sampleCount : 0,
    }))
    .sort((a, b) => b.avgPct - a.avgPct)
}
