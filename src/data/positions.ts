import { marketOfCode } from './api'

/**
 * 模拟持仓（localStorage）
 * 记录买入价，实时算盈亏，止损/止盈提醒。
 */

export interface Position {
  code: string
  name: string
  buyPrice: number
  shares: number // 股数
  buyDate: string
  stopLoss?: number // 可选，触发标红
  takeProfit?: number // 可选
}

const STORAGE_KEY = 'stock-selector-positions'

export function getPositions(): Position[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as Position[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function save(list: Position[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // ignore
  }
}

export type PositionInput = Omit<Position, 'shares'> & { shares?: number }

export function addPosition(pos: PositionInput): Position[] {
  const list = getPositions()
  void marketOfCode(pos.code)
  list.push({
    code: pos.code,
    name: pos.name || pos.code,
    buyPrice: pos.buyPrice,
    shares: pos.shares || 100,
    buyDate: pos.buyDate,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
  })
  save(list)
  return list
}

export function removePosition(code: string): Position[] {
  const list = getPositions().filter((p) => p.code !== code)
  save(list)
  return list
}
