import { useState } from 'react'
import { api, num, type Balance, type Category, type PlanEntry, type PlanItem, type PlanItemInput, type PlanMonth } from '../api'
import { Card, Field, Loading, Seg, Sheet, btnCls, fmtCur, fmtDay, inputCls, parseNum, useLoad, useMoney, ymd } from '../ui'

// Months are "YYYY-MM" (Caracas); days "YYYY-MM-DD".
const thisMonth = () => ymd(new Date()).slice(0, 7)
const shift = (key: string, n: number) => {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5)
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const CURS: [string, string][] = [['USDT', 'USDT'], ['USD', 'USD'], ['VES', 'Bs']]
/** Plan amounts: USDT reads as dollars, no decimals when whole ($300, $18,20, 3.736 Bs). */
const pm = (v: number, cur: string, digits?: number) => fmtCur(v, cur === 'VES' ? 'VES' : 'USD', digits ?? (cur !== 'VES' && Math.abs(v % 1) < 0.005 ? 0 : undefined))
const catLabel = (c: Category) => `${c.emoji ? c.emoji + ' ' : ''}${c.path ?? c.name}`

type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'fg'
/** How urgent a bill is today. */
function billTone(e: PlanEntry, today: string): { tone: Tone; chip: string } {
  if (e.status === 'skipped') return { tone: 'muted', chip: 'Este mes no' }
  if (e.status === 'paid') return { tone: 'good', chip: 'Pagado' }
  if (e.dueTo && today > e.dueTo) return { tone: 'bad', chip: 'Vencido' }
  if (e.dueFrom && dayDiff(today, e.dueFrom) <= 3) return { tone: 'warn', chip: e.status === 'partial' ? 'Parcial' : today >= e.dueFrom ? 'Toca ya' : 'Pronto' }
  return { tone: 'muted', chip: e.status === 'partial' ? 'Parcial' : 'Pendiente' }
}
const TONE_TEXT: Record<Tone, string> = { good: 'text-good', warn: 'text-warn', bad: 'text-bad', muted: 'text-muted', fg: 'text-fg' }
const TONE_BG: Record<Tone, string> = { good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', muted: 'bg-muted', fg: 'bg-fg' }

export default function Plan() {
  const [month, setMonth] = useState(thisMonth)
  const { data, error, reload } = useLoad(() => api.plan(month), [month])
  const { data: cats } = useLoad(api.categories)
  const { data: accounts } = useLoad(api.accounts)
  const [open, setOpen] = useState<PlanEntry | null>(null)
  const [editing, setEditing] = useState<PlanItem | 'new' | null>(null)
  const [items, setItems] = useState<PlanItem[] | null>(null)

  const editItem = async (itemId: number) => {
    const list = items ?? await api.planItems()
    setItems(list)
    setEditing(list.find((i) => i.id === itemId) ?? null)
  }
  const done = () => { setOpen(null); setEditing(null); setItems(null); reload() }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button aria-label="Mes anterior" onClick={() => setMonth(shift(month, -1))} className="h-9 w-9 rounded-full bg-card text-xl leading-none active:bg-line">‹</button>
        <div className="text-center">
          <div className="text-[16px] font-semibold">{data ? cap(data.label) : '…'}</div>
          {month !== thisMonth() && <button onClick={() => setMonth(thisMonth())} className="text-[12px] font-medium text-accent">Volver a este mes</button>}
        </div>
        <button aria-label="Mes siguiente" onClick={() => setMonth(shift(month, 1))} className="h-9 w-9 rounded-full bg-card text-xl leading-none active:bg-line">›</button>
      </div>

      {!data ? <Loading error={error} /> : !data.entries.length ? (
        <Card>
          <div className="py-4 text-center text-[14px] text-muted">
            {month < thisMonth() ? 'No había plan este mes.' : 'Todavía no tienes plan. Agrega lo que pagas cada mes (alquiler, internet…) y lo que presupuestas (mercado, gasolina).'}
          </div>
          {month >= thisMonth() && <button onClick={() => setEditing('new')} className={`${btnCls} w-full bg-accent text-accent-fg`}>+ Agregar al plan</button>}
        </Card>
      ) : (
        <>
          <Summary m={data} />
          <Calendar m={data} onTap={setOpen} />
          <Bills m={data} onTap={setOpen} onAdd={() => setEditing('new')} />
          <Envelopes m={data} onTap={setOpen} />
          <Unplanned m={data} />
        </>
      )}

      {open && data && (
        <EntrySheet key={open.id} e={data.entries.find((x) => x.id === open.id) ?? open} m={data} accounts={accounts ?? []}
          onClose={() => setOpen(null)} onChanged={reload} onEditItem={() => editItem(open.itemId)} />
      )}
      {editing && (
        <ItemSheet item={editing === 'new' ? null : editing} cats={cats ?? []} accounts={accounts ?? []} onClose={() => setEditing(null)} onDone={done} />
      )}
    </div>
  )
}

