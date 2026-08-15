import type { Kline } from '../types'
import { annualizedVol, macd, rsi, sma } from './indicators'

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
  ]
}
