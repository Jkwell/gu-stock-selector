/// <reference lib="webworker" />
import { scoreStocks, type ScoringInput } from '../engine/factors'
import type { FactorDef, StockScore } from '../types'

/** Web Worker：在后台线程执行多因子打分，避免阻塞 UI */
self.onmessage = (e: MessageEvent<{ inputs: ScoringInput[]; factors: FactorDef[] }>) => {
  const { inputs, factors } = e.data
  try {
    const result: StockScore[] = scoreStocks(inputs, factors)
    self.postMessage({ ok: true, result })
  } catch (err) {
    self.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
