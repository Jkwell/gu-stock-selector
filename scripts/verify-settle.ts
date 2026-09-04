/**
 * 今日推荐闭环结算引擎验证脚本（纯合成数据，无需 proxy）
 * 运行：npx tsx scripts/verify-settle.ts
 */
import { settlePick, SETTLE_WINDOW_DAYS } from '../src/engine/settle'
import type { Kline } from '../src/types'

let pass = true
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) pass = false
}

/** 构造日 K：每天开=收=close，可指定 high/low 覆盖 */
function mk(
  dates: string[],
  closes: number[],
  overrides: Array<{ high: number; low: number }> = [],
): Kline[] {
  return dates.map((date, i) => {
    const c = closes[i]
    const o = overrides[i]
    return {
      date,
      open: c,
      close: c,
      high: o?.high ?? c,
      low: o?.low ?? c,
      volume: 10000,
      amount: 0,
    }
  })
}

console.log('=== 1. 先触止盈 ===')
{
  const kl = mk(
    ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'],
    [10, 10, 10, 10, 10, 10],
    [
      { high: 10, low: 10 },
      { high: 11.2, low: 10 }, // 次日触及止盈 11
      { high: 11, low: 10 },
      { high: 11, low: 10 },
      { high: 11, low: 10 },
      { high: 11, low: 10 },
    ],
  )
  const s = settlePick({
    entryPrice: 10, stopLoss: 9, takeProfit: 11, recommendDate: '2026-08-03', klines: kl,
  })
  check('5 日内先触止盈 → take_profit', s.status === 'take_profit', JSON.stringify(s))
  check('止盈 exitPrice = takeProfit', s.exitPrice === 11)
  check('止盈 exitDate = 触发日', s.exitDate === '2026-08-04')
  check('止盈 pct = +10%', s.pct === 10, `pct=${s.pct}`)
  check('barsUsed = 1', s.barsUsed === 1)
}

console.log('\n=== 2. 先触止损 ===')
{
  const kl = mk(
    ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'],
    [10, 10, 10, 10, 10, 10],
    [
      { high: 10, low: 10 },
      { high: 10, low: 9.5 }, // 次日触及止损 9.5
      { high: 10, low: 9.5 },
      { high: 10, low: 9.5 },
      { high: 10, low: 9.5 },
      { high: 10, low: 9.5 },
    ],
  )
  const s = settlePick({
    entryPrice: 10, stopLoss: 9.5, takeProfit: 11, recommendDate: '2026-08-03', klines: kl,
  })
  check('先触止损 → stop_loss', s.status === 'stop_loss', JSON.stringify(s))
  check('止损 exitPrice = stopLoss', s.exitPrice === 9.5)
  check('止损 pct = -5%', s.pct === -5, `pct=${s.pct}`)
}

console.log('\n=== 3. 窗口满未触发 → 持有（按窗口末收盘） ===')
{
  const kl = mk(
    ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'],
    [10, 10, 10, 10, 10, 10.5],
  )
  const s = settlePick({
    entryPrice: 10, stopLoss: 9, takeProfit: 11, recommendDate: '2026-08-03', klines: kl,
  })
  check('窗口满未触发 → holding', s.status === 'holding', JSON.stringify(s))
  check('持有 exitPrice = 窗口末收盘', s.exitPrice === 10.5)
  check('持有 exitDate = 窗口末', s.exitDate === '2026-08-10')
  check('持有 pct = +5%', s.pct === 5, `pct=${s.pct}`)
  check('barsUsed = 窗口长度', s.barsUsed === SETTLE_WINDOW_DAYS)
}

