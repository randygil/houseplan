import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, num, type SummaryRow } from '../api'
import { Card, Loading, SERIES, Seg, daysAgo, fmtCur, fmtNum, iso, useLoad, useMoney, ymd } from '../ui'

const axis = { stroke: 'var(--muted)', fontSize: 11, tickLine: false, axisLine: false } as const
const tipStyle = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12, color: 'var(--fg)' }

export default function Analysis() {
  const [days, setDays] = useState<'30' | '90'>('30')
  const from = iso(daysAgo(+days - 1)), to = iso(new Date())
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Seg value={days} onChange={setDays} options={[['30', '30 días'], ['90', '90 días']]} /></div>
      <WeeklyStack />
      <TopList title="Top comercios" from={from} to={to} groupBy="merchant" />
      <Heatmap from={from} to={to} />
      <TopList title="Gasto por cuenta" from={from} to={to} groupBy="account" />
      <Fees from={from} to={to} />
      <Bags />
      <Rates />
    </div>
  )
}

function WeeklyStack() {
  const m = useMoney()
  const weeks = 8
  const { data, error } = useLoad(async () => {
    // Monday-start weeks in Caracas time
    const today = daysAgo(0)
    const dow = (new Date(ymd(today) + 'T12:00:00Z').getUTCDay() + 6) % 7
    const starts = Array.from({ length: weeks }, (_, i) => daysAgo(dow + 7 * (weeks - 1 - i)))
    const rows = await Promise.all(starts.map((s, i) =>
      api.summary({ from: iso(s), to: iso(starts[i + 1] ?? new Date()), groupBy: 'category', currency: 'USD' })))
    return { starts, rows }
  }, [])
  if (!data) return <Card title="Por categoría y semana"><Loading error={error} /></Card>

  // top 5 categories overall, rest folded into "Otros"
  const tot = new Map<string, number>()
  data.rows.flat().forEach((r) => tot.set(r.label, (tot.get(r.label) ?? 0) + r.total))
  const top = [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)
  const keys = tot.size > 5 ? [...top, 'Otros'] : top
  const chart = data.rows.map((rows, i) => {
    const o: Record<string, number | string> = { week: data.starts[i].toLocaleDateString('es-VE', { day: 'numeric', month: 'short', timeZone: 'America/Caracas' }) }
    for (const r of rows) {
      const k = top.includes(r.label) ? r.label : 'Otros'
      o[k] = ((o[k] as number) ?? 0) + m.conv(r.total)
    }
    return o
  })
  return (
    <Card title="Por categoría y semana">
      <div className="h-56 -ml-2">
        <ResponsiveContainer>
          <BarChart data={chart} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="week" {...axis} interval={1} />
            <YAxis {...axis} width={44} tickFormatter={(v) => compact(v)} />
            <Tooltip cursor={{ fill: 'var(--line)', opacity: 0.5 }} contentStyle={tipStyle} formatter={(v) => fmtCur(Number(v), m.cur)} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} formatter={legendText} />
            {keys.map((k, i) => (
              <Bar key={k} dataKey={k} stackId="a" fill={k === 'Otros' ? 'var(--muted)' : SERIES[i]} stroke="var(--card)" strokeWidth={1}
                radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={28} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

const legendText = (v: string) => <span style={{ color: 'var(--muted)' }}>{v}</span>
const compact = (v: number) => new Intl.NumberFormat('es-VE', { notation: 'compact', maximumFractionDigits: 1 }).format(v)

function TopList({ title, from, to, groupBy }: { title: string; from: string; to: string; groupBy: 'merchant' | 'account' }) {
  const m = useMoney()
  const { data, error } = useLoad(() => api.summary({ from, to, groupBy, currency: 'USD' }), [from, groupBy])
  if (!data) return <Card title={title}><Loading error={error} /></Card>
  const rows = [...data].sort((a, b) => b.total - a.total).slice(0, 8)
  const max = rows[0]?.total || 1
  return (
    <Card title={title}>
      {rows.length === 0 && <div className="text-sm text-muted">Sin datos</div>}
      <ul className="space-y-2.5">
        {rows.map((r: SummaryRow) => (
          <li key={r.key}>
            <div className="flex items-baseline justify-between gap-2 text-[14px]">
              <span className="truncate">{r.label || '—'} <span className="text-[12px] text-muted">· {r.count}</span></span>
              <span className="num shrink-0 font-semibold">{m.usd(r.total)}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-line">
              <div className="h-full rounded-full bg-accent" style={{ width: `${(r.total / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

const DOW = ['L', 'M', 'X', 'J', 'V', 'S', 'D']
function Heatmap({ from, to }: { from: string; to: string }) {
  const m = useMoney()
  const [sel, setSel] = useState<{ dow: number; hour: number; total: number } | null>(null)
  const { data, error } = useLoad(() => api.heatmap({ from, to }), [from])
  if (!data) return <Card title="Día × hora"><Loading error={error} /></Card>
  // backend dow: 0=Sunday (Postgres EXTRACT(dow)); display Monday-first
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[])
  data.forEach((c) => { grid[(c.dow + 6) % 7][c.hour] += c.total })
  const max = Math.max(...grid.flat(), 1)
  const lvl = (v: number) => (v <= 0 ? 0 : Math.min(5, 1 + Math.floor((v / max) * 4.999)))
  return (
    <Card title="Día × hora" action={<span className="num text-[12px] text-muted">
      {sel ? `${DOW[sel.dow]} ${sel.hour}:00 · ${m.usd(sel.total)}` : 'Toca una celda'}</span>}>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: '14px repeat(24, 1fr)' }}>
        {grid.map((row, d) => [
          <div key={'l' + d} className="text-[10px] leading-[10px] text-muted self-center">{DOW[d]}</div>,
          ...row.map((v, h) => (
            <button key={d + '-' + h} onClick={() => setSel({ dow: d, hour: h, total: v })} title={`${DOW[d]} ${h}:00`}
              className={`aspect-square rounded-[2px] ${sel?.dow === d && sel?.hour === h ? 'ring-2 ring-fg' : ''}`}
              style={{ background: `var(--heat${lvl(v)})` }} />
          )),
        ])}
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={'h' + h} className="text-center text-[9px] text-muted">{h % 6 === 0 ? h : ''}</div>
        ))}
      </div>
    </Card>
  )
}

function Fees({ from, to }: { from: string; to: string }) {
  const m = useMoney()
  const { data } = useLoad(() => api.transactions({ from, to, type: 'fee', limit: 500 }), [from])
  if (!data) return null
  const total = data.items.filter((t) => t.status !== 'void').reduce((s, t) => s + num(t.amountUsd), 0)
  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold uppercase tracking-wide text-muted">Comisiones pagadas</span>
        <span className="num text-[18px] font-semibold">{m.usd(total)}</span>
      </div>
      <div className="mt-0.5 text-[12px] text-muted">{data.items.length} comisiones en el período</div>
    </Card>
  )
}

function Bags() {
  const [all, setAll] = useState(false)
  const { data, error } = useLoad(() => api.bags(!all), [all])
  return (
    <Card title="Mis bolsas" action={<Seg value={all ? 'all' : 'open'} onChange={(v) => setAll(v === 'all')} options={[['open', 'Abiertas'], ['all', 'Todas']]} />}>
      {!data ? <Loading error={error} /> : data.length === 0 ? <div className="text-sm text-muted">No hay bolsas abiertas</div> : (
        <ul className="space-y-4">
          {data.slice(0, 12).map(({ bag, account, spent, remaining, txs }) => {
            const amt = num(bag.amountVes), pct = amt ? Math.min(100, (spent / amt) * 100) : 0
            return (
              <li key={bag.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[14px] font-medium">{account} <span className="text-[12px] text-muted">· {new Date(bag.openedAt).toLocaleDateString('es-VE', { day: 'numeric', month: 'short', timeZone: 'America/Caracas' })}</span></span>
                  <span className="num text-[12px] text-muted">@ {fmtNum(num(bag.rate), 2)}</span>
                </div>
                <div className="mt-1.5 h-2 rounded-full bg-line">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--s2)' }} />
                </div>
                <div className="num mt-1 flex justify-between text-[12px]">
                  <span>Gastado <b className="font-semibold">{fmtCur(spent, 'VES')}</b> · {txs.length} mov.</span>
                  <span className={remaining > 0 ? 'text-fg' : 'text-muted'}>Quedan <b className="font-semibold">{fmtCur(remaining, 'VES')}</b></span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function Rates() {
  const { data, error } = useLoad(() => api.rates({ from: iso(daysAgo(89)), to: iso(new Date()) }), [])
  return (
    <Card title="Tasa: BCV vs mi P2P (90 d)">
      {!data ? <Loading error={error} /> : (
        <div className="h-48 -ml-2">
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="date" {...axis} minTickGap={40} tickFormatter={(d) => new Date(d + 'T12:00:00').toLocaleDateString('es-VE', { day: 'numeric', month: 'short' })} />
              <YAxis {...axis} width={44} domain={['auto', 'auto']} tickFormatter={(v) => compact(v)} />
              <Tooltip contentStyle={tipStyle} formatter={(v) => fmtNum(Number(v), 2)} />
              <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} formatter={legendText} />
              <Line type="monotone" dataKey="bcv" name="BCV" stroke="var(--s1)" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="p2p" name="Mi P2P" stroke="var(--s2)" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="market" name="Mercado" stroke="var(--s3)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}