// ── summary ──────────────────────────────────────────────────────────────────
function Summary({ m }: { m: PlanMonth }) {
  const $ = useMoney()
  const t = m.totals
  const expected = m.entries.filter((e) => !e.skipped).reduce((s, e) => s + e.expectedUsd, 0)
  const scale = Math.max(t.plannedUsd, t.allSpentUsd, t.allForecastUsd) || 1
  const over = t.allForecastUsd - t.plannedUsd
  const pctOf = (v: number) => `${Math.min(100, (v / scale) * 100)}%`
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[13px] font-medium text-muted">Presupuesto del mes</div>
        <div className="num text-[13px] text-muted">{t.billsPaid}/{t.bills} pagos hechos</div>
      </div>
      <div className="num mt-1 text-[32px] font-bold leading-tight tracking-tight">{$.usd(t.plannedUsd)}</div>

      <div className="relative mt-3 h-3 overflow-hidden rounded-full bg-line" role="img"
        aria-label={`Gastado ${$.usd(t.allSpentUsd)} de ${$.usd(t.plannedUsd)}; pronóstico ${$.usd(t.allForecastUsd)}`}>
        {m.isCurrent && <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--s1)] opacity-25" style={{ width: pctOf(t.allForecastUsd) }} />}
        <div className={`absolute inset-y-0 left-0 rounded-full ${t.allSpentUsd > t.plannedUsd ? 'bg-bad' : 'bg-[var(--s1)]'}`} style={{ width: pctOf(t.allSpentUsd) }} />
        <div className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: pctOf(t.plannedUsd) }} title="Presupuesto" />
        {m.isCurrent && expected > 0 && <div className="absolute inset-y-0 w-0.5 bg-muted" style={{ left: pctOf(expected) }} title="Lo esperado a hoy" />}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{m.isCurrent ? `día ${m.elapsed} de ${m.days}` : m.month < m.today.slice(0, 7) ? 'mes cerrado' : 'mes futuro'}</span>
        {m.isCurrent && expected > 0 && <span className="num">esperado a hoy {$.usd(expected, 0)}</span>}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <Stat label="Gastado" v={$.usd(t.allSpentUsd, 0)} sub={t.unplannedUsd > 0.005 ? `${$.usd(t.unplannedUsd, 0)} fuera` : undefined} />
        <Stat label={m.isCurrent ? 'Pronóstico' : m.month > m.today.slice(0, 7) ? 'Plan' : 'Real'} v={$.usd(m.isCurrent ? t.allForecastUsd : m.month > m.today.slice(0, 7) ? t.plannedUsd : t.allSpentUsd, 0)}
          sub={m.isCurrent && Math.abs(over) > 1 ? `${over > 0 ? '▲' : '▼'} ${$.usd(Math.abs(over), 0)}` : undefined} tone={m.isCurrent && over > 1 ? 'bad' : m.isCurrent && over < -1 ? 'good' : undefined} />
        <Stat label="Falta" v={$.usd(t.leftUsd, 0)} sub="por pagar/gastar" />
      </div>
    </Card>
  )
}

const Stat = ({ label, v, sub, tone }: { label: string; v: string; sub?: string; tone?: Tone }) => (
  <div className="min-w-0">
    <div className="text-[12px] font-medium text-muted">{label}</div>
    <div className="num truncate text-[17px] font-semibold">{v}</div>
    {sub && <div className={`num truncate text-[11px] ${tone ? TONE_TEXT[tone] : 'text-muted'}`}>{sub}</div>}
  </div>
)

