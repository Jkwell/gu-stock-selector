/**
 * 手动交易记录（模拟持仓卖出后沉淀）
 * 打通「选股/手动买入 → 卖出 → 复盘盈亏」闭环。
 */

export interface TradeRecord {
  code: string
  name: string
  buyPrice: number
  sellPrice: number
  shares: number
  buyDate: string // YYYY-MM-DD
  sellDate: string // YYYY-MM-DD
  pnl: number // 盈亏额（元）
  pnlPct: number // 盈亏率 %
}

const STORAGE_KEY = 'stock-selector-trades'

export function getTrades(): TradeRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as TradeRecord[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function save(list: TradeRecord[]) {
  try {
    // 按卖出日降序，最多保留 100 条
    const sorted = list.sort((a, b) => (a.sellDate < b.sellDate ? 1 : -1)).slice(0, 100)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sorted))
  } catch {
    // ignore
  }
}

/** 记录一次卖出（sellDate 缺省为今天） */
export function addTrade(t: Omit<TradeRecord, 'pnl' | 'pnlPct' | 'sellDate'> & { sellDate?: string }): TradeRecord {
  const sellDate = t.sellDate ?? new Date().toISOString().slice(0, 10)
  const pnl = (t.sellPrice - t.buyPrice) * t.shares
  const pnlPct = t.buyPrice > 0 ? ((t.sellPrice / t.buyPrice - 1) * 100) : 0
  const rec: TradeRecord = {
    code: t.code,
    name: t.name,
    buyPrice: t.buyPrice,
    sellPrice: t.sellPrice,
    shares: t.shares,
    buyDate: t.buyDate,
    sellDate,
    pnl: Number(pnl.toFixed(2)),
    pnlPct: Number(pnlPct.toFixed(2)),
  }
  const list = getTrades()
  list.unshift(rec)
  save(list)
  return rec
}

export function clearTrades(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
