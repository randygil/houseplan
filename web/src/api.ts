// Mirrors CONTRACTS.md (HTTP section). Decimals may arrive as strings from Prisma: always read money via num().

export type Account = { id: number; code: string; name: string; currency: string; kind: 'synced' | 'ledger' | string }
export type Category = { id: number; name: string; parentId: number | null; emoji: string | null; path?: string }
export type Money = number | string

export type TxType = 'transfer' | 'expense' | 'income' | 'fee'
export type TxStatus = 'pending' | 'confirmed' | 'void'

export type Transaction = {
  id: number
  type: TxType
  status: TxStatus
  occurredAt: string
  amount: Money
  currency: string
  amountUsd: Money | null
  fxRate: Money | null
  fxSource: string | null
  fromAccountId: number | null
  toAccountId: number | null
  toAmount: Money | null
  categoryId: number | null
  merchant: string | null
  note: string | null
  justified: boolean
  justification: string | null
  source: string
  bagId: number | null
  confidence: number | null
  createdAt: string
  updatedAt: string
}
export type TxView = Transaction & { category: Category | null; fromAccount: Account | null; toAccount: Account | null }

export type TxInput = Partial<{
  type: TxType; status: 'pending' | 'confirmed'; occurredAt: string; amount: number; currency: string
  fromAccountId: number; toAccountId: number; toAmount: number; categoryId: number
  merchant: string; note: string; justification: string; source: string
}>

export type Overview = {
  netWorthUsd: number; today: number; week: number; month: number; lastMonth: number
  toJustify: number; pending: number
  rates: { bcv: number | null; p2p: number | null; market: number | null }
  spark: { date: string; total: number }[]
}

export type Balance = {
  accountId: number; code: string; name: string; currency: string; kind: string
  balance: Money; balanceUsd: Money | null; lastReconciledAt: string | null
}

export type SummaryRow = { key: string; label: string; total: number; count: number }
export type HeatCell = { dow: number; hour: number; total: number }
export type RatePoint = { date: string; bcv: number | null; p2p: number | null; market: number | null }
export type Bag = {
  id: number; p2pTransactionId: number; accountId: number; amountVes: Money; remainingVes: Money
  rate: Money; openedAt: string; closedAt: string | null; muted: boolean
}
export type BagStatus = { bag: Bag; account: string; spent: number; remaining: number; txs: TxView[] }

export type AskAnswer = {
  answer: string
  table?: { columns: string[]; rows: (string | number)[][] }
  chart?: { type: 'bar' | 'line'; data: { label: string; value: number }[] }
}

export type TxQuery = Partial<{
  from: string; to: string; categoryId: number; accountId: number; type: string; status: string
  text: string; cursor: number; limit: number
}>

export const num = (v: Money | null | undefined) => (v == null ? 0 : Number(v))

// ---- transport ----

const tg = (window as any).Telegram?.WebApp
export const initData: string = tg?.initData || ''

export class AuthError extends Error {}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (import.meta.env.VITE_MOCK) {
    const { mock } = await import('./mock')
    return mock(path, init) as T
  }
  const headers: Record<string, string> = { ...(init.headers as any) }
  if (initData) headers.Authorization = `tma ${initData}`
  if (init.body) headers['Content-Type'] = 'application/json'
  const r = await fetch('/api' + path, { ...init, headers, credentials: 'include' })
  if (r.status === 401 || r.status === 403) {
    window.dispatchEvent(new Event('plata:401'))
    throw new AuthError('no autorizado')
  }
  if (!r.ok) throw new Error((await r.text()) || r.statusText)
  const text = await r.text()
  return (text ? JSON.parse(text) : null) as T
}

const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v))
  const s = p.toString()
  return s ? '?' + s : ''
}
const post = <T>(path: string, body?: unknown) =>
  req<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  overview: () => req<Overview>('/overview'),
  transactions: (q: TxQuery) => req<{ items: TxView[]; nextCursor: number | null }>('/transactions' + qs(q)),
  patchTx: (id: number, body: TxInput) => req<Transaction>(`/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  voidTx: (id: number) => post<Transaction>(`/transactions/${id}/void`),
  confirmTx: (id: number) => post<Transaction>(`/transactions/${id}/confirm`),
  undoTx: (id: number) => post<Transaction | null>(`/transactions/${id}/undo`),
  accounts: () => req<Balance[]>('/accounts'),
  reconcile: (id: number, actual: number) => post<{ diff: number; tx: Transaction | null }>(`/accounts/${id}/reconcile`, { actual }),
  categories: () => req<Category[]>('/categories'),
  summary: (q: { from: string; to: string; groupBy: 'category' | 'account' | 'merchant' | 'day'; currency?: 'USD' | 'VES' }) =>
    req<SummaryRow[]>('/insights/summary' + qs(q)),
  heatmap: (q: { from: string; to: string }) => req<HeatCell[]>('/insights/heatmap' + qs(q)),
  rates: (q: { from: string; to: string }) => req<RatePoint[]>('/insights/rates' + qs(q)),
  bags: (openOnly = false) => req<BagStatus[]>('/bags' + qs({ openOnly: openOnly ? 1 : undefined })),
  ask: (question: string) => post<AskAnswer>('/ask', { question }),
}
