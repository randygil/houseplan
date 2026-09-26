import { useCallback, useEffect, useRef, useState } from 'react'
import { api, num, type Account, type Balance, type Category, type Transaction, type TxQuery, type TxView } from '../api'
import { Field, SOURCE_BADGE, SOURCE_LABEL, Sheet, btnCls, daysAgo, fmtCur, fmtDay, fmtTime, inputCls, iso, parseNum, useLoad, useMoney, ymd } from '../ui'

const RANGES: [string, string, number | null][] = [['7', '7 días', 7], ['30', '30 días', 30], ['90', '90 días', 90], ['all', 'Todo', null]]
const TYPES: [string, string][] = [['', 'Tipo'], ['expense', 'Gasto'], ['income', 'Ingreso'], ['transfer', 'Transferencia'], ['fee', 'Comisión'], ['excluded', 'Solo registro']]
const STATUSES: [string, string][] = [['', 'Estado'], ['pending', 'Pendiente'], ['confirmed', 'Confirmado'], ['void', 'Anulado']]

const accOf = (b: Balance): Account => ({ id: b.accountId, code: b.code, name: b.name, currency: b.currency, kind: b.kind })

export default function Movs({ preset }: { preset: TxQuery }) {
  const [f, setF] = useState({ range: 'all', accountId: '', categoryId: '', type: '', status: preset.status ?? '', text: '' })
  const [text, setText] = useState('')
  const [items, setItems] = useState<TxView[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [edit, setEdit] = useState<TxView | null>(null)
  const { data: cats } = useLoad(api.categories)
  const { data: bals } = useLoad(api.accounts)
  const accounts = (bals ?? []).map(accOf)
  const sentinel = useRef<HTMLDivElement>(null)
  const gen = useRef(0)

  useEffect(() => { setF((x) => ({ ...x, status: preset.status ?? '' })) }, [preset])
  useEffect(() => { const t = setTimeout(() => setF((x) => ({ ...x, text })), 300); return () => clearTimeout(t) }, [text])

  const query = useCallback((c: number | null): TxQuery => {
    const days = RANGES.find((r) => r[0] === f.range)?.[2]
    return {
      from: days ? iso(daysAgo(days - 1)) : undefined,
      accountId: f.accountId && f.accountId !== 'none' ? +f.accountId : undefined, noAccount: f.accountId === 'none' ? 1 : undefined, categoryId: f.categoryId ? +f.categoryId : undefined,
      type: f.type && f.type !== 'excluded' ? f.type : undefined, excluded: f.type === 'excluded' ? 1 : undefined, status: f.status || undefined, text: f.text || undefined,
      cursor: c ?? undefined, limit: 30,
    }
  }, [f])

  const loadMore = useCallback(async (reset = false) => {
    if (loading && !reset) return
    const g = reset ? ++gen.current : gen.current
    setLoading(true); setErr(null)
    try {
      const r = await api.transactions(query(reset ? null : cursor))
      if (g !== gen.current) return
      setItems((xs) => (reset ? r.items : [...xs, ...r.items]))
      setCursor(r.nextCursor); setDone(r.nextCursor == null)
    } catch (e: any) { if (g === gen.current) setErr(e.message) } finally { if (g === gen.current) setLoading(false) }
  }, [query, cursor, loading])

  useEffect(() => { setItems([]); setDone(false); loadMore(true) }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && !done && !loading && loadMore())
    io.observe(el)
    return () => io.disconnect()
  }, [done, loading, loadMore])

  const onSaved = (t: Transaction | null, old: TxView) => {
    if (!t) return
    const merged: TxView = {
      ...old, ...t,
      category: cats?.find((c) => c.id === t.categoryId) ?? null,
      fromAccount: accounts.find((a) => a.id === t.fromAccountId) ?? null,
      toAccount: accounts.find((a) => a.id === t.toAccountId) ?? null,
    }
    setItems((xs) => xs.map((x) => (x.id === t.id ? merged : x)))
    setEdit(merged)
  }

  const groups: [string, TxView[]][] = []
  for (const t of items) {
    const k = ymd(t.occurredAt)
    if (groups.at(-1)?.[0] !== k) groups.push([k, []])
    groups.at(-1)![1].push(t)
  }

  const sel = (key: keyof typeof f, opts: [string, string][]) => (
    <select value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}
      className={`h-9 max-w-44 shrink-0 appearance-none truncate [field-sizing:content] rounded-full border px-3 text-[13px] font-medium outline-none ${f[key] && f[key] !== 'all' ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-card text-fg'}`}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )

  return (
    <div>
      <div className="sticky top-[calc(max(12px,env(safe-area-inset-top))+48px)] z-20 -mx-4 space-y-2 bg-bg/85 px-4 pb-3 backdrop-blur">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Buscar comercio, nota…" className={inputCls + ' !py-2'} type="search" />
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {sel('range', RANGES.map(([v, l]) => [v, l]))}
          {sel('accountId', [['', 'Cuenta'], ...accounts.map((a) => [String(a.id), a.name] as [string, string]), ['none', 'Sin cuenta']])}
          {sel('categoryId', [['', 'Categoría'], ...(cats ?? []).map((c) => [String(c.id), catLabel(c)] as [string, string])])}
          {sel('type', TYPES)}
          {sel('status', STATUSES)}
        </div>
      </div>

      <div className="space-y-4">
        {groups.map(([day, txs]) => <DayGroup key={day} txs={txs} onTap={setEdit} />)}
      </div>
      {err && <div className="py-6 text-center text-sm text-bad">Error: {err}</div>}
      {!loading && !err && items.length === 0 && <div className="py-12 text-center text-sm text-muted">Sin movimientos</div>}
      <div ref={sentinel} className="py-6 text-center text-xs text-muted">{loading ? 'Cargando…' : done && items.length ? 'Eso es todo' : ''}</div>

      <EditSheet tx={edit} onClose={() => setEdit(null)} cats={cats ?? []} accounts={accounts} onSaved={onSaved} />
    </div>
  )
}

