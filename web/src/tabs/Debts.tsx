import { useState } from 'react'
import { api, type Debt } from '../api'
import { Field, Loading, Sheet, btnCls, fmtCur, inputCls, parseNum, useLoad } from '../ui'

export default function Debts() {
  const { data, error, reload } = useLoad(api.debts)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<Debt | null>(null)
  if (!data) return <Loading error={error} />
  return (
    <section className="pt-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">Deudas</h2>
        <button onClick={() => setAdding(true)} className="text-[14px] font-semibold text-accent">+ Nueva</button>
      </div>
      {!data.length ? (
        <div className="rounded-2xl bg-card px-4 py-5 text-center text-[14px] text-muted">
          Sin deudas. Dile al bot «le debo 200$ a Juan» o agrégala aquí; cuando pagues, el bot la descuenta solo.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-card">
          {data.map((d, i) => {
            const pct = d.amount ? Math.min(100, (d.paid / d.amount) * 100) : 0
            return (
              <button key={d.id} onClick={() => setOpen(d)} className={`block w-full px-4 py-3.5 text-left active:bg-line ${i ? 'border-t border-line' : ''}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[15px] font-medium">{d.remaining > 0 ? d.name : `✓ ${d.name}`}</span>
                  <span className="num shrink-0 text-[16px] font-semibold">{d.remaining > 0 ? fmtCur(d.remaining, d.currency) : 'Saldada'}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`Pagado de ${d.name}`}>
                  <div className="h-full rounded-full bg-good" style={{ width: `${pct}%` }} />
                </div>
                <div className="num mt-1 text-[12px] text-muted">
                  pagado {fmtCur(d.paid, d.currency)} de {fmtCur(d.amount, d.currency)} · {d.payments} {d.payments === 1 ? 'abono' : 'abonos'}
                </div>
              </button>
            )
          })}
        </div>
      )}
      {adding && <AddDebt onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload() }} />}
      {open && <DebtSheet d={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); reload() }} />}
    </section>
  )
}

function AddDebt({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ name: '', amount: '', currency: 'USD', note: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const amount = parseNum(v.amount)
  const submit = async () => {
    setBusy(true); setErr('')
    try { await api.createDebt({ name: v.name.trim(), amount, currency: v.currency, note: v.note.trim() || undefined }); onDone() }
    catch (e: any) { setErr('Error: ' + e.message) } finally { setBusy(false) }
  }
  return (
    <Sheet open onClose={onClose} title="Nueva deuda">
      <div className="space-y-3">
        <Field label="¿Qué o a quién?">
          <input autoFocus value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={inputCls} placeholder="Préstamo de Juan" />
        </Field>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Monto">
            <input inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} className={inputCls + ' num'} />
          </Field>
          <Field label="Moneda">
            <select value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })} className={inputCls}>
              <option value="USD">USD</option><option value="VES">Bs</option><option value="USDT">USDT</option>
            </select>
          </Field>
        </div>
        <Field label="Nota">
          <input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} className={inputCls} />
        </Field>
      </div>
      {err && <p role="alert" className="mt-3 text-center text-[13px] text-bad">{err}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button onClick={onClose} className={`${btnCls} bg-card`}>Cancelar</button>
        <button disabled={busy || !v.name.trim() || !(amount > 0)} onClick={submit} className={`${btnCls} bg-accent text-accent-fg`}>Guardar</button>
      </div>
    </Sheet>
  )
}

function DebtSheet({ d, onClose, onDone }: { d: Debt; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const del = async () => {
    if (!confirm(`¿Borrar «${d.name}»? Los pagos quedan como gastos normales.`)) return
    setBusy(true)
    try { await api.deleteDebt(d.id); onDone() } finally { setBusy(false) }
  }
  return (
    <Sheet open onClose={onClose} title={d.name}>
      <div className="space-y-1 text-[14px]">
        <div>Debías <b className="num">{fmtCur(d.amount, d.currency)}</b></div>
        <div>Pagado <b className="num text-good">{fmtCur(d.paid, d.currency)}</b> en {d.payments} {d.payments === 1 ? 'abono' : 'abonos'}</div>
        <div>Queda <b className="num">{fmtCur(d.remaining, d.currency)}</b></div>
        {d.note && <div className="pt-1 text-muted">📝 {d.note}</div>}
      </div>
      <p className="mt-3 text-[13px] text-muted">Para abonar, dile al bot el pago («le pagué 50$ a Juan»). En Movimientos puedes vincular o desvincular un gasto a mano.</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button onClick={onClose} className={`${btnCls} bg-card`}>Cerrar</button>
        <button disabled={busy} onClick={del} className={`${btnCls} bg-card text-bad`}>Borrar</button>
      </div>
    </Sheet>
  )
}
