/**
 * 技术指标计算引擎（纯函数，无依赖）
 * 所有函数输入为从旧到新的时间序列，输出同样按时间对齐。
 */

/** 简单移动平均。前 period-1 个位置为 null */
export function sma(data: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(data.length).fill(null)
  if (period <= 0 || data.length < period) return out
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    sum += data[i]
    if (i >= period) sum -= data[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** 指数移动平均（初始为第一个值，迭代平滑）。返回全量数组 */
export function ema(data: number[], period: number): number[] {
  const out: number[] = []
  if (data.length === 0) return out
  const k = 2 / (period + 1)
  let prev = data[0]
  out.push(prev)
  for (let i = 1; i < data.length; i++) {
    prev = data[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

/** 标准差（样本，n-1） */
export function stdDev(data: number[]): number {
  if (data.length < 2) return 0
  const mean = data.reduce((a, b) => a + b, 0) / data.length
  const variance =
    data.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (data.length - 1)
  return Math.sqrt(variance)
}

export interface MACDResult {
  dif: number[]
  dea: number[]
  hist: number[] // 柱 = (dif - dea) * 2，与国内软件一致
}

/** MACD：EMA12 - EMA26 = DIF；DEA = EMA9(DIF)；柱 = (DIF-DEA)*2 */
export function macd(
  close: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): MACDResult {
  const emaFast = ema(close, fast)
  const emaSlow = ema(close, slow)
  const dif = close.map((_, i) => emaFast[i] - emaSlow[i])
  const dea = ema(dif, signal)
  const hist = dif.map((v, i) => (v - dea[i]) * 2)
  return { dif, dea, hist }
}

/** RSI（Wilder 平滑）。前 period 个位置为 null */
export function rsi(data: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(data.length).fill(null)
  if (data.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1]
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1]
    const g = diff > 0 ? diff : 0
    const l = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

export interface BollingerBands {
  upper: (number | null)[]
  middle: (number | null)[]
  lower: (number | null)[]
}

/** 布林带（周期 20，2 倍标准差） */
export function bollinger(
  close: number[],
  period = 20,
  k = 2,
): BollingerBands {
  const middle = sma(close, period)
  const upper: (number | null)[] = new Array(close.length).fill(null)
  const lower: (number | null)[] = new Array(close.length).fill(null)
  for (let i = period - 1; i < close.length; i++) {
    const window = close.slice(i - period + 1, i + 1)
    const sd = stdDev(window)
    upper[i] = (middle[i] as number) + k * sd
    lower[i] = (middle[i] as number) - k * sd
  }
  return { upper, middle, lower }
}

/** 在数组中取最近一个非 null 值 */
export function lastValid(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i] as number
  }
  return null
}

/** 收益率序列：data[i]/data[i-1] - 1，首元素为 0 */
export function returns(data: number[]): number[] {
  const out: number[] = new Array(data.length).fill(0)
  for (let i = 1; i < data.length; i++) {
    if (data[i - 1] !== 0) out[i] = data[i] / data[i - 1] - 1
  }
  return out
}

/** 简单波动率：最近 period 个对数收益的样本标准差 */
export function stdDevOfReturns(data: number[], period: number): number {
  const n = Math.min(period, data.length - 1)
  if (n < 2) return 0
  const rets = returns(data).slice(-n)
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1)
  return Math.sqrt(variance)
}

/** 年化波动率（%）：日波动率 × √252 */
export function annualizedVol(data: number[], period = 20): number {
  return stdDevOfReturns(data, period) * Math.sqrt(252) * 100
}
