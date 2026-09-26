// Dev-only fixtures (VITE_MOCK=1). Shapes follow CONTRACTS.md; not bundled in production builds.
import type { Account, BagStatus, Category, Debt, PlanEntry, PlanItem, TxView } from './api'

let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
const BCV = 158.4, P2P = 205.3

const accounts: Account[] = [
  { id: 2, code: 'binance', name: 'Binance', currency: 'USDT', kind: 'synced' },
  { id: 3, code: 'mercantil', name: 'Mercantil', currency: 'VES', kind: 'ledger' },
  { id: 4, code: 'bdv', name: 'Banco de Venezuela', currency: 'VES', kind: 'ledger' },
  { id: 5, code: 'cash_usd', name: 'Efectivo USD', currency: 'USD', kind: 'ledger' },
  { id: 6, code: 'cash_ves', name: 'Efectivo Bs', currency: 'VES', kind: 'ledger' },
  { id: 7, code: 'zelle', name: 'Zelle', currency: 'USD', kind: 'ledger' },
]
const cats: Category[] = [
  { id: 1, name: 'Comida', parentId: null, emoji: '🍔', path: 'Comida' },
  { id: 2, name: 'Mercado', parentId: 1, emoji: '🛒', path: 'Comida › Mercado' },
  { id: 3, name: 'Panadería', parentId: 1, emoji: '🥐', path: 'Comida › Panadería' },
  { id: 4, name: 'Transporte', parentId: null, emoji: '🚕', path: 'Transporte' },
  { id: 5, name: 'Servicios', parentId: null, emoji: '💡', path: 'Servicios' },
  { id: 6, name: 'Salud', parentId: null, emoji: '💊', path: 'Salud' },
  { id: 7, name: 'Ocio', parentId: null, emoji: '🎬', path: 'Ocio' },
  { id: 8, name: 'Casa', parentId: null, emoji: '🏠', path: 'Casa' },
  { id: 9, name: 'Otros', parentId: null, emoji: '📦', path: 'Otros' },
]
const merchants: [string, number][] = [
  ['Farmatodo', 6], ['Central Madeirense', 2], ['Panadería La Mansión', 3], ['Yummy', 4], ['Ridery', 4],
  ['Cantv', 5], ['Corpoelec', 5], ['Cines Unidos', 7], ['Gama Express', 2], ['EPA', 8], ['Pollos Arturo', 1],
]
const sources = ['manual_text', 'manual_voice', 'card_delta', 'pay', 'manual_voice', 'manual_text']

const now = Date.now()
let txs: TxView[] = []
for (let i = 0; i < 140; i++) {
  const at = new Date(now - rnd() * 60 * 864e5)
  at.setUTCHours(12 + Math.floor(rnd() * 13) - 4 + 4, Math.floor(rnd() * 60))
  if (at.getTime() > now) at.setTime(now - rnd() * 36e5 * 5)
  const [merchant, categoryId] = pick(merchants)
  const acc = pick([accounts[1], accounts[2], accounts[3], accounts[0], accounts[4]])
  const usd = Math.round((2 + rnd() * rnd() * 60) * 100) / 100
  const ves = acc.currency === 'VES'
  const src = acc.code === 'binance' ? pick(['card_delta', 'pay']) : pick(sources.filter((s) => s !== 'card_delta' && s !== 'pay'))
  const pending = rnd() < 0.08
  txs.push(tx(i + 1, at, {
    type: 'expense', status: pending ? 'pending' : 'confirmed', amount: ves ? Math.round(usd * P2P * 100) / 100 : usd,
    currency: acc.currency, amountUsd: usd, fxRate: ves ? P2P : null, fxSource: ves ? 'bag' : null,
    fromAccountId: acc.id, fromAccount: acc, categoryId, category: cats.find((c) => c.id === categoryId)!, merchant,
    source: src,
  }))
}
for (let w = 0; w < 8; w++) {
  const at = new Date(now - (w * 7 + 1) * 864e5)
  txs.push(tx(500 + w, at, {
    type: 'transfer', status: 'confirmed', amount: 150, currency: 'USDT', amountUsd: 150, toAmount: 150 * P2P,
    fromAccountId: 2, fromAccount: accounts[0], toAccountId: 3, toAccount: accounts[1], source: 'p2p', fxRate: P2P, fxSource: 'p2p_avg',
  }))
  txs.push(tx(600 + w, new Date(at.getTime() + 1000), {
    type: 'fee', status: 'confirmed', amount: 0.3, currency: 'USDT', amountUsd: 0.3, fromAccountId: 2, fromAccount: accounts[0], source: 'p2p',
  }))
}
txs.push(tx(900, new Date(now - 2 * 36e5), {
  type: 'expense', status: 'pending', amount: 3420, currency: 'VES', amountUsd: 16.66, fromAccountId: 3, fromAccount: accounts[1],
  source: 'reconcile', merchant: null, note: 'Diferencia de conciliación',
}))
txs.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
let debts: Debt[] = [
  { id: 1, name: 'Préstamo de Juan', currency: 'USD', amount: 200, note: null, createdAt: new Date(now - 20 * 864e5).toISOString(), paid: 50, remaining: 150, remainingUsd: 150, payments: 1 },
  { id: 2, name: 'Tarjeta Mercantil', currency: 'VES', amount: 40000, note: null, createdAt: new Date(now - 40 * 864e5).toISOString(), paid: 40000, remaining: 0, remainingUsd: 0, payments: 3 },
]