const TYPE_LABEL: Record<string, string> = { expense: 'Gasto', income: 'Ingreso', transfer: 'Transferencia', fee: 'Comisión' }
const catLabel = (c: Category) => `${c.emoji ? c.emoji + ' ' : ''}${c.path ?? c.name}`
const isSpend = (t: TxView) => t.type === 'expense' || t.type === 'fee'
/** what the totals count: "solo registro" rows moved money but aren't spending */
const counts = (t: TxView) => isSpend(t) && t.status !== 'void' && !t.excluded

function DayGroup({ txs, onTap }: { txs: TxView[]; onTap: (t: TxView) => void }) {
  const m = useMoney()
  const spent = txs.filter(counts).reduce((s, t) => s + num(t.amountUsd), 0)
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between px-1">
        <h3 className="text-[13px] font-semibold text-muted">{fmtDay(txs[0].occurredAt)}</h3>
        {spent > 0 && <span className="num text-[12px] text-muted">−{m.usd(spent)}</span>}
      </div>
      <div className="overflow-hidden rounded-2xl bg-card">
        {txs.map((t, i) => <Row key={t.id} t={t} first={i === 0} onTap={() => onTap(t)} />)}
      </div>
    </section>
  )
}

function Row({ t, first, onTap }: { t: TxView; first: boolean; onTap: () => void }) {
  const m = useMoney()
  const title = t.merchant || t.category?.name || t.note || TYPE_LABEL[t.type]
  const acct = t.type === 'income' ? t.toAccount : t.type === 'transfer' ? null : t.fromAccount
  const sub = [t.merchant && t.category?.name, t.type === 'transfer' ? `${t.fromAccount?.name ?? '?'} → ${t.toAccount?.name ?? '?'}` : acct?.name, fmtTime(t.occurredAt)].filter(Boolean).join(' · ')
  const sign = isSpend(t) ? '−' : t.type === 'income' ? '+' : ''
  const pending = t.status === 'pending'
  const voided = t.status === 'void'
  return (
    <button onClick={onTap}
      className={`relative flex w-full items-center gap-3 px-3 py-3 text-left active:bg-line ${first ? '' : 'border-t border-line'} ${pending ? 'bg-warn-bg/60' : ''}`}>
      {pending && <span className="absolute inset-y-2 left-0 w-1 rounded-r bg-warn" />}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-line text-lg">
        {t.category?.emoji ?? (t.type === 'transfer' ? '⇄' : t.type === 'income' ? '↓' : t.type === 'fee' ? '%' : '•')}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[15px] font-medium ${voided ? 'line-through text-muted' : ''}`}>{title}</div>
        <div className="flex items-center gap-1.5 truncate text-[12px] text-muted">
          <span className="shrink-0 rounded bg-line px-1 text-[10px] font-semibold leading-4 text-fg">{SOURCE_BADGE[t.source] ?? t.source}</span>
          <span className="truncate">{sub}</span>
        </div>
      </div>
      <div className="text-right">
        <div className={`num text-[15px] font-semibold ${voided ? 'line-through text-muted' : t.excluded ? 'text-muted' : t.type === 'income' ? 'text-good' : ''}`}>{t.excluded ? '' : sign}{m.tx(t)}</div>
        {pending && <div className="text-[11px] font-semibold text-warn">pendiente</div>}
        {t.excluded && !voided && <div className="text-[11px] font-medium text-muted">solo registro</div>}
      </div>
    </button>
  )
}

// ISO -> "YYYY-MM-DDTHH:mm" in local time, the format <input type="datetime-local"> wants
const toLocalInput = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16) }

function EditSheet({ tx, onClose, cats, accounts, onSaved }: {
  tx: TxView | null; onClose: () => void; cats: Category[]; accounts: Account[]; onSaved: (t: Transaction | null, old: TxView) => void
}) {
  const [v, setV] = useState({ amount: '', date: '', categoryId: '', accountId: '', merchant: '', note: '', debtId: '', planEntryId: '' })
  const debts = useLoad(api.debts).data ?? []
  const txMonth = tx ? ymd(tx.occurredAt).slice(0, 7) : ''
  const plan = useLoad(() => (tx && tx.type !== 'income' && tx.type !== 'transfer' ? api.plan(txMonth) : Promise.resolve(null)), [txMonth, tx?.type]).data
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const accKey = tx?.type === 'income' ? 'toAccountId' : 'fromAccountId'

  useEffect(() => {
    if (!tx) return
    setMsg(null)
    setV({
      amount: String(num(tx.amount)), date: toLocalInput(tx.occurredAt), categoryId: tx.categoryId ? String(tx.categoryId) : '',
      accountId: String((accKey === 'toAccountId' ? tx.toAccountId : tx.fromAccountId) ?? ''),
      merchant: tx.merchant ?? '', note: tx.note ?? '', debtId: tx.debtId ? String(tx.debtId) : '', planEntryId: tx.planEntryId ? String(tx.planEntryId) : '',
    })
  }, [tx, accKey])

  if (!tx) return <Sheet open={false} onClose={onClose}>{null}</Sheet>
  const canConfirm = !!v.accountId || (tx.type === 'transfer' && !!(tx.fromAccountId || tx.toAccountId))

  const run = async (fn: () => Promise<Transaction | null>, ok: string) => {
    setBusy(true); setMsg(null)
    try { const r = await fn(); onSaved(r, tx); setMsg(r ? ok : 'Nada que deshacer') } catch (e: any) { setMsg('Error: ' + e.message) } finally { setBusy(false) }
  }
  const save = () => run(() => api.patchTx(tx.id, {
    amount: parseNum(v.amount),
    // only send when touched: minute-precision input would otherwise re-run FX on every save
    occurredAt: v.date && v.date !== toLocalInput(tx.occurredAt) ? new Date(v.date).toISOString() : undefined,
    categoryId: v.categoryId ? +v.categoryId : undefined,
    [accKey]: v.accountId ? +v.accountId : undefined,
    merchant: v.merchant || undefined, note: v.note || undefined,
    debtId: (+v.debtId || null) !== (tx.debtId ?? null) ? +v.debtId || null : undefined,
    planEntryId: (+v.planEntryId || null) !== (tx.planEntryId ?? null) ? +v.planEntryId || null : undefined,
  }), 'Guardado')

  return (
    <Sheet open onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-muted">
            {SOURCE_BADGE[tx.source] ?? ''} {SOURCE_LABEL[tx.source] ?? tx.source} · {fmtDay(tx.occurredAt)} {fmtTime(tx.occurredAt)}
          </div>
          <div className="num text-[28px] font-bold">{fmtCur(num(tx.amount), tx.currency === 'USDT' ? 'USDT' : tx.currency)}</div>
          {tx.amountUsd != null && tx.currency !== 'USD' && (
            <div className="num text-[12px] text-muted">≈ {fmtCur(num(tx.amountUsd), 'USD')}{tx.fxRate ? ` · tasa ${num(tx.fxRate).toLocaleString('es-VE')} (${tx.fxSource})` : ''}</div>
          )}
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${tx.status === 'pending' ? 'bg-warn-bg text-warn' : tx.status === 'void' ? 'bg-line text-muted' : 'bg-line text-good'}`}>
          {tx.status === 'pending' ? 'Pendiente' : tx.status === 'void' ? 'Anulado' : 'Confirmado'}
        </span>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Monto (${tx.currency})`}>
            <input inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} className={inputCls + ' num'} />
          </Field>
          <Field label="Cuenta">
            <select value={v.accountId} onChange={(e) => setV({ ...v, accountId: e.target.value })} className={inputCls}>
              <option value="">Sin cuenta</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Fecha">
          <input type="datetime-local" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} className={inputCls} />
        </Field>
        {tx.type !== 'transfer' && (
          <Field label="Categoría">
            <select value={v.categoryId} onChange={(e) => setV({ ...v, categoryId: e.target.value })} className={inputCls}>
              <option value="">Sin categoría</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{catLabel(c)}</option>)}
            </select>
          </Field>
        )}
        {tx.type === 'expense' && debts.length > 0 && (
          <Field label="Abono a deuda">
            <select value={v.debtId} onChange={(e) => setV({ ...v, debtId: e.target.value })} className={inputCls}>
              <option value="">No es pago de deuda</option>
              {debts.map((d) => <option key={d.id} value={d.id}>{d.name} · queda {fmtCur(d.remaining, d.currency)}</option>)}
            </select>
          </Field>
        )}
        {plan && plan.entries.length > 0 && (
          <Field label="Línea del plan">
            <select value={v.planEntryId} onChange={(e) => setV({ ...v, planEntryId: e.target.value })} className={inputCls}>
              <option value="">Automático (por comercio o categoría)</option>
              {plan.entries.map((p) => <option key={p.id} value={p.id}>{p.emoji ? `${p.emoji} ` : ''}{p.name} · {fmtCur(p.planned, p.currency)}{p.kind === 'bill' && p.status === 'paid' ? ' ✓' : ''}</option>)}
            </select>
          </Field>
        )}
        {isSpend(tx) && (
          <label className="flex items-start gap-3 rounded-xl bg-card px-3 py-3">
            <input type="checkbox" checked={tx.excluded} disabled={busy} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
              onChange={(e) => run(() => api.patchTx(tx.id, { excluded: e.target.checked }), e.target.checked ? 'Solo registro: ya no cuenta como gasto' : 'Vuelve a contar como gasto')} />
            <span>
              <span className="block text-[15px] font-medium">Solo registro</span>
              <span className="block text-[12px] text-muted">No cuenta como gasto (totales, análisis, plan). El saldo de la cuenta sí se mueve.</span>
            </span>
          </label>
        )}
        <Field label="Comercio">
          <input value={v.merchant} onChange={(e) => setV({ ...v, merchant: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Nota">
          <input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} className={inputCls} />
        </Field>
      </div>

      {msg && <div className="mt-3 text-center text-[13px] text-muted">{msg}</div>}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button disabled={busy} onClick={save} className={`${btnCls} col-span-2 bg-accent text-accent-fg`}>Guardar</button>
        {tx.status === 'pending' && (
          <>
            {/* the account picked above goes along: no confirming a movement that doesn't say where the money went */}
            <button disabled={busy || !canConfirm} onClick={() => run(() => api.patchTx(tx.id, { [accKey]: +v.accountId || undefined, status: 'confirmed' }), 'Confirmado')}
              className={`${btnCls} col-span-2 bg-card text-good`}>✓ Confirmar</button>
            {!canConfirm && <p className="col-span-2 -mt-1 text-center text-[12px] text-warn">Elige la cuenta para poder confirmar</p>}
          </>
        )}
        <button disabled={busy} onClick={() => run(() => api.undoTx(tx.id), 'Deshecho')} className={`${btnCls} bg-card`}>↶ Deshacer</button>
        <button disabled={busy || tx.status === 'void'} onClick={() => confirm('¿Anular este movimiento?') && run(() => api.voidTx(tx.id), 'Anulado')}
          className={`${btnCls} bg-card text-bad`}>Anular</button>
      </div>
    </Sheet>
  )
}
