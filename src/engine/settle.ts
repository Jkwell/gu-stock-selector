import type { Kline } from '../types'

/**
 * 今日推荐闭环结算引擎（纯函数）
 * 模拟"按推荐规则执行"的结果：从推荐日次日起 N 个交易日内，
 * 先触及止损→按止损价结算，先触及止盈→按止盈价结算，
 * 窗口结束都没触发→按窗口末收盘价结算（持有中）。
 *
 * 时序约定：推荐日在 T 日收盘生成，结算从 T+1 日（推荐日次日）开始观测。
 */

export type SettleStatus = 'take_profit' | 'stop_loss' | 'holding' | 'pending'

export interface SettleResult {
  status: SettleStatus
  exitPrice: number | null // 触发价 / 窗口末收盘价；pending 为 null
  exitDate: string | null // 'YYYY-MM-DD'
  pct: number | null // (exit/entry - 1) * 100，百分比；pending 为 null
  barsUsed: number // 实际消耗的交易日数
  windowDays: number // 本次窗口长度
}

export interface SettleInput {
  entryPrice: number // 推荐价（成本基准）
  stopLoss: number
  takeProfit: number
  recommendDate: string // 推荐日 'YYYY-MM-DD'，与 K 线 date 同为字符串，字典序可直接比较
  klines: Kline[] // 全量日 K（升序，需覆盖推荐日）
  windowDays?: number // 结算窗口（交易日），默认 SETTLE_WINDOW_DAYS
}

/** 结算窗口：推荐后 N 个交易日（默认一个交易周） */
export const SETTLE_WINDOW_DAYS = 5

/** 四舍五入到 2 位小数（避免浮点误差，如 10.000000000000009） */
const round2 = (v: number) => Math.round(v * 100) / 100

function pendingResult(windowDays: number, barsUsed: number): SettleResult {
  return {
    status: 'pending',
    exitPrice: null,
    exitDate: null,
    pct: null,
    barsUsed,
    windowDays,
  }
}

/**
 * 对单只推荐结算。
 * 锚定策略：K 线数组本身就是连续的交易日（停牌/节假日/周末天然缺条），
 * 无需日历算法——找最后一个 date <= recommendDate 的 bar 作为推荐日，从其下一根开始观测。
 * 同一根 K 线既触及止盈又触及止损时按"止损优先"结算（风控底线，避免把亏单乐观计为盈单）。
 */
export function settlePick(input: SettleInput): SettleResult {
  const wd = input.windowDays ?? SETTLE_WINDOW_DAYS
  if (!(input.entryPrice > 0) || input.klines.length === 0) {
    return pendingResult(wd, 0)
  }

  // 锚定推荐日（最后一个 ≤ 推荐日的交易日）
  let anchor = -1
  for (let i = 0; i < input.klines.length; i++) {
    if (input.klines[i].date <= input.recommendDate) anchor = i
    else break
  }
  // 全量 K 线都在推荐日之后（新股/次新，数据未覆盖推荐日）→ 无法结算
  if (anchor === -1) return pendingResult(wd, 0)

  const window = input.klines.slice(anchor + 1, anchor + 1 + wd)
  for (let bi = 0; bi < window.length; bi++) {
    const k = window[bi]
    // 止损优先（保守）：同日 low≤止损 且 high≥止盈 时按止损结算
    if (input.stopLoss > 0 && k.low <= input.stopLoss) {
      return {
        status: 'stop_loss',
        exitPrice: input.stopLoss,
        exitDate: k.date,
        pct: round2((input.stopLoss / input.entryPrice - 1) * 100),
        barsUsed: bi + 1,
        windowDays: wd,
      }
    }
    if (input.takeProfit > 0 && k.high >= input.takeProfit) {
      return {
        status: 'take_profit',
        exitPrice: input.takeProfit,
        exitDate: k.date,
        pct: round2((input.takeProfit / input.entryPrice - 1) * 100),
        barsUsed: bi + 1,
        windowDays: wd,
      }
    }
  }

  // 窗口满且全程未触发 → 持有，按窗口末收盘价结算
  if (window.length === wd) {
    const last = window[window.length - 1]
    return {
      status: 'holding',
      exitPrice: last.close,
      exitDate: last.date,
      pct: round2((last.close / input.entryPrice - 1) * 100),
      barsUsed: wd,
      windowDays: wd,
    }
  }

  // 窗口未满（推荐日接近数据末端，未来交易日不足 N 根）→ 待结算
  return pendingResult(wd, window.length)
}
