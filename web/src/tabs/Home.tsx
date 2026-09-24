import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { api, type TxQuery } from '../api'
import { Card, Loading, fmtNum, useLoad, useMoney } from '../ui'

type Go = (t: 'movimientos', q?: TxQuery) => void

export default function Home({ go }: { go: Go }) {
  const { data: o, error } = useLoad(api.overview)
  const m = useMoney()
  if (!o) return <Loading error={error} />

  const delta = o.lastMonth ? (o.month - o.lastMonth) / o.lastMonth : null
  const spark = o.spark.map((p) => ({ ...p, v: m.conv(p.total) }))

  return (
    <div className="space-y-3">
      <Card>
        <div className="text-[13px] font-medium text-muted">Patrimonio</div>
        <div className="num mt-1 text-[34px] font-bold leading-tight tracking-tight">{m.usd(o.netWorthUsd)}</div>
        {(o.toJustify > 0 || o.pending > 0) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {o.toJustify > 0 && (
              <button onClick={() => go('movimientos', { status: 'tojustify' })}
                className="rounded-full bg-warn-bg px-3 py-1.5 text-[13px] font-semibold text-warn">⚠️ {o.toJustify} por justificar</button>
            )}
            {o.pending > 0 && (
              <button onClick={() => go('movimientos', { status: 'pending' })}
                className="rounded-full bg-line px-3 py-1.5 text-[13px] font-medium text-fg">{o.pending} pendientes</button>
            )}
          </div>
        )}
      </Card>

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