// Randy's sheet (USDT). [name, emoji, kind, amount, dueDay, dueDayEnd, paid this month (null = not yet)]
const planRows: [string, string, 'bill' | 'envelope', number, number | null, number | null, number | null][] = [
  ['Alquiler', '🔑', 'bill', 300, 1, 5, 300], ['Almuerzos', '🍴', 'envelope', 100, null, null, 64], ['Mercado', '🛒', 'envelope', 200, null, null, 171],
  ['Gasolina', '⛽', 'envelope', 70, null, null, 38], ['Starlink', '🛰️', 'bill', 55, 28, null, null], ['Internet', '🌐', 'bill', 25, 15, null, 25],
  ['Movistar', '📱', 'bill', 10, 20, null, 10], ['Digitel', '📱', 'bill', 10, 20, null, null], ['Minecraft', '🎮', 'bill', 22, 3, null, 22],
  ['Google One', '☁️', 'bill', 10, 12, null, 10], ['Odontólogo', '🦷', 'bill', 80, null, null, null], ['Gatos', '🐱', 'envelope', 60, null, null, 71],
  ['Lavada de carro', '🚿', 'bill', 10, null, null, 10], ['Luz', '💡', 'bill', 15, 22, 25, 18.2], ['Corte de cabello', '💈', 'bill', 10, null, null, null],
]
let planItems: PlanItem[] = planRows.map(([name, emoji, kind, amount, dueDay, dueDayEnd], i) => ({
  id: i + 1, name, emoji, kind, amount, currency: 'USDT', dueDay, dueDayEnd, remindDays: 1, categoryId: null, accountId: kind === 'bill' ? 2 : null, note: null, active: true, sort: i + 1,
}))
const planPaid = new Map(planRows.map((r, i) => [i + 1, r[6]]))
const planSkipped = new Set<number>()
function planMonth(month: string) {
  const today = new Date(now - 4 * 36e5).toISOString().slice(0, 10), cur = today.slice(0, 7)
  const [y, mo] = month.split('-').map(Number), days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  const elapsed = month < cur ? days : month > cur ? 0 : +today.slice(8)
  const d = (n: number) => `${month}-${String(Math.min(n, days)).padStart(2, '0')}`
  const entries: PlanEntry[] = planItems.filter((i) => i.active).map((i) => {
    const planned = Number(i.amount), spent = month === cur ? planPaid.get(i.id) ?? 0 : month < cur ? planned * (0.85 + rnd() * 0.3) : 0
    const skipped = month === cur && planSkipped.has(i.id)
    const dueFrom = i.dueDay ? d(i.dueDay) : null, dueTo = i.dueDay ? d(Math.max(i.dueDay, i.dueDayEnd ?? i.dueDay)) : null
    const status = skipped ? 'skipped' : spent <= 0 ? 'pending' : i.kind === 'bill' ? (spent >= planned * 0.9 ? 'paid' : 'partial') : spent > planned ? 'over' : 'partial'
    const toStart = dueFrom ? Math.round((Date.parse(dueFrom) - Date.parse(today)) / 864e5) : 0, toEnd = dueTo ? Math.round((Date.parse(dueTo) - Date.parse(today)) / 864e5) : 0
    const dueLabel = !dueFrom ? 'sin fecha' : toStart > 0 ? (toStart === 1 ? 'vence mañana' : `vence el ${dueFrom.slice(8)}/${dueFrom.slice(5, 7)} (en ${toStart} días)`) : toEnd === 0 ? 'vence hoy' : toEnd > 0 ? `tienes hasta el ${dueTo!.slice(8)}/${dueTo!.slice(5, 7)}` : `venció hace ${-toEnd} día${toEnd === -1 ? '' : 's'}`
    const pace = elapsed >= 7 && elapsed < days ? (spent / elapsed) * days : spent
    const forecastUsd = skipped ? 0 : elapsed >= days ? spent : i.kind === 'bill' ? (status === 'paid' ? spent : Math.max(planned, spent)) : elapsed < 7 ? Math.max(planned, spent) : Math.max(spent, pace)
    return {
      id: i.id, itemId: i.id, month, name: i.name, emoji: i.emoji, kind: i.kind, categoryId: null, accountId: i.accountId, note: null, currency: i.currency,
      planned, plannedUsd: planned, spent, spentUsd: spent, diff: spent - planned, diffUsd: spent - planned, status, dueFrom, dueTo, dueLabel, remindDays: i.remindDays,
      overridden: false, skipped, remindedOn: null, snoozeUntil: null, forecastUsd, expectedUsd: i.kind === 'envelope' ? (planned * elapsed) / days : dueTo && dueTo <= today ? planned : 0,
      avgUsd: i.name === 'Luz' ? 17.4 : planned, itemAmount: planned,
      txs: spent > 0 ? [{ id: 1000 + i.id, occurredAt: new Date(now - 3 * 864e5).toISOString(), amount: i.name === 'Luz' ? 3736 : spent, currency: i.name === 'Luz' ? 'VES' : 'USDT', amountUsd: spent, merchant: i.name, status: 'confirmed', linked: i.kind === 'bill' }] : [],
    } as PlanEntry
  })
  const live = entries.filter((e) => !e.skipped), sumBy = (xs: PlanEntry[], f: (e: PlanEntry) => number) => xs.reduce((s, e) => s + f(e), 0)
  const unplannedUsd = month > cur ? 0 : 46.3
  const spentUsd = sumBy(entries, (e) => e.spentUsd), forecastUsd = sumBy(entries, (e) => e.forecastUsd), unplannedForecastUsd = elapsed >= 7 && elapsed < days ? (unplannedUsd / elapsed) * days : unplannedUsd
  return {
    month, label: new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString('es-VE', { month: 'long', year: 'numeric', timeZone: 'UTC' }), days, elapsed, today, isCurrent: month === cur, rate: P2P,
    totals: {
      plannedUsd: sumBy(live, (e) => e.plannedUsd), spentUsd, forecastUsd, leftUsd: sumBy(live, (e) => Math.max(0, e.plannedUsd - e.spentUsd)), unplannedUsd, unplannedForecastUsd,
      allSpentUsd: spentUsd + unplannedUsd, allForecastUsd: forecastUsd + unplannedForecastUsd,
      bills: live.filter((e) => e.kind === 'bill').length, billsPaid: live.filter((e) => e.kind === 'bill' && e.status === 'paid').length,
    },
    unplanned: month > cur ? [] : [{ label: '🎉 Ocio', total: 28.5, count: 3 }, { label: '💊 Salud', total: 17.8, count: 1 }],
    entries,
  }
}

