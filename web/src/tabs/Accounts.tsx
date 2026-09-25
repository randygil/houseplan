import { useState } from 'react'
import { api, num, type Balance } from '../api'
import { Loading, Sheet, ago, btnCls, fmtCur, inputCls, parseNum, useLoad, useMoney } from '../ui'
import Debts from './Debts'

export default function Accounts() {
  const { data, error, reload } = useLoad(api.accounts)
  const [rec, setRec] = useState<Balance | null>(null)
  const m = useMoney()
  if (!data) return <Loading error={error} />
  const total = data.reduce((s, b) => s + num(b.balanceUsd), 0)
  return (
    <div className="space-y-3">
      <div className="px-1 text-[13px] text-muted">Total <b className="num text-fg">{m.usd(total)}</b> · toca una cuenta estimada para conciliar</div>
      <div className="overflow-hidden rounded-2xl bg-card">
        {data.map((b, i) => {
          const ledger = b.kind !== 'synced'
          return (
            <button key={b.accountId} disabled={!ledger} onClick={() => setRec(b)}
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left enabled:active:bg-line ${i ? 'border-t border-line' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium">{b.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ledger ? 'bg-warn' : 'bg-good'}`} />
                  <span className="truncate">{ledger ? `estimado · conciliado ${ago(b.lastReconciledAt)}` : b.lastSyncedAt ? `sincronizado ${ago(b.lastSyncedAt)}` : 'sin leer aún'}</span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="num text-[16px] font-semibold">{fmtCur(num(b.balance), b.currency)}</div>
                {b.balanceUsd != null && b.currency !== 'USDT' && b.currency !== 'USD' && <div className="num text-[12px] text-muted">≈ {fmtCur(num(b.balanceUsd), 'USD')}</div>}
              </div>
              <span className={`w-3 text-xl leading-none ${ledger ? 'text-muted' : 'invisible'}`}>›</span>
            </button>
          )
        })}
      </div>
      <Reconcile b={rec} onClose={() => setRec(null)} onDone={reload} />
      <Debts />
    </div>
  )
}

function Reconcile({ b, onClose, onDone }: { b: Balance | null; onClose: () => void; onDone: () => void }) {
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<string | null>(null)
  const close = () => { setVal(''); setRes(null); onClose() }
  if (!b) return null
  const submit = async () => {
    const actual = parseNum(val)
    if (!isFinite(actual)) return
    setBusy(true)
    try {
      const r = await api.reconcile(b.accountId, actual)
      setRes(Math.abs(r.diff) < 0.005 ? 'Cuadra perfecto ✓' :
        r.diff < 0 ? `Faltan ${fmtCur(-r.diff, b.currency)} — quedó como gasto pendiente` : `Sobran ${fmtCur(r.diff, b.currency)} — ajustado`)
      onDone()
    } catch (e: any) { setRes('Error: ' + e.message) } finally { setBusy(false) }
  }
  return (
    <Sheet open onClose={close} title={`Conciliar ${b.name}`}>
      <p className="mb-3 text-[14px] text-muted">
        Estimado: <b className="num text-fg">{fmtCur(num(b.balance), b.currency)}</b>. ¿Cuánto tienes realmente?
      </p>
      <input autoFocus inputMode="decimal" placeholder={`Saldo real en ${b.currency}`} value={val} onChange={(e) => setVal(e.target.value)} className={inputCls + ' num text-[20px]'} />
      {res && <div className="mt-3 rounded-xl bg-card p-3 text-[14px]">{res}</div>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button onClick={close} className={`${btnCls} bg-card`}>{res ? 'Cerrar' : 'Cancelar'}</button>
        <button disabled={busy || !val || !!res} onClick={submit} className={`${btnCls} bg-accent text-accent-fg`}>Conciliar</button>
      </div>
    </Sheet>
  )
}
