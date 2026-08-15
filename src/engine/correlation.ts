/** Pearson 相关系数 */
export function pearsonCorr(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 3) return 0
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY)
    dx += (xs[i] - meanX) ** 2
    dy += (ys[i] - meanY) ** 2
  }
  if (dx === 0 || dy === 0) return 0
  return num / Math.sqrt(dx * dy)
}

/** Spearman 秩相关系数（-1~1），处理并列取平均秩 */
export function spearmanRankCorr(xs: number[], ys: number[]): number {
  if (xs.length < 3) return 0
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const ranks = new Array<number>(arr.length)
    let i = 0
    while (i < idx.length) {
      let j = i
      while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++
      const avgRank = (i + j + 2) / 2 // 1-based 平均秩
      for (let k = i; k <= j; k++) ranks[idx[k].i] = avgRank
      i = j + 1
    }
    return ranks
  }
  return pearsonCorr(rank(xs), rank(ys))
}