console.log('\n=== 4. 同日触止盈又触止损 → 止损优先（保守） ===')
{
  const kl = mk(
    ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'],
    [10, 10, 10, 10, 10],
    [
      { high: 10, low: 10 },
      { high: 11.2, low: 9.4 }, // 同日 high≥11 且 low≤9.5
      { high: 10, low: 10 },
      { high: 10, low: 10 },
      { high: 10, low: 10 },
    ],
  )
  const s = settlePick({
    entryPrice: 10, stopLoss: 9.5, takeProfit: 11, recommendDate: '2026-08-03', klines: kl,
  })
  check('同日双触发 → stop_loss（止损优先）', s.status === 'stop_loss', JSON.stringify(s))
  check('exitPrice = 止损价', s.exitPrice === 9.5)
}

console.log('\n=== 5. 推荐日为周末/不在 K 线 → 锚到最近 ≤ 推荐日 的交易日 ===')
{
  const kl = mk(
    ['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'],
    [10, 10, 10, 10, 10, 10],
    [
      { high: 10, low: 10 },
      { high: 10, low: 10 },
      { high: 11.2, low: 10 }, // 从推荐日后的第一个交易日 8/10 起算，8/10 触及
      { high: 11, low: 10 },
      { high: 11, low: 10 },
      { high: 11, low: 10 },
    ],
  )
  const s = settlePick({
    entryPrice: 10, stopLoss: 9, takeProfit: 11, recommendDate: '2026-08-08', klines: kl,
  })
  check('推荐日周末 → 从最近 ≤ 推荐日(8/7)的次日起算', s.status === 'take_profit', JSON.stringify(s))
  check('exitDate = 8/10', s.exitDate === '2026-08-10')
}

console.log('\n=== 6. 推荐日是 K 线最后一根（无未来数据） → pending ===')
{
  const kl = mk(['2026-08-03', '2026-08-04'], [10, 10])
  const s = settlePick({
    entryPrice: 10, stopLoss: 9, takeProfit: 11, recommendDate: '2026-08-04', klines: kl,
  })
  check('推荐日为末根 → pending', s.status === 'pending', JSON.stringify(s))
}

console.log('\n=== 7. 窗口不足 5 根未触发 → pending ===')
{
  const kl = mk(
    ['2026-08-03', '2026-08-04', '2026-08-05'],
    [10, 10, 10],
  )
  const s = settlePick({
    entryPrice: 10, stopLoss: 9, takeProfit: 11, recommendDate: '2026-08-03', klines: kl,
  })
  check('窗口不足且未触发 → pending', s.status === 'pending', JSON.stringify(s))
  check('barsUsed = 已有根数', s.barsUsed === 2)
}

console.log('\n=== 8. 旧记录兼容（UTC 前一天日期） ===')
{
  const kl = mk(
    ['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'],
    [10, 10, 10, 10, 10, 10],
    [
      { high: 10, low: 10 },
      { high: 10, low: 10 },
      { high: 10, low: 9.4 }, // 次日（8/4）触止损
      { high: 10, low: 9.5 },
      { high: 10, low: 9.5 },
      { high: 10, low: 9.5 },
    ],
  )
  // 记录日比实际推荐日晚一天（UTC 偏移的历史数据）
  const s = settlePick({
    entryPrice: 10, stopLoss: 9.5, takeProfit: 11, recommendDate: '2026-08-03', klines: kl,
  })
  check('UTC 偏移记录仍正确结算（从 8/4 起算）', s.status === 'stop_loss', JSON.stringify(s))
  check('exitDate = 8/4', s.exitDate === '2026-08-04')
}

console.log('\n=== 9. 新股：K 线不覆盖推荐日 → pending ===')
{
  const kl = mk(['2026-08-10', '2026-08-11', '2026-08-12'], [10, 10, 10])
  const s = settlePick({
    entryPrice: 10, stopLoss: 9, takeProfit: 11, recommendDate: '2026-08-03', klines: kl,
  })
  check('K 线全在推荐日之后 → pending', s.status === 'pending', JSON.stringify(s))
}

console.log('\n' + (pass ? '✅ 全部通过' : '❌ 存在失败'))
if (!pass) process.exit(1)
