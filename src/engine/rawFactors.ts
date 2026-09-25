import type { Kline } from '../types'
import { annualizedVol, bollinger, lastValid, macd, rsi, sma } from './indicators'

/**
 * 技术因子向量化计算器（共享模块）
 * IC 分析与回测引擎共用，避免重复实现。
 * 每个 calculator 返回与 kline 等长的数组，不可用位置为 null。
 */

export interface RawFactorCalculator {
  key: string
  name: string
  /** higher = 值越大越好；lower = 值越小越好 */
  direction: 'higher' | 'lower'
  calc: (kline: Kline[]) => (number | null)[]
}

const pct = (a: number, b: number) => (b !== 0 ? a / b - 1 : null)
const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v))

export function buildTechnicalCalculators(): RawFactorCalculator[] {
  return [
    {
      key: 'trend',
      name: '趋势强度',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        const ma20 = sma(close, 20)
        const ma60 = sma(close, 60)
        return close.map((c, i) => {
          const m20 = ma20[i]
          const m60 = ma60[i]
          const m20prev = ma20[i - 2]
          if (m20 === null || m60 === null || m20prev === null) return null
          return (
            pct(c, m20)! * 0.35 +
            pct(c, m60)! * 0.35 +
            (m20 / m60 - 1) * 0.2 +
            pct(m20, m20prev)! * 1.5
          )
        })
      },
    },
    {
      key: 'macd',
      name: 'MACD 动量',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        const m = macd(close)
        return m.hist.map((h, i) => (i < 1 ? null : h / close[i]))
      },
    },
    {
      key: 'rsi',
      name: 'RSI 状态',
      direction: 'higher',
      calc: (kl) => rsi(kl.map((k) => k.close), 14) as (number | null)[],
    },
    {
      key: 'volume',
      name: '成交量异动',
      direction: 'higher',
      calc: (kl) => {
        const vol = kl.map((k) => k.volume)
        const vol20 = sma(vol, 20)
        return vol.map((v, i) => {
          const v20 = vol20[i]
          return v20 && v20 > 0 ? v / v20 : null
        })
      },
    },
    {
      key: 'momentum_1m',
      name: '动量(1月)',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        return close.map((c, i) => (i >= 20 ? pct(c, close[i - 20]) : null))
      },
    },
    {
      key: 'momentum_3m',
      name: '动量(3月)',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        return close.map((c, i) => (i >= 60 ? pct(c, close[i - 60]) : null))
      },
    },
    {
      key: 'reversal',
      name: '短期反转',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        return close.map((c, i) => (i >= 5 ? close[i - 5] / c - 1 : null))
      },
    },
    {
      key: 'volatility',
      name: '低波动',
      direction: 'lower',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        return close.map((_, i) =>
          i >= 29 ? annualizedVol(close.slice(i - 29, i + 1), 20) : null,
        )
      },
    },
    {
      key: 'short_momentum',
      name: '3日爆发力',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        return close.map((c, i) => (i >= 3 ? c / close[i - 3] - 1 : null))
      },
    },
    {
      key: 'breakout',
      name: '创新高',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        const high = kl.map((k) => k.high)
        return close.map((c, i) => {
          if (i < 20) return null
          const h20 = Math.max(...high.slice(i - 20, i)) // 前 20 日不含当日
          return h20 > 0 ? c / h20 - 1 : null
        })
      },
    },
    {
      key: 'ma_squeeze',
      name: '均线粘合突破',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        const volume = kl.map((k) => k.volume)
        const ma5 = sma(close, 5)
        const ma20 = sma(close, 20)
        const ma60 = sma(close, 60)
        const vol5 = sma(volume, 5)
        return close.map((c, i) => {
          const m5 = ma5[i]
          const m20 = ma20[i]
          const m60 = ma60[i]
          if (m5 === null || m20 === null || m60 === null) return null
          const spread = Math.max(m5, m20, m60) - Math.min(m5, m20, m60)
          const squeeze = c > 0 ? spread / c : null
          const avgVol = vol5[i]
          const surge = avgVol && avgVol > 0 ? volume[i] / avgVol : 0
          const breakout = c > m60 && surge > 1.5
          if (squeeze === null) return null
          // 与 factors.ts 相同：突破高分，粘合中分，发散低分
          return breakout
            ? clamp(100 - squeeze * 2000, 70, 100)
            : clamp(70 - squeeze * 1500, 30, 70)
        })
      },
    },
    {
      key: 'limit_up',
      name: '连板高度',
      direction: 'higher',
      calc: (kl) => {
        // 用 10% 阈值（主板标准），创业板/科创板近似
        const TH = 0.095
        return kl.map((_, i) => {
          let days = 0
          for (let j = i; j >= 1; j--) {
            const prev = kl[j - 1].close
            if (prev <= 0) break
            if (kl[j].close / prev - 1 >= TH) days++
            else break
          }
          return days
        })
      },
    },
    {
      key: 'vol_pattern',
      name: '量能形态',
      direction: 'higher',
      calc: (kl) => {
        const volume = kl.map((k) => k.volume)
        const close = kl.map((k) => k.close)
        return close.map((_, i) => {
          if (i < 20) return 0.5 // 数据不足返回中性值
          const vol20Arr = sma(volume.slice(0, i + 1), 20)
          const vol20 = lastValid(vol20Arr)
          if (!vol20 || vol20 === 0) return 0.5
          const volLast = volume[i]
          const ratio = volLast / vol20
          const prev3Avg = (volume[i - 1] + volume[i - 2] + volume[i - 3]) / 3
          const hasShrinkBase = prev3Avg < vol20
          const isFirstSurge = prev3Avg > 0 && volLast > prev3Avg * 1.3
          const isUpDay = close[i] > kl[i].open && close[i] > close[i - 1]
          const ma5Arr = sma(close.slice(0, i + 1), 5)
          const ma20Arr = sma(close.slice(0, i + 1), 20)
          const ma5 = lastValid(ma5Arr)
          const ma20 = lastValid(ma20Arr)
          const isTrendUp = ma5 && ma20 ? ma5 > ma20 && close[i] > ma20 : false
          let score = 0.3
          if (hasShrinkBase) score += 0.2
          if (isFirstSurge) score += 0.15
          if (isUpDay) score += 0.15
          if (isTrendUp) score += 0.2
          if (ratio > 2.5) score -= 0.15
          // 返回连续值（0~1），不返回null
          return Math.max(0, Math.min(1, Math.round(score * 100) / 100))
        })
      },
    },
    {
      key: 'startup',
      name: '启动形态',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        const high = kl.map((k) => k.high)
        const low = kl.map((k) => k.low)
        const volume = kl.map((k) => k.volume)
        return close.map((c, i) => {
          if (i < 30) return 0.5
          const vol20 = lastValid(sma(volume.slice(0, i + 1), 20))
          if (!vol20 || vol20 === 0) return 0.5
          const volLast = volume[i]
          let raw = 0

          // ① 前期涨停
          let hadLimitUp = false
          for (let j = i - 1; j >= Math.max(1, i - 19); j--) {
            if (close[j - 1] > 0 && close[j] / close[j - 1] - 1 > 0.095) { hadLimitUp = true; break }
          }
          if (hadLimitUp) raw += 0.3

          // ② 均线粘合
          const ma5 = lastValid(sma(close.slice(0, i + 1), 5))
          const ma10 = lastValid(sma(close.slice(0, i + 1), 10))
          const ma20 = lastValid(sma(close.slice(0, i + 1), 20))
          if (ma5 && ma10 && ma20 && ma5 > 0) {
            const mx = Math.max(ma5, ma10, ma20)
            const mn = Math.min(ma5, ma10, ma20)
            const sq = (mx - mn) / mn
            if (sq < 0.02) raw += 0.25
            else if (sq < 0.04) raw += 0.15
          }

          // ③ 横盘缩量
          const seg = close.slice(Math.max(0, i - 9), i + 1)
          const segHigh = Math.max(...high.slice(Math.max(0, i - 9), i + 1))
          const segLow = Math.min(...low.slice(Math.max(0, i - 9), i + 1))
          const amp = c > 0 ? (segHigh - segLow) / c : 1
          const segVol = seg.map((_, k) => volume[Math.max(0, i - 9) + k]).reduce((a, b) => a + b, 0) / seg.length
          if (amp < 0.12) raw += 0.15
          if (segVol < vol20 * 0.95) raw += 0.1

          // ④ 放量突破
          const volRatio = volLast / vol20
          const high10prev = Math.max(...high.slice(Math.max(0, i - 10), i))
          const volSurge = volRatio >= 1.4 && volRatio <= 5.0
          const breakout = high10prev > 0 && c >= high10prev * 0.995
          if (volSurge && breakout) raw += 0.35
          else if (volSurge) raw += 0.1
          else if (breakout) raw += 0.05

          // ⑤ 位置低
          const high60 = Math.max(...high.slice(Math.max(0, i - 59), i + 1))
          if (high60 > 0 && c / high60 <= 0.92) raw += 0.1

          const todayGain = close[i - 1] > 0 ? c / close[i - 1] - 1 : 0
          if (todayGain > 0.07) raw -= 0.15

          return Math.max(0, Math.min(1, Math.round(raw * 100) / 100))
        })
      },
    },
    {
      key: 'entry_fit',
      name: '买点契合',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map((k) => k.close)
        return close.map((c, i) => {
          if (i < 20) return 0.5 // 数据不足返回中性值
          const bb = bollinger(close.slice(0, i + 1))
          const bbLower = lastValid(bb.lower)
          const bbMid = lastValid(bb.middle)
          if (!bbLower || !bbMid || bbMid <= bbLower) return 0.5
          const dist = (c - bbLower) / (bbMid - bbLower)
          if (dist >= 0 && dist <= 1) return Math.max(0, Math.min(1, 1 - dist * 0.5))
          if (dist < 0) return Math.max(0, 0.3 + dist * 0.3)
          return Math.max(0, Math.min(1, 1 - dist * 0.3))
        })
      },
    },
    {
      key: 'shrink_surge',
      name: '缩量蓄势突破',
      direction: 'higher',
      calc: (kl) => {
        const close = kl.map(k => k.close)
        const high = kl.map(k => k.high)
        const low = kl.map(k => k.low)
        const open = kl.map(k => k.open)
        const volume = kl.map(k => k.volume)

        return close.map((c, i) => {
          if (i < 30) return null

          const vol20 = lastValid(sma(volume.slice(0, i + 1), 20))
          if (!vol20 || vol20 === 0) return null

          let score = 0

          // 前期放量（10-20天前）
          let hadHighVolume = false
          let hadLimitUp = false
          for (let j = Math.max(1, i - 20); j < i - 5; j++) {
            const volRatio = volume[j] / vol20
            if (volRatio > 2.0) hadHighVolume = true
            if (close[j - 1] > 0 && close[j] / close[j - 1] - 1 > 0.095) {
              hadLimitUp = true
            }
          }
          if (hadHighVolume) score += 0.2
          if (hadLimitUp) score += 0.15

          // 持续缩量（近5-10天）
          const recentVols = volume.slice(Math.max(0, i - 9), i)
          const recentAvgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length
          const shrinkRatio = recentAvgVol / vol20

          if (shrinkRatio >= 0.5 && shrinkRatio <= 0.8) {
            score += 0.25
          } else if (shrinkRatio > 0.8 && shrinkRatio <= 0.95) {
            score += 0.15
          }

          // 量能连续递减
          let consecutiveShrink = 0
          for (let j = i - 5; j < i; j++) {
            if (j > 0 && volume[j] < volume[j - 1]) {
              consecutiveShrink++
            }
          }
          if (consecutiveShrink >= 3) score += 0.1

          // 横盘整理（近10天波动小）
          const segHigh = Math.max(...high.slice(Math.max(0, i - 9), i + 1))
          const segLow = Math.min(...low.slice(Math.max(0, i - 9), i + 1))
          const amplitude = c > 0 ? (segHigh - segLow) / c : 1

          if (amplitude < 0.10) score += 0.15
          else if (amplitude < 0.15) score += 0.08

          // 今日突破启动
          const todayVolRatio = volume[i] / vol20
          const isRedCandle = c > open[i] && c > close[i - 1]

          const volumeSurge = todayVolRatio >= 1.0 && todayVolRatio <= 3.5
          if (volumeSurge && isRedCandle) {
            score += 0.3
          } else if (volumeSurge) {
            score += 0.1
          } else if (isRedCandle && todayVolRatio >= 0.9) {
            score += 0.15
          }

          // 价格突破前期平台
          const highBefore = Math.max(...high.slice(Math.max(0, i - 10), i))
          const priceBreakout = highBefore > 0 && c >= highBefore * 0.995
          if (priceBreakout) score += 0.15

          // 过滤：今日涨幅过大
          const todayGain = close[i - 1] > 0 ? c / close[i - 1] - 1 : 0
          if (todayGain > 0.08) score -= 0.2

          // 位置过高
          const high60 = Math.max(...high.slice(Math.max(0, i - 59), i + 1))
          if (high60 > 0 && c / high60 > 0.95) score -= 0.1

          // 天量
          if (todayVolRatio > 4.0) score -= 0.15

          return Math.max(0, Math.min(1, score))
        })
      },
    },
  ]
}
