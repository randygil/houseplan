import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initData, type TxQuery } from './api'
import { CurrencyProvider, Seg, useCur } from './ui'
import Home from './tabs/Home'
import Movs from './tabs/Movs'
import Analysis from './tabs/Analysis'
import Accounts from './tabs/Accounts'
import Ask from './tabs/Ask'

// ---- Telegram Mini App bootstrap + theme ----
const tg = (window as any).Telegram?.WebApp
function applyTgTheme() {
  if (!tg || !initData) return
  const p = tg.themeParams || {}
  const root = document.documentElement
  root.dataset.theme = tg.colorScheme === 'dark' ? 'dark' : 'light'
  const map: Record<string, string | undefined> = {
    '--bg': p.secondary_bg_color, '--card': p.bg_color, '--fg': p.text_color,
    '--muted': p.hint_color, '--accent': p.button_color, '--accent-fg': p.button_text_color,
  }
  for (const [k, v] of Object.entries(map)) v ? root.style.setProperty(k, v) : root.style.removeProperty(k)
}
if (tg && initData) {
  tg.ready(); tg.expand()
  applyTgTheme()
  tg.onEvent?.('themeChanged', applyTgTheme)
}

const TABS = [
  { id: 'inicio', label: 'Inicio', icon: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z' },
  { id: 'movimientos', label: 'Movimientos', icon: 'M4 6h16M4 12h16M4 18h10' },
  { id: 'analisis', label: 'Análisis', icon: 'M5 20V10M12 20V4M19 20v-7' },
  { id: 'cuentas', label: 'Cuentas', icon: 'M3 7h18v12H3zM3 10h18M7 15h4' },
  { id: 'preguntar', label: 'Preguntar', icon: 'M4 5h16v11H9l-5 4z' },
] as const
type Tab = (typeof TABS)[number]['id']
const tabFromHash = (): Tab => (TABS.find((t) => '#' + t.id === location.hash)?.id ?? 'inicio')

function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash)
  const [preset, setPreset] = useState<TxQuery>({})
  const [unauth, setUnauth] = useState(false)
  const { cur, setCur } = useCur()

  useEffect(() => {
    const h = () => setTab(tabFromHash())
    const u = () => setUnauth(true)
    addEventListener('hashchange', h); addEventListener('plata:401', u)
    return () => { removeEventListener('hashchange', h); removeEventListener('plata:401', u) }
  }, [])
  const go = (t: Tab, q: TxQuery = {}) => { setPreset(q); location.hash = t; window.scrollTo(0, 0) }

  if (unauth)
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-8 text-center">
        <div className="text-5xl">🔒</div>
        <h1 className="text-xl font-semibold">Sesión no válida</h1>
        <p className="text-muted">Abre <b className="text-fg">/panel</b> en el bot de Telegram para entrar.</p>
      </div>
    )

  const current = TABS.find((t) => t.id === tab)!
  return (
    <div className="mx-auto min-h-dvh max-w-lg pb-[calc(72px+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-30 flex items-center justify-between bg-bg/85 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <h1 className="text-[22px] font-bold tracking-tight">{current.label}</h1>
        <Seg value={cur} onChange={setCur} options={[['USD', 'USD'], ['VES', 'Bs']]} />
      </header>
      <main className="px-4">
        {tab === 'inicio' && <Home go={go} />}
        {tab === 'movimientos' && <Movs preset={preset} />}
        {tab === 'analisis' && <Analysis />}
        {tab === 'cuentas' && <Accounts />}
        {tab === 'preguntar' && <Ask />}
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto grid max-w-lg grid-cols-5">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => go(t.id)}
              className={`flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${t.id === tab ? 'text-accent' : 'text-muted'}`}>
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={t.id === tab ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CurrencyProvider><App /></CurrencyProvider>
  </StrictMode>,
)
