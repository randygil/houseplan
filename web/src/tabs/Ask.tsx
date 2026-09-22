import { useEffect, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type AskAnswer } from '../api'
import { fmtNum } from '../ui'

const SUGGESTIONS = ['¿Cuánto gasté esta semana?', '¿En qué gasté ayer?', 'Comida vs mes pasado', '¿Cuánto me queda en las bolsas?']
type Msg = { q: string; a?: AskAnswer; err?: string }

export default function Ask() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  const ask = async (question: string) => {
    question = question.trim()
    if (!question || busy) return
    setQ(''); setBusy(true)
    setMsgs((m) => [...m, { q: question }])
    try {
      const a = await api.ask(question)
      setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, a } : x)))
    } catch (e: any) {
      setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, err: e.message } : x)))
    } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-[calc(100dvh-72px-72px-env(safe-area-inset-bottom))] flex-col">
      <div className="flex-1 space-y-4 pb-4">
        {msgs.length === 0 && (
          <div className="pt-6 text-center">
            <div className="text-4xl">💬</div>
            <p className="mt-2 text-[15px] text-muted">Pregunta lo que quieras sobre tus gastos.</p>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className="space-y-2">
            <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-[15px] text-accent-fg">{m.q}</div>
            <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-card px-3.5 py-2.5 text-[15px]">
              {m.err ? <span className="text-bad">Error: {m.err}</span> : !m.a ? <span className="text-muted">Pensando…</span> : <Answer a={m.a} />}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>

      <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] -mx-4 bg-bg/90 px-4 pt-2 pb-3 backdrop-blur">
        <div className="no-scrollbar -mx-4 mb-2 flex gap-2 overflow-x-auto px-4">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={busy}
              className="shrink-0 rounded-full border border-line bg-card px-3 py-1.5 text-[13px] active:opacity-70">{s}</button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); ask(q) }} className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Escribe tu pregunta…" enterKeyHint="send"
            className="min-w-0 flex-1 rounded-full border border-line bg-card px-4 py-2.5 text-[16px] outline-none focus:border-accent" />
          <button disabled={busy || !q.trim()} aria-label="Enviar"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg disabled:opacity-40">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </form>
      </div>
    </div>
  )
}

const axis = { stroke: 'var(--muted)', fontSize: 11, tickLine: false, axisLine: false } as const
const cell = (v: string | number) => (typeof v === 'number' ? fmtNum(v, Number.isInteger(v) ? 0 : 2) : v)

function Answer({ a }: { a: AskAnswer }) {
  return (
    <div className="space-y-3">
      <p className="whitespace-pre-wrap">{a.answer}</p>
      {a.table && a.table.rows.length > 0 && (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr>{a.table.columns.map((c) => <th key={c} className="border-b border-line px-1 py-1 text-left font-semibold text-muted">{c}</th>)}</tr></thead>
            <tbody>
              {a.table.rows.map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j} className={`border-b border-line px-1 py-1.5 ${typeof v === 'number' ? 'num text-right' : ''}`}>{cell(v)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {a.chart && a.chart.data.length > 0 && (
        <div className="h-44 -ml-2">
          <ResponsiveContainer>
            {a.chart.type === 'line' ? (
              <LineChart data={a.chart.data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis {...axis} width={40} />
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12 }} formatter={(v) => fmtNum(Number(v))} />
                <Line dataKey="value" name="Valor" stroke="var(--s1)" strokeWidth={2} dot={false} />
              </LineChart>
            ) : (
              <BarChart data={a.chart.data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="label" {...axis} interval={0} tick={{ fontSize: 10 }} />
                <YAxis {...axis} width={40} />
                <Tooltip cursor={{ fill: 'var(--line)', opacity: 0.5 }} contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12 }} formatter={(v) => fmtNum(Number(v))} />
                <Bar dataKey="value" name="Valor" fill="var(--s1)" radius={[4, 4, 0, 0]} maxBarSize={32} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
