import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, num, type TxView } from './api'

// ---- dates (America/Caracas is UTC-4, no DST) ----
export const TZ = 'America/Caracas'
export const ymd = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ })
export const dayStart = (ymdStr: string) => new Date(`${ymdStr}T00:00:00-04:00`)
export const daysAgo = (n: number) => new Date(dayStart(ymd(new Date())).getTime() - n * 864e5)
export const iso = (d: Date) => d.toISOString()
export const fmtDay = (d: string) => {
  const k = ymd(d)
  if (k === ymd(new Date())) return 'Hoy'
  if (k === ymd(new Date(Date.now() - 864e5))) return 'Ayer'
  const s = new Date(d).toLocaleDateString('es-VE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' })
  return s[0].toUpperCase() + s.slice(1)
}
export const fmtTime = (d: string) => new Date(d).toLocaleTimeString('es-VE', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
export const ago = (d: string | null) => {
  if (!d) return 'nunca'
  const m = (Date.now() - new Date(d).getTime()) / 6e4
  if (m < 60) return `hace ${Math.max(1, Math.round(m))} min`
  if (m < 1440) return `hace ${Math.round(m / 60)} h`
  return `hace ${Math.round(m / 1440)} d`
}

// ---- numbers ----
const nf = new Map<string, Intl.NumberFormat>()
export const fmtNum = (v: number, digits = 2) => {
  const k = String(digits)
  if (!nf.has(k)) nf.set(k, new Intl.NumberFormat('es-VE', { minimumFractionDigits: digits, maximumFractionDigits: digits }))
  return nf.get(k)!.format(v)
}
export const fmtCur = (v: number, cur: string, digits?: number) => {
  const d = digits ?? (cur === 'VES' && Math.abs(v) >= 1000 ? 0 : 2)
  const sym = cur === 'VES' ? 'Bs' : cur === 'USD' ? '$' : cur
  return cur === 'USD' ? `$${fmtNum(v, d)}` : `${fmtNum(v, d)} ${sym}`
}

// ---- display currency ----
export type Cur = 'USD' | 'VES'
type CurCtx = { cur: Cur; setCur: (c: Cur) => void; rate: number | null; setRate: (r: number | null) => void }
const Ctx = createContext<CurCtx>(null as any)
const load = (): Cur => { try { return localStorage.getItem('plata.cur') === 'VES' ? 'VES' : 'USD' } catch { return 'USD' } }

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [cur, setCurState] = useState<Cur>(load)
  const [rate, setRate] = useState<number | null>(null)
  useEffect(() => { api.overview().then((o) => setRate(o.rates.p2p ?? o.rates.market ?? o.rates.bcv), () => {}) }, [])
  const setCur = (c: Cur) => { setCurState(c); try { localStorage.setItem('plata.cur', c) } catch {} }
  return <Ctx.Provider value={{ cur, setCur, rate, setRate }}>{children}</Ctx.Provider>
}

/** Returns a formatter for USD amounts in the selected display currency. */
export function useMoney() {
  const { cur, rate } = useContext(Ctx)
  const conv = (usd: number) => (cur === 'VES' && rate ? usd * rate : usd)
  const shown: Cur = cur === 'VES' && rate ? 'VES' : 'USD'
  return {
    cur: shown,
    conv,
    usd: (usd: number, digits?: number) => fmtCur(conv(usd), shown, digits),
    /** tx amount: native if it matches the display currency, else via amountUsd */
    tx: (t: TxView) => {
      const nat = t.currency === 'USDT' ? 'USD' : t.currency
      if (nat === shown) return fmtCur(num(t.amount), shown)
      if (t.amountUsd != null) return fmtCur(conv(num(t.amountUsd)), shown)
      return fmtCur(num(t.amount), t.currency)
    },
  }
}
export const useCur = () => useContext(Ctx)

// ---- data loading ----
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setError(null)
    fn().then((d) => alive && setData(d), (e) => alive && setError(String(e.message || e)))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, reload: () => setTick((t) => t + 1) }
}

// ---- primitives ----
export const Card = ({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`rounded-2xl bg-card p-4 ${className}`}>
    {title && (
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
    )}
    {children}
  </section>
)

export const Loading = ({ error }: { error?: string | null }) => (
  <div className="py-10 text-center text-sm text-muted">{error ? `Error: ${error}` : 'Cargando…'}</div>
)

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-full bg-line p-0.5 text-[13px] font-medium">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)}
          className={`rounded-full px-3 py-1 transition ${v === value ? 'bg-card text-fg shadow-sm' : 'text-muted'}`}>{l}</button>
      ))}
    </div>
  )
}

export function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', k)
    document.body.style.overflow = 'hidden'
    return () => { removeEventListener('keydown', k); document.body.style.overflow = '' }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/40 animate-[fade_.15s]" onClick={onClose} />
      <div className="relative max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-bg px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] animate-[up_.2s_ease-out]">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
        {title && <h3 className="mb-3 text-lg font-semibold">{title}</h3>}
        {children}
      </div>
    </div>
  )
}

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block">
    <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
    {children}
  </label>
)
export const inputCls = 'w-full rounded-xl border border-line bg-card px-3 py-2.5 text-[16px] outline-none focus:border-accent'
export const btnCls = 'rounded-xl px-4 py-3 text-[15px] font-semibold active:opacity-70 disabled:opacity-40'

export const SOURCE_BADGE: Record<string, string> = {
  manual_voice: '🎙️', p2p: '💱', card_delta: '💳', pay: 'Pay', manual_text: '✍️', manual_photo: '📷', reconcile: '⚖️', backfill: '⤓',
}

export const SOURCE_LABEL: Record<string, string> = {
  manual_voice: 'Voz', p2p: 'P2P', card_delta: 'Tarjeta', pay: 'Binance Pay', manual_text: 'Texto', manual_photo: 'Foto', reconcile: 'Conciliación', backfill: 'Histórico',
}

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)']

/** "1.234,56" | "1234.56" | "12,5" -> number */
export const parseNum = (s: string) => Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s)
