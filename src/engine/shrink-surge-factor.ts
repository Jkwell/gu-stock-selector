import type { Kline } from '../types'
import { sma } from './indicators'

/**
 * 缩量蓄势突破因子（专门识别：前期放量 → 缩量洗盘 → 突破启动主升浪）
 *
 * 模式特征：
 * 1. 前期有明显放量（可能伴随涨停）
 * 2. 之后持续缩量横盘（主力洗盘蓄势）
 * 3. 量能降到极低水平（近期量能 < 均量的60-80%）
 * 4. 突然收红放量突破（量能恢复到均量以上，收阳线）
 * 5. 价格突破前期盘整平台
 *
 * @returns 0~1的评分，越接近1说明越符合启动特征
 */
export function calcShrinkSurgeScore(kline: Kline[]): (number | null)[] {
  const close = kline.map(k => k.close)
  const high = kline.map(k => k.high)
  const low = kline.map(k => k.low)
  const open = kline.map(k => k.open)
  const volume = kline.map(k => k.volume)

  return close.map((c, i) => {
    if (i < 45) return null

    // 所有基准均只使用信号日前数据，避免把突破日同时算进“平台/均量”。
    const prior = volume.slice(i - 30, i)
    const baseVol = prior.reduce((a, b) => a + b, 0) / prior.length
    if (!Number.isFinite(baseVol) || baseVol <= 0) return null
    const impulse = volume.slice(i - 25, i - 10)
    const impulseAvg = impulse.reduce((a, b) => a + b, 0) / impulse.length
    const wash = volume.slice(i - 9, i)
    const washAvg = wash.reduce((a, b) => a + b, 0) / wash.length
    const impulseRatio = impulseAvg / baseVol
    const washRatio = washAvg / impulseAvg
    const todayRatio = volume[i] / baseVol

    // 前期真实放量：量能至少高于长期基准 1.35 倍，且价格有上移。
    const impulseMove = close[i - 10] > 0 ? close[i - 1] / close[i - 10] - 1 : 0
    const hasImpulse = impulseRatio >= 1.35 && impulseMove >= 0.03
    // 洗盘：缩量但不能缩到流动性枯竭，价格回撤受控。
    const washHigh = Math.max(...high.slice(i - 9, i))
    const washLow = Math.min(...low.slice(i - 9, i))
    const washDrawdown = washHigh > 0 ? (washHigh - washLow) / washHigh : 1
    const validWash = washRatio >= 0.35 && washRatio <= 0.78 && washDrawdown <= 0.16
    // 突破：收盘突破前 10 日平台，并且收盘位于当日振幅上方。
    const platformHigh = Math.max(...high.slice(i - 10, i))
    const breakout = platformHigh > 0 && c > platformHigh * 1.005
    const range = high[i] - low[i]
    const closeLocation = range > 0 ? (c - low[i]) / range : 0
    const green = c > open[i] && c > close[i - 1]
    const confirmed = breakout && green && todayRatio >= 1.25 && todayRatio <= 3.5 && closeLocation >= 0.65

    let score = 0
    if (hasImpulse) score += 0.25
    if (validWash) score += 0.25
    if (confirmed) score += 0.35

    // 趋势确认：MA20 上穿 MA60，避免逆势“假突破”。
    const ma20Values = sma(close.slice(0, i + 1), 20)
    const ma60Values = sma(close.slice(0, i + 1), 60)
    const ma20 = ma20Values[ma20Values.length - 1] ?? 0
    const ma60 = ma60Values[ma60Values.length - 1] ?? 0
    if (ma20 > ma60 && c > ma20) score += 0.1

    // 突破日涨幅过大或极端天量时降低追高风险分。
    const todayGain = close[i - 1] > 0 ? c / close[i - 1] - 1 : 0
    if (todayGain > 0.09 || todayRatio > 4) score -= 0.15
    if (washDrawdown > 0.12) score -= 0.05
    return Math.max(0, Math.min(1, score))
  })
}