// ── calendar: which bills fall on which days ─────────────────────────────────
function Calendar({ m, onTap }: { m: PlanMonth; onTap: (e: PlanEntry) => void }) {
  const bills = m.entries.filter((e) => e.kind === 'bill' && e.dueFrom && e.dueTo)
  if (!bills.length) return null
  const first = new Date(`${m.month}-01T12:00:00Z`).getUTCDay() // 0 = Sunday
  const lead = (first + 6) % 7 // week starts Monday
  const cells = [...Array(lead).fill(null), ...Array.from({ length: m.days }, (_, i) => `${m.month}-${String(i + 1).padStart(2, '0')}`)]
  const on = (d: string) => bills.filter((b) => b.dueFrom! <= d && d <= b.dueTo!)
  return (
    <Card title="Calendario de pagos">
      <div className="grid grid-cols-7 gap-1 text-center">
        {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => <div key={d} className="text-[11px] font-medium text-muted">{d}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`x${i}`} />
          const bs = on(d), today = d === m.today
          return (
            <button key={d} disabled={!bs.length} onClick={() => onTap(bs.find((b) => b.status !== 'paid' && b.status !== 'skipped') ?? bs[0])}
              aria-label={bs.length ? `${Number(d.slice(8))}: ${bs.map((b) => b.name).join(', ')}` : undefined}
              className={`flex h-10 flex-col items-center justify-center rounded-lg text-[13px] ${today ? 'bg-accent font-semibold text-accent-fg' : bs.length ? 'bg-line enabled:active:opacity-70' : 'text-muted'}`}>
              <span className="num leading-none">{Number(d.slice(8))}</span>
              {bs.length > 0 && (
                <span className="mt-1 flex gap-0.5">
                  {bs.slice(0, 3).map((b) => <span key={b.id} className={`h-1.5 w-1.5 rounded-full ${today ? 'bg-accent-fg' : TONE_BG[billTone(b, m.today).tone]}`} />)}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </Card>
  )
}

// ── bills ────────────────────────────────────────────────────────────────────
function Bills({ m, onTap, onAdd }: { m: PlanMonth; onTap: (e: PlanEntry) => void; onAdd: () => void }) {
  const rank = (e: PlanEntry) => (e.status === 'paid' ? 2 : e.status === 'skipped' ? 3 : 0)
  const bills = m.entries.filter((e) => e.kind === 'bill').sort((a, b) => rank(a) - rank(b) || (a.dueFrom ?? '9999').localeCompare(b.dueFrom ?? '9999'))
  return (
    <section>
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">Pagos</h2>
        <button onClick={onAdd} className="text-[14px] font-semibold text-accent">+ Agregar</button>
      </div>
      {!bills.length ? <div className="rounded-2xl bg-card px-4 py-5 text-center text-[14px] text-muted">Sin pagos fijos este mes.</div> : (
        <div className="overflow-hidden rounded-2xl bg-card">
          {bills.map((e, i) => {
            const { tone, chip } = billTone(e, m.today)
            const diff = e.status === 'paid' && Math.abs(e.diff) >= 0.01 * Math.max(1, e.planned)
            const sub = e.status === 'paid' ? `pagaste ${pm(e.spent, e.currency)}` : e.status === 'skipped' ? 'omitido este mes'
              : e.status === 'partial' ? `llevas ${pm(e.spent, e.currency)} · ${e.dueLabel}` : e.dueLabel
            return (
              <button key={e.id} onClick={() => onTap(e)} className={`flex w-full items-center gap-3 px-3 py-3 text-left active:bg-line ${i ? 'border-t border-line' : ''}`}>
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg ${e.status === 'paid' ? 'bg-good/15' : 'bg-line'}`}>
                  {e.status === 'paid' ? '✓' : e.emoji ?? '🧾'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[15px] font-medium ${e.status === 'skipped' ? 'text-muted line-through' : ''}`}>{e.name}</div>
                  <div className={`truncate text-[12px] ${tone === 'bad' || tone === 'warn' ? TONE_TEXT[tone] : 'text-muted'}`}>{sub}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="num text-[15px] font-semibold">{pm(e.planned, e.currency)}</div>
                  {diff ? <div className={`num text-[11px] font-semibold ${e.diff > 0 ? 'text-bad' : 'text-good'}`}>{e.diff > 0 ? '+' : '−'}{pm(Math.abs(e.diff), e.currency)}</div>
                    : <div className={`text-[11px] font-semibold ${TONE_TEXT[tone]}`}>{chip}</div>}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ── envelopes ────────────────────────────────────────────────────────────────
function Envelopes({ m, onTap }: { m: PlanMonth; onTap: (e: PlanEntry) => void }) {
  const envs = m.entries.filter((e) => e.kind === 'envelope')
  if (!envs.length) return null
  return (
    <section>
      <h2 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Presupuestos</h2>
      <div className="overflow-hidden rounded-2xl bg-card">
        {envs.map((e, i) => {
          const scale = Math.max(e.plannedUsd, e.spentUsd, 0.01)
          const over = e.status === 'over'
          const pace = m.isCurrent && e.forecastUsd > e.plannedUsd * 1.05 && !over
          const left = e.planned - e.spent
          return (
            <button key={e.id} onClick={() => onTap(e)} className={`block w-full px-4 py-3 text-left active:bg-line ${i ? 'border-t border-line' : ''}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={`truncate text-[15px] font-medium ${e.skipped ? 'text-muted line-through' : ''}`}>{e.emoji ? `${e.emoji} ` : ''}{e.name}</span>
                <span className="num shrink-0 text-[14px]"><b className={over ? 'text-bad' : ''}>{pm(e.spent, e.currency, 0)}</b><span className="text-muted"> / {pm(e.planned, e.currency, 0)}</span></span>
              </div>
              <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`${e.name}: gastado`}
                aria-valuenow={Math.round((e.spentUsd / Math.max(e.plannedUsd, 0.01)) * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className={`h-full rounded-full ${over ? 'bg-bad' : pace ? 'bg-warn' : 'bg-good'}`} style={{ width: `${Math.min(100, (e.spentUsd / scale) * 100)}%` }} />
                {m.isCurrent && <div className="absolute inset-y-0 w-0.5 bg-fg/60" style={{ left: `${Math.min(100, (e.expectedUsd / scale) * 100)}%` }} />}
              </div>
              <div className={`num mt-1 text-[12px] ${over ? 'text-bad' : pace ? 'text-warn' : 'text-muted'}`}>
                {e.skipped ? 'omitido este mes' : over ? `te pasaste ${pm(-left, e.currency, 0)}` : `quedan ${pm(left, e.currency, 0)}`}
                {m.isCurrent && !e.skipped && m.elapsed >= 7 && ` · a este ritmo ${pm(e.forecastUsd * (e.planned / Math.max(e.plannedUsd, 0.01)), e.currency, 0)}`}
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function Unplanned({ m }: { m: PlanMonth }) {
  const $ = useMoney()
  if (m.totals.unplannedUsd < 0.005) return null
  return (
    <Card title="Fuera del plan" action={<span className="num text-[15px] font-semibold">{$.usd(m.totals.unplannedUsd)}</span>}>
      <div className="space-y-1.5">
        {m.unplanned.slice(0, 6).map((u) => (
          <div key={u.label} className="flex justify-between gap-3 text-[14px]">
            <span className="truncate">{u.label} <span className="text-muted">· {u.count}</span></span>
            <span className="num shrink-0">{$.usd(u.total)}</span>
          </div>
        ))}
      </div>
      {m.isCurrent && m.totals.unplannedForecastUsd > m.totals.unplannedUsd + 1 && (
        <div className="num mt-2 text-[12px] text-muted">A este ritmo, {$.usd(m.totals.unplannedForecastUsd, 0)} al cierre del mes.</div>
      )}
    </Card>
  )
}

// ── one line of the month ────────────────────────────────────────────────────
function EntrySheet({ e, m, accounts, onClose, onChanged, onEditItem }: {
  e: PlanEntry; m: PlanMonth; accounts: Balance[]; onClose: () => void; onChanged: () => void; onEditItem: () => void
}) {
  const $ = useMoney()
  const acc = accounts.find((a) => a.accountId === e.accountId)
  const left = e.planned - e.spent > 0.005 ? e.planned - e.spent : e.planned
  const [pay, setPay] = useState({ amount: String(Math.round(left * 100) / 100), currency: acc && acc.currency !== e.currency && !(acc.currency === 'USD' && e.currency === 'USDT') ? acc.currency : e.currency, accountId: e.accountId ? String(e.accountId) : '' })
  const [planned, setPlanned] = useState(String(e.planned))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const bill = e.kind === 'bill'
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null)
    try { await fn(); setMsg(ok); onChanged() } catch (err: any) { setMsg('Error: ' + err.message) } finally { setBusy(false) }
  }
  const estimate = pay.currency === 'VES' && e.currency !== 'VES' && m.rate ? left * m.rate : pay.currency !== 'VES' && e.currency === 'VES' && m.rate ? left / m.rate : null
  const accOpts = accounts.filter((a) => a.currency === pay.currency || (pay.currency !== 'VES' && a.currency !== 'VES'))
  const linked = e.txs.some((t) => t.linked)
  const future = m.month > m.today.slice(0, 7)

  return (
    <Sheet open onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-muted">{bill ? 'Pago' : 'Presupuesto'} · {cap(m.label)}{e.overridden ? ' · ajustado este mes' : ''}</div>
          <div className="truncate text-[22px] font-bold">{e.emoji ? `${e.emoji} ` : ''}{e.name}</div>
          {bill && <div className="text-[13px] text-muted">{e.dueFrom ? cap(e.dueLabel) : 'Sin fecha fija'}</div>}
        </div>
        {bill && (() => { const { tone, chip } = billTone(e, m.today); return <span className={`shrink-0 rounded-full bg-line px-2.5 py-1 text-[12px] font-semibold ${TONE_TEXT[tone]}`}>{chip}</span> })()}
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-2xl bg-card p-3">
        <Stat label="Planificado" v={pm(e.planned, e.currency)} sub={e.currency !== 'USD' && e.currency !== 'USDT' ? `≈ ${$.usd(e.plannedUsd)}` : undefined} />
        <Stat label={bill ? 'Pagado' : 'Gastado'} v={pm(e.spent, e.currency)} />
        <Stat label="Diferencia" v={`${e.diff > 0 ? '+' : e.diff < 0 ? '−' : ''}${pm(Math.abs(e.diff), e.currency)}`}
          tone={e.spent > 0 ? (e.diff > 0.005 ? 'bad' : 'good') : undefined} sub={e.spent > 0 ? (e.diff > 0.005 ? 'de más' : e.diff < -0.005 ? 'de menos' : 'exacto') : 'aún nada'} />
      </div>
      {e.avgUsd != null && (
        <div className="mt-2 flex items-center justify-between gap-2 px-1 text-[13px] text-muted">
          <span>Promedio real (3 meses): <b className="num text-fg">{$.usd(e.avgUsd)}</b></span>
        </div>
      )}

      {e.txs.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 px-1 text-[12px] font-medium text-muted">{bill ? 'Pagos' : 'Gastos'} de este mes</div>
          <div className="overflow-hidden rounded-2xl bg-card">
            {e.txs.map((t, i) => (
              <div key={t.id} className={`flex items-center justify-between gap-3 px-3 py-2.5 text-[14px] ${i ? 'border-t border-line' : ''}`}>
                <div className="min-w-0">
                  <div className="truncate">{t.merchant ?? '—'}{t.status === 'pending' && <span className="ml-1 text-[11px] font-semibold text-warn">pendiente</span>}</div>
                  <div className="text-[11px] text-muted">{fmtDay(t.occurredAt)} · {t.linked ? 'enlazado' : bill ? 'detectado por el comercio' : 'por categoría'}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="num font-semibold">{pm(t.amount, t.currency)}</div>
                  {t.currency === 'VES' && t.amountUsd != null && <div className="num text-[11px] text-muted">≈ {fmtCur(t.amountUsd, 'USD')}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {bill && !e.skipped && e.status !== 'paid' && (
        <div className="mt-4 space-y-3">
          <div className="text-[14px] font-semibold">{e.status === 'partial' ? 'Registrar otro pago' : '¿Ya lo pagaste?'}</div>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Cuánto pagaste">
              <input inputMode="decimal" value={pay.amount} onChange={(x) => setPay({ ...pay, amount: x.target.value })} className={inputCls + ' num'} />
            </Field>
            <Field label="Moneda">
              <select value={pay.currency} onChange={(x) => {
                const c = x.target.value
                const est = c === e.currency || (c !== 'VES' && e.currency !== 'VES') ? left : m.rate ? (c === 'VES' ? left * m.rate : left / m.rate) : left
                setPay({ ...pay, currency: c, amount: String(Math.round(est * 100) / 100), accountId: accounts.find((a) => String(a.accountId) === pay.accountId && (a.currency === c || (c !== 'VES' && a.currency !== 'VES'))) ? pay.accountId : '' })
              }} className={inputCls}>
                {CURS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
          </div>
          {estimate != null && <div className="num -mt-1 px-1 text-[12px] text-muted">A la tasa de hoy ({m.rate?.toLocaleString('es-VE')}) serían ~{pm(estimate, pay.currency)}</div>}
          <Field label="Desde">
            <select value={pay.accountId} onChange={(x) => setPay({ ...pay, accountId: x.target.value })} className={inputCls}>
              <option value="">Elegir después (queda pendiente)</option>
              {accOpts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}
            </select>
          </Field>
          <button disabled={busy || !(parseNum(pay.amount) > 0)} className={`${btnCls} w-full bg-accent text-accent-fg`}
            onClick={() => run(() => api.payPlanEntry(e.id, { amount: parseNum(pay.amount), currency: pay.currency, accountId: pay.accountId ? +pay.accountId : null }), 'Pago registrado ✓')}>
            ✓ Marcar pagado
          </button>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="Monto planificado solo este mes">
            <input inputMode="decimal" value={planned} onChange={(x) => setPlanned(x.target.value)} className={inputCls + ' num'} />
          </Field>
          <button disabled={busy || !(parseNum(planned) > 0) || parseNum(planned) === e.planned} onClick={() => run(() => api.patchPlanEntry(e.id, { planned: parseNum(planned) }), 'Ajustado para este mes')}
            className={`${btnCls} bg-card`}>Ajustar</button>
        </div>
        {e.avgUsd != null && Math.abs(e.avgUsd - e.plannedUsd) > 0.5 && (e.currency === 'USD' || e.currency === 'USDT') && (
          <button disabled={busy} onClick={() => run(() => api.updatePlanItem(e.itemId, { amount: Math.round(e.avgUsd! * 100) / 100 }), 'Plantilla actualizada al promedio')}
            className="w-full rounded-xl bg-card px-4 py-2.5 text-[14px] font-medium text-accent active:opacity-70">
            Usar el promedio real ({pm(e.avgUsd, e.currency)}) desde este mes
          </button>
        )}
      </div>

      {msg && <div className="mt-3 text-center text-[13px] text-muted">{msg}</div>}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button disabled={busy} onClick={() => run(() => api.patchPlanEntry(e.id, { skipped: !e.skipped }), e.skipped ? 'Reactivado' : 'Omitido este mes')} className={`${btnCls} bg-card`}>
          {e.skipped ? '↺ Reactivar' : future ? '⏭️ Ese mes no' : '⏭️ Este mes no'}
        </button>
        <button onClick={onEditItem} className={`${btnCls} bg-card`}>✏️ Editar</button>
        {linked && (
          <button disabled={busy} onClick={() => confirm('¿Anular los pagos enlazados? El gasto se anula en Movimientos (se recupera con Deshacer).') && run(() => api.unpayPlanEntry(e.id), 'Pago anulado')}
            className={`${btnCls} col-span-2 bg-card text-bad`}>Anular pago</button>
        )}
      </div>
    </Sheet>
  )
}

// ── the template (applies from this month on) ────────────────────────────────
function ItemSheet({ item, cats, accounts, onClose, onDone }: {
  item: PlanItem | null; cats: Category[]; accounts: Balance[]; onClose: () => void; onDone: () => void
}) {
  const [v, setV] = useState({
    name: item?.name ?? '', emoji: item?.emoji ?? '', kind: item?.kind ?? 'bill', amount: item ? String(num(item.amount)) : '', currency: item?.currency ?? 'USDT',
    dueDay: item?.dueDay ? String(item.dueDay) : '', dueDayEnd: item?.dueDayEnd && item.dueDayEnd !== item.dueDay ? String(item.dueDayEnd) : '',
    remindDays: String(item?.remindDays ?? 1), categoryId: item?.categoryId ? String(item.categoryId) : '', accountId: item?.accountId ? String(item.accountId) : '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const day = (s: string) => { const n = parseInt(s, 10); return n >= 1 && n <= 31 ? n : null }
  const bill = v.kind === 'bill'
  const body = (): PlanItemInput => ({
    name: v.name.trim(), emoji: v.emoji.trim() || null, kind: v.kind, amount: parseNum(v.amount), currency: v.currency,
    dueDay: bill ? day(v.dueDay) : null, dueDayEnd: bill && day(v.dueDay) ? day(v.dueDayEnd) : null, remindDays: +v.remindDays,
    categoryId: v.categoryId ? +v.categoryId : null, accountId: v.accountId ? +v.accountId : null,
  })
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('')
    try { await fn(); onDone() } catch (e: any) { setErr('Error: ' + e.message) } finally { setBusy(false) }
  }
  const valid = v.name.trim() && parseNum(v.amount) > 0 && (!v.dueDayEnd || (day(v.dueDay) && day(v.dueDayEnd)! >= day(v.dueDay)!))
  return (
    <Sheet open onClose={onClose} title={item ? `Editar ${item.name}` : 'Agregar al plan'}>
      <div className="space-y-3">
        <Seg value={v.kind} onChange={(k) => setV({ ...v, kind: k })} options={[['bill', 'Pago fijo'], ['envelope', 'Presupuesto']]} />
        <p className="-mt-1 text-[12px] text-muted">
          {bill ? 'Se paga una vez al mes (alquiler, internet). Te recuerdo cuando toque y te pregunto cuánto pagaste.'
            : 'Se va gastando durante el mes (mercado, gasolina). Cuenta todo lo que registres en su categoría.'}
        </p>
        <div className="grid grid-cols-[4rem_1fr] gap-3">
          <Field label="Emoji"><input value={v.emoji} onChange={(e) => setV({ ...v, emoji: e.target.value })} className={inputCls + ' text-center'} placeholder="🔑" /></Field>
          <Field label="Concepto"><input autoFocus={!item} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={inputCls} placeholder={bill ? 'Alquiler' : 'Mercado'} /></Field>
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Monto al mes"><input inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} className={inputCls + ' num'} /></Field>
          <Field label="Moneda">
            <select value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })} className={inputCls}>
              {CURS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
            </select>
          </Field>
        </div>
        {bill && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Día (o desde)"><input inputMode="numeric" value={v.dueDay} onChange={(e) => setV({ ...v, dueDay: e.target.value })} className={inputCls + ' num'} placeholder="1" /></Field>
              <Field label="Hasta (opcional)"><input inputMode="numeric" value={v.dueDayEnd} disabled={!day(v.dueDay)} onChange={(e) => setV({ ...v, dueDayEnd: e.target.value })} className={inputCls + ' num disabled:opacity-50'} placeholder="5" /></Field>
            </div>
            <Field label="Recordarme">
              <select value={v.remindDays} onChange={(e) => setV({ ...v, remindDays: e.target.value })} className={inputCls}>
                {[0, 1, 2, 3, 5, 7].map((n) => <option key={n} value={n}>{n === 0 ? 'El mismo día' : `${n} día${n > 1 ? 's' : ''} antes`}</option>)}
              </select>
            </Field>
          </>
        )}
        <Field label={bill ? 'Categoría del gasto' : 'Categoría que cuenta'}>
          <select value={v.categoryId} onChange={(e) => setV({ ...v, categoryId: e.target.value })} className={inputCls}>
            <option value="">Sin categoría</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{catLabel(c)}</option>)}
          </select>
        </Field>
        {bill && (
          <Field label="Se paga desde">
            <select value={v.accountId} onChange={(e) => setV({ ...v, accountId: e.target.value })} className={inputCls}>
              <option value="">Preguntar cada vez</option>
              {accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}
            </select>
          </Field>
        )}
        {item && <p className="text-[12px] text-muted">Los cambios aplican desde este mes (los meses que ya ajustaste a mano o ya pagaste no se tocan).</p>}
      </div>
      {err && <p role="alert" className="mt-3 text-center text-[13px] text-bad">{err}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {item ? (
          <button disabled={busy} onClick={() => confirm(`¿Sacar «${item.name}» del plan? Los meses pasados quedan.`) && run(() => api.deletePlanItem(item.id))} className={`${btnCls} bg-card text-bad`}>Quitar</button>
        ) : <button onClick={onClose} className={`${btnCls} bg-card`}>Cancelar</button>}
        <button disabled={busy || !valid} onClick={() => run(() => item ? api.updatePlanItem(item.id, body()) : api.createPlanItem(body()))} className={`${btnCls} bg-accent text-accent-fg`}>Guardar</button>
      </div>
    </Sheet>
  )
}
