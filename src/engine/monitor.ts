import type { WatchItem } from '../data/watchlist'

/**
 * 监控状态引擎（纯函数）
 * 根据实时价与买卖点，判断每只票当前所处状态。
 */

export type WatchStatus =
  | 'stop_loss' // 🔴 跌破止损
  | 'take_profit' // 🔵 到止盈
  | 'buy_zone' // 🟢 买点区间
  | 'below_buy' // 🟡 破买点下沿
  | 'above_buy' // 🟡 已超买点
  | 'holding' // ⚪ 持有观察
  | 'no_signal' // ⚪ 无买卖点（仅监控价格）

export interface WatchState {
  status: WatchStatus
  label: string
  cls: string // CSS 类名
  hint: string // 说明
}

export function watchStatus(price: number | undefined, item: WatchItem): WatchState {
  if (price === undefined || !Number.isFinite(price)) {
    return { status: 'holding', label: '—', cls: 'ws-gray', hint: '等待行情' }
  }

  // 无买卖点：仅监控价格
  const hasSignal = item.stopLoss !== undefined || item.takeProfit !== undefined || item.buyLow !== undefined
  if (!hasSignal) {
    return { status: 'no_signal', label: '⚪ 仅监控', cls: 'ws-gray', hint: '未设置买卖点' }
  }

  // 止损优先（最危险）
  if (item.stopLoss !== undefined && price <= item.stopLoss) {
    return {
      status: 'stop_loss',
      label: '🔴 跌破止损',
      cls: 'ws-red',
      hint: `已跌破止损 ${item.stopLoss.toFixed(2)}，建议离场`,
    }
  }

  // 止盈
  if (item.takeProfit !== undefined && price >= item.takeProfit) {
    return {
      status: 'take_profit',
      label: '🔵 到止盈',
      cls: 'ws-blue',
      hint: `已达止盈 ${item.takeProfit.toFixed(2)}，可考虑兑现`,
    }
  }

  // 买点区间
  if (item.buyLow !== undefined && item.buyHigh !== undefined) {
    if (price >= item.buyLow && price <= item.buyHigh) {
      return {
        status: 'buy_zone',
        label: '🟢 买点区间',
        cls: 'ws-green',
        hint: `在买点区间 ${item.buyLow.toFixed(2)}~${item.buyHigh.toFixed(2)}，可分批买入`,
      }
    }
    if (price < item.buyLow) {
      return {
        status: 'below_buy',
        label: '🟡 破买点下沿',
        cls: 'ws-yellow',
        hint: `已跌破买点下沿 ${item.buyLow.toFixed(2)}，观望`,
      }
    }
    // price > buyHigh
    return {
      status: 'above_buy',
      label: '🟡 已超买点',
      cls: 'ws-yellow',
      hint: `已高于买点 ${item.buyHigh.toFixed(2)}，追高需谨慎`,
    }
  }

  return { status: 'holding', label: '⚪ 持有观察', cls: 'ws-gray', hint: '在持有区间' }
}
