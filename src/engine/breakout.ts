import type { Kline } from '../types'
import { lastValid, sma } from './indicators'

/**
 * 均线粘合突破（横盘蓄势后启动）
 * 粘合度 = (MA5, MA20, MA60 极差) / 当前价，越小越粘合（蓄势）
 * 突破 = 收盘突破 MA60 且放量（量比 > 1.5）
 */

export interface MaSqueeze {
  squeeze: number | null // 粘合度（小数，如 0.02 = 2%）
  breakout: boolean // 是否粘合后向上突破
}

export function maSqueeze(kline: Kline[]): MaSqueeze {
  if (kline.length < 60) return { squeeze: null, breakout: false }
  const close = kline.map((k) => k.close)
  const volume = kline.map((k) => k.volume)
  const n = close.length

  const ma5 = lastValid(sma(close, 5))
  const ma20 = lastValid(sma(close, 20))
  const ma60 = lastValid(sma(close, 60))
  if (ma5 === null || ma20 === null || ma60 === null) {
    return { squeeze: null, breakout: false }
  }

  const price = close[n - 1]
  // 粘合度：三均线极差 / 现价
  const spread = Math.max(ma5, ma20, ma60) - Math.min(ma5, ma20, ma60)
  const squeeze = price > 0 ? spread / price : null

  // 突破：收盘站上 MA60 + 放量（量比 > 1.5）
  const todayVol = volume[n - 1]
  const avgVol = lastValid(sma(volume, 5))
  const volumeSurge = avgVol && avgVol > 0 ? todayVol / avgVol : 0
  const breakout = price > ma60 && volumeSurge > 1.5

  return { squeeze, breakout }
}
