import { useState } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { api, type PlanMonth, type TxQuery } from '../api'
import { Card, Loading, fmtNum, useLoad, useMoney } from '../ui'

type Go = (t: 'movimientos' | 'plan', q?: TxQuery) => void

export default function Home({ go }: { go: Go }) {
  const { data: o, error } = useLoad(api.overview)
  const { data: plan } = useLoad(() => api.plan())
  const m = useMoney()
  const [minusDebts, setMinusDebts] = useState(() => { try { return localStorage.getItem('plata.minusDebts') === '1' } catch { return false } })
  const toggleDebts = (v: boolean) => { setMinusDebts(v); try { localStorage.setItem('plata.minusDebts', v ? '1' : '0') } catch {} }
  if (!o) return <Loading error={error} />

  const delta = o.lastMonth ? (o.month - o.lastMonth) / o.lastMonth : null
  const spark = o.spark.map((p) => ({ ...p, v: m.conv(p.total) }))

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-medium text-muted">Patrimonio</div>
          {o.debtsUsd > 0 && (
            <label className="flex items-center gap-1.5 text-[13px] text-muted">
              <input type="checkbox" checked={minusDebts} onChange={(e) => toggleDebts(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
              Restar deudas
            </label>
          )}
        </div>
        <div className="num mt-1 text-[34px] font-bold leading-tight tracking-tight">{m.usd(o.netWorthUsd - (minusDebts ? o.debtsUsd : 0))}</div>
        {minusDebts && o.debtsUsd > 0 && <div className="num text-[12px] text-muted">{m.usd(o.netWorthUsd)} − {m.usd(o.debtsUsd)} de deudas</div>}
        {o.pending > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => go('movimientos', { status: 'pending' })}
              className="rounded-full bg-line px-3 py-1.5 text-[13px] font-medium text-fg">{o.pending} pendientes</button>
          </div>
        )}
      </Card>

      {plan && plan.entries.length > 0 && <PlanCard m={plan} onOpen={() => go('plan')} />}

      <div className="grid grid-cols-3 gap-3">
        {([['Hoy', o.today], ['Semana', o.week], ['Mes', o.month]] as const).map(([l, v]) => (
          <Card key={l} className="!p-3">
            <div className="text-[12px] font-medium text-muted">{l}</div>
            <div className="num mt-0.5 truncate text-[17px] font-semibold">{m.usd(v, m.cur === 'VES' ? 0 : undefined)}</div>
          </Card>
        ))}
      </div>

      <Card title="Gasto 30 días" action={
        delta !== null && (
          <span className={`num text-[13px] font-semibold ${delta > 0 ? 'text-bad' : 'text-good'}`}>
            {delta > 0 ? '▲' : '▼'} {fmtNum(Math.abs(delta) * 100, 0)}% vs mes pasado
          </span>
        )
      }>
        <div className="h-24 -mx-1">
          <ResponsiveContainer>
            <AreaChart data={spark} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--s1)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="var(--s1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" hide />
              <Tooltip cursor={{ stroke: 'var(--muted)', strokeDasharray: 3 }} content={({ active, payload }) =>
                active && payload?.[0] ? (
                  <div className="rounded-lg bg-fg px-2 py-1 text-xs text-bg">
                    {new Date(payload[0].payload.date + 'T12:00:00').toLocaleDateString('es-VE', { day: 'numeric', month: 'short' })} · {m.usd(payload[0].payload.total)}
                  </div>
                ) : null} />
              <Area type="monotone" dataKey="v" stroke="var(--s1)" strokeWidth={2} fill="url(#sg)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex justify-between text-[12px] text-muted">
          <span>Mes pasado: <b className="num font-semibold text-fg">{m.usd(o.lastMonth)}</b></span>
        </div>
      </Card>

      <Card title="Tasas (Bs por USD)">
        <div className="grid grid-cols-3 gap-3">
          <Rate label="BCV" v={o.rates.bcv} />
          <Rate label="P2P mercado" v={o.rates.market} />
          <Rate label="Mi P2P" v={o.rates.p2p} />
        </div>
        {o.rates.bcv && o.rates.market && (
          <div className="mt-2 text-[12px] text-muted">Brecha: <span className="num">{fmtNum((o.rates.market / o.rates.bcv - 1) * 100, 1)}%</span></div>
        )}
      </Card>
    </div>
  )
}

const Rate = ({ label, v }: { label: string; v: number | null }) => (
  <div>
    <div className="text-[12px] font-medium text-muted">{label}</div>
    <div className="num text-[22px] font-semibold">{v ? fmtNum(v, 2) : '—'}</div>
  </div>
)

/** Month plan at a glance: spent vs budget, forecast, and the next bill that's due. */
function PlanCard({ m, onOpen }: { m: PlanMonth; onOpen: () => void }) {
  const $ = useMoney()
  const t = m.totals
  const next = m.entries.filter((e) => e.kind === 'bill' && (e.status === 'pending' || e.status === 'partial') && e.dueFrom)
    .sort((a, b) => a.dueFrom!.localeCompare(b.dueFrom!))[0]
  const late = next?.dueTo != null && next.dueTo < m.today
  const over = t.allForecastUsd - t.plannedUsd
  return (
    <button onClick={onOpen} className="block w-full rounded-2xl bg-card p-4 text-left active:opacity-80">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">Plan del mes</h2>
        <span className="num text-[13px] text-muted">{t.billsPaid}/{t.bills} pagos</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="num text-[22px] font-bold">{$.usd(t.allSpentUsd, 0)}</span>
        <span className="num text-[14px] text-muted">de {$.usd(t.plannedUsd, 0)}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
        <div className={`h-full rounded-full ${t.allSpentUsd > t.plannedUsd ? 'bg-bad' : 'bg-[var(--s1)]'}`} style={{ width: `${Math.min(100, (t.allSpentUsd / Math.max(t.plannedUsd, 1)) * 100)}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-[12px]">
        <span className={`num ${over > 1 ? 'text-bad' : 'text-muted'}`}>Pronóstico {$.usd(t.allForecastUsd, 0)}{Math.abs(over) > 1 ? ` (${over > 0 ? '+' : '−'}${$.usd(Math.abs(over), 0)})` : ''}</span>
        {next && <span className={late ? 'font-semibold text-bad' : 'text-muted'}>{next.emoji ?? '📅'} {next.name}: {next.dueLabel}</span>}
      </div>
    </button>
  )
}
