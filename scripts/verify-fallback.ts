/** 数据源降级验证：东财 clist 失败时自动切新浪（直接请求代理验证） */
const PROXY = 'http://127.0.0.1:8787'

async function fetchSinaDirect() {
  const res = await fetch(PROXY + '/sina-list?nodes=sh_a,sz_a')
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const data = await res.json()
  const diff = (data.data?.diff ?? []) as any[]
  return diff.map((d) => ({
    code: String(d.code),
    name: String(d.name ?? ''),
    market: (d.market ?? (String(d.code).startsWith('6') ? 'sh' : 'sz')) as 'sh' | 'sz' | 'bj',
    price: d.price !== undefined ? Number(d.price) : undefined,
    changePct: d.changePct !== undefined ? Number(d.changePct) : undefined,
    totalMv: d.totalMv !== undefined ? Number(d.totalMv) : undefined,
    pe: d.pe !== undefined ? Number(d.pe) : undefined,
    turnoverRate: d.turnoverRate !== undefined ? Number(d.turnoverRate) : undefined,
  }))
}

console.log('=== 新浪降级数据源验证（真实数据） ===')
try {
  const list = await fetchSinaDirect()
  console.log(`  共 ${list.length} 只`)
  if (list.length > 0) {
    const s = list[0]
    console.log(`  样例: ${s.code} ${s.name} 价=${s.price} 涨=${s.changePct}% 换手=${s.turnoverRate} PE=${s.pe}`)
    const hasPrice = list.filter((x) => x.price !== undefined).length
    console.log(`  有价格: ${hasPrice}/${list.length} ${hasPrice > list.length * 0.9 ? '✅' : '❌'}`)
    const hasMv = list.filter((x) => x.totalMv !== undefined).length
    console.log(`  有市值: ${hasMv}/${list.length} ${hasMv > list.length * 0.5 ? '✅' : '❌'}`)
  }
  console.log(list.length > 4000 ? '\n✅ 新浪降级数据源验证通过' : '\n❌ 数据不足')
} catch (e) {
  console.log('  ⚠ 新浪不可用:', (e as Error).message)
}