function tx(id: number, at: Date, p: Partial<TxView>): TxView {
  return {
    id, type: 'expense', status: 'confirmed', occurredAt: at.toISOString(), amount: 0, currency: 'USD', amountUsd: null,
    fxRate: null, fxSource: null, fromAccountId: null, toAccountId: null, toAmount: null, categoryId: null, merchant: null,
    note: null, source: 'manual_text', bagId: null, debtId: null, planEntryId: null, confidence: null,
    createdAt: at.toISOString(), updatedAt: at.toISOString(), category: null, fromAccount: null, toAccount: null, ...p,
  }
}

const spend = (t: TxView) => (t.type === 'expense' || t.type === 'fee') && t.status !== 'void'
const inRange = (t: TxView, q: URLSearchParams) =>
  (!q.get('from') || t.occurredAt >= q.get('from')!) && (!q.get('to') || t.occurredAt <= q.get('to')!)
const sum = (xs: TxView[]) => xs.reduce((s, t) => s + Number(t.amountUsd ?? 0), 0)
const sinceDays = (d: number) => txs.filter((t) => spend(t) && Date.now() - +new Date(t.occurredAt) < d * 864e5)
const delay = () => new Promise((r) => setTimeout(r, 150 + rnd() * 250))

export async function mock(path: string, init: RequestInit): Promise<unknown> {
  await delay()
  const [p, qs] = path.split('?')
  const q = new URLSearchParams(qs)
  const body = init.body ? JSON.parse(String(init.body)) : {}
  const m = init.method ?? 'GET'
  let r: RegExpMatchArray | null

  if (p === '/overview') {
    const spark = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(now - (29 - i) * 864e5).toISOString().slice(0, 10)
      return { date: d, total: sum(txs.filter((t) => spend(t) && t.occurredAt.slice(0, 10) === d)) }
    })
    return {
      netWorthUsd: 2843.17, debtsUsd: 150, today: sum(sinceDays(1)), week: sum(sinceDays(7)), month: sum(sinceDays(22)), lastMonth: 812.4,
      pending: txs.filter((t) => t.status === 'pending').length,
      rates: { bcv: BCV, p2p: P2P, market: P2P + 3 }, spark,
    }
  }
  if (p === '/transactions' && m === 'GET') {
    let xs = txs.filter((t) => inRange(t, q))
    const f = (k: string, fn: (t: TxView, v: string) => boolean) => { const v = q.get(k); if (v) xs = xs.filter((t) => fn(t, v)) }
    f('accountId', (t, v) => t.fromAccountId === +v || t.toAccountId === +v)
    f('categoryId', (t, v) => t.categoryId === +v || t.category?.parentId === +v)
    f('type', (t, v) => t.type === v)
    f('status', (t, v) => t.status === v)
    f('text', (t, v) => `${t.merchant} ${t.note} ${t.category?.name}`.toLowerCase().includes(v.toLowerCase()))
    const off = +(q.get('cursor') ?? 0), lim = +(q.get('limit') ?? 30)
    return { items: xs.slice(off, off + lim), nextCursor: off + lim < xs.length ? off + lim : null }
  }
  if ((r = p.match(/^\/transactions\/(\d+)(?:\/(\w+))?$/))) {
    const t = txs.find((x) => x.id === +r![1])!
    if (r[2] === 'void') t.status = 'void'
    else if (r[2] === 'confirm') t.status = 'confirmed'
    else if (r[2] === 'undo') t.status = 'confirmed'
    else Object.assign(t, body)
    t.category = cats.find((c) => c.id === t.categoryId) ?? null
    return { ...t }
  }
  if (p === '/accounts') {
    return accounts.map((a, i) => {
      const bal = [412.55, 2210.3, 48210.5, 12900, 140, 3500][i]
      return {
        accountId: a.id, code: a.code, name: a.name, currency: a.currency, kind: a.kind, balance: bal,
        balanceUsd: a.currency === 'VES' ? bal / P2P : bal, lastReconciledAt: a.kind === 'ledger' ? new Date(now - (i * 0.8 + 0.3) * 864e5).toISOString() : null,
      }
    })
  }
  if ((r = p.match(/^\/accounts\/(\d+)\/reconcile$/))) return { diff: -1250.5, tx: null }
  if (p === '/categories') return cats
  if (p === '/insights/summary') {
    const g = q.get('groupBy')
    const map = new Map<string, { key: string; label: string; total: number; count: number }>()
    for (const t of txs.filter((t) => spend(t) && inRange(t, q))) {
      const [key, label] = g === 'merchant' ? [t.merchant ?? '—', t.merchant ?? 'Sin comercio'] : g === 'account' ? [t.fromAccount?.code ?? '?', t.fromAccount?.name ?? '?']
        : [String(t.category?.parentId ?? t.categoryId ?? 0), cats.find((c) => c.id === (t.category?.parentId ?? t.categoryId))?.name ?? 'Sin categoría']
      const e = map.get(key) ?? { key, label, total: 0, count: 0 }
      e.total += Number(t.amountUsd ?? 0); e.count++
      map.set(key, e)
    }
    return [...map.values()]
  }
  if (p === '/insights/heatmap') {
    const map = new Map<string, number>()
    for (const t of txs.filter((t) => spend(t) && inRange(t, q))) {
      const d = new Date(+new Date(t.occurredAt) - 4 * 36e5)
      const k = `${d.getUTCDay()}-${d.getUTCHours()}`
      map.set(k, (map.get(k) ?? 0) + Number(t.amountUsd ?? 0))
    }
    return [...map].map(([k, total]) => { const [dow, hour] = k.split('-').map(Number); return { dow, hour, total } })
  }
  if (p === '/insights/rates') {
    return Array.from({ length: 90 }, (_, i) => ({
      date: new Date(now - (89 - i) * 864e5).toISOString().slice(0, 10),
      bcv: Math.round((BCV - (89 - i) * 0.45) * 100) / 100,
      p2p: i % 3 === 0 ? Math.round((P2P - (89 - i) * 0.7 + (rnd() - 0.5) * 6) * 100) / 100 : null,
      market: Math.round((P2P + 3 - (89 - i) * 0.7) * 100) / 100,
    }))
  }
  if (p === '/bags') {
    const bags: BagStatus[] = [0, 1, 2, 3].map((i) => {
      const amountVes = 150 * (P2P - i * 4), spent = amountVes * [0.35, 0.8, 1, 1][i]
      return {
        bag: { id: i + 1, p2pTransactionId: 500 + i, accountId: 3, amountVes, remainingVes: amountVes - spent, rate: P2P - i * 4,
          openedAt: new Date(now - (i * 7 + 1) * 864e5).toISOString(), closedAt: null, muted: false },
        account: 'Mercantil', spent, remaining: amountVes - spent, txs: txs.slice(i * 5, i * 5 + 3 + i),
      }
    })
    return q.get('openOnly') ? bags.filter((b) => b.remaining > 0) : bags
  }
  if (p === '/debts' && m === 'GET') return debts
  if (p === '/debts') { const d: Debt = { id: debts.length + 1, createdAt: new Date().toISOString(), note: null, ...body, paid: 0, remaining: body.amount, remainingUsd: body.currency === 'VES' ? body.amount / P2P : body.amount, payments: 0 }; debts.push(d); return d }
  if ((r = p.match(/^\/debts\/(\d+)$/))) { debts = debts.filter((d) => d.id !== +r![1]); return null }
  if (p === '/plan') return planMonth(q.get('month') || new Date(now - 4 * 36e5).toISOString().slice(0, 7))
  if (p === '/plan/items' && m === 'GET') return planItems
  if (p === '/plan/items') { const it: PlanItem = { id: planItems.length + 1, active: true, sort: planItems.length + 1, emoji: null, kind: 'bill', dueDay: null, dueDayEnd: null, remindDays: 1, categoryId: null, accountId: null, note: null, currency: 'USDT', amount: 0, name: '', ...body }; planItems.push(it); return it }
  if ((r = p.match(/^\/plan\/items\/(\d+)$/))) {
    const it = planItems.find((i) => i.id === +r![1])!
    if (m === 'DELETE') it.active = false; else Object.assign(it, body)
    return it
  }
  if ((r = p.match(/^\/plan\/entries\/(\d+)(?:\/(\w+))?$/))) {
    const id = +r[1], key = new Date(now - 4 * 36e5).toISOString().slice(0, 7)
    if (r[2] === 'pay') planPaid.set(id, (planPaid.get(id) ?? 0) + (body.currency === 'VES' ? body.amount / P2P : body.amount))
    else if (r[2] === 'unpay') planPaid.set(id, null)
    else if (body.skipped !== undefined) body.skipped ? planSkipped.add(id) : planSkipped.delete(id)
    const entry = planMonth(key).entries.find((e) => e.id === id)!
    return r[2] === 'pay' ? { tx: txs[0], entry } : entry
  }
  if (p === '/ask') {
    const qn = String(body.question).toLowerCase()
    if (qn.includes('ayer')) return {
      answer: 'Ayer gastaste $23,40 en 3 movimientos.',
      table: { columns: ['Comercio', 'Categoría', 'USD'], rows: [['Farmatodo', 'Salud', 12.5], ['Yummy', 'Transporte', 6.9], ['La Mansión', 'Panadería', 4]] },
    }
    if (qn.includes('vs')) return {
      answer: 'En Comida llevas $182 este mes vs $214 el mes pasado (−15%).',
      chart: { type: 'bar', data: [{ label: 'Mes pasado', value: 214 }, { label: 'Este mes', value: 182 }] },
    }
    return {
      answer: `Esta semana llevas $${sum(sinceDays(7)).toFixed(2).replace('.', ',')}. El día más caro fue el martes.`,
      chart: { type: 'line', data: ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((label) => ({ label, value: Math.round(rnd() * 40) })) },
    }
  }
  throw new Error(`mock: ${m} ${path} no implementado`)
}
