# Contratos entre módulos (fuente de verdad para los agentes)

Spec completa: `PLAN.md`. Esquema: `api/prisma/schema.prisma` (ya migrado; DB local en `localhost:5433`, `docker compose up -d db`).
Cambios al esquema: sólo añadir (nuevo archivo de migración `prisma/migrations/NNNN_x/migration.sql` vía `prisma migrate diff`), avisar en el reporte final.

## Defaults mientras Randy responde las preguntas abiertas
- Telegram. Cuentas: binance_spot, binance_funding (USDT, synced), mercantil, bdv (VES, ledger), cash_usd (USD, ledger), cash_ves (VES, ledger).
- Justificación: se pide sólo si amount_usd > `JUSTIFY_OVER_USD` (20) o categoría "Otros".
- Tasa para USD de gastos en VES: bolsa FIFO de esa cuenta → si no hay, p2p_avg del día → bcv → none.
- Nudges: `NUDGE_TIMES=13:30,20:30`, silencio `QUIET_HOURS=22:00-08:00`, `NUDGE_DAILY_CAP=4`. TZ America/Caracas.

## Convenciones
- NestJS 12, CommonJS, `tsc` (no tsx: hace falta emitDecoratorMetadata). Prisma 7: `import { PrismaService } from '../db/prisma.service'` (global). Tipos: `../generated/prisma/client`.
- Decimal de Prisma: en servicios, recibir/devolver `number` (convertir con `Number()` en la frontera). Montos siempre positivos.
- Cada módulo se registra en `api/src/app.module.ts` (sólo añadir tu línea de import).
- Tests: `node:test` + `assert`, archivos `*.test.ts` junto al código, uno por lógica no trivial (FIFO de bolsas, delta de funding, parseo). `pnpm test` en `api/`.
- Nada de libs nuevas si stdlib/fetch alcanza. No commits (lo hace el orquestador).

## Propiedad de carpetas
| Agente | Carpetas |
|---|---|
| ledger | `api/src/ledger`, `api/src/fx`, `api/src/insights`, `api/src/http`, `api/prisma/seed.ts` |
| binance | `api/src/binance` |
| bot | `api/src/ai`, `api/src/bot` |
| web | `web/` |

## LedgerModule (`api/src/ledger/ledger.module.ts`, exporta todo)
```ts
// ledger.service.ts
type TxInput = {
  type: 'transfer'|'expense'|'income'|'fee'; status?: 'pending'|'confirmed';
  occurredAt: Date; amount: number; currency: string;
  fromAccountId?: number; toAccountId?: number; toAmount?: number;
  categoryId?: number; merchant?: string; note?: string; justification?: string;
  source: string; rawEventId?: number; confidence?: number; fxRate?: number; fxSource?: string;
};
class LedgerService {
  create(input: TxInput): Promise<Transaction>;              // calcula amountUsd/fx, asigna bolsa FIFO si expense/fee en VES, guarda version 'create'
  update(id: number, patch: Partial<TxInput>, reason?: string): Promise<Transaction>; // snapshot previo en transaction_versions, re-asigna bolsa si cambia monto/cuenta, aprende merchant_rule si cambia categoría
  confirm(id: number): Promise<Transaction>;
  void(id: number): Promise<Transaction>;                    // status=void, libera bolsa
  undoLast(txId?: number): Promise<Transaction | null>;      // revierte a la última versión (si la última fue 'create' => void)
  recent(n?: number): Promise<TxView[]>;                     // últimos tocados (updatedAt desc), no void
  get(id: number): Promise<TxView | null>;
  balances(): Promise<{ accountId: number; code: string; name: string; currency: string; kind: string; balance: number; balanceUsd: number | null; lastReconciledAt: Date | null }[]>;
  reconcile(accountId: number, actual: number): Promise<{ diff: number; tx: Transaction | null }>; // diff<0 => expense pending source='reconcile' justified=false
  accountByCode(code: string): Promise<Account>;
  accountByPayMethod(payMethodName: string): Promise<Account | null>;
}
type TxView = Transaction & { category: Category | null; fromAccount: Account | null; toAccount: Account | null };

// bags.service.ts
class BagsService {
  open(p2pTx: Transaction, accountId: number, amountVes: number, rate: number): Promise<Bag>;
  openBags(): Promise<(Bag & { allocatedCount: number })[]>; // remaining > 0, not closed, not muted
  mute(bagId: number): Promise<void>;
  explainRest(bagId: number, how: 'savings'|'spent', categoryId?: number): Promise<void>; // cierra bolsa (ahorro) o crea gasto por el resto
}

// categories.service.ts
class CategoriesService {
  list(): Promise<Category[]>;                              // con path "Comida › Panadería"
  byPath(path: string): Promise<Category | null>;           // match flexible (case/acentos)
  ruleFor(merchant: string): Promise<MerchantRule | null>;
  learn(merchant: string, categoryId: number, accountId?: number): Promise<void>;
}
```
## FxModule (`api/src/fx`)
```ts
class FxService {
  rate(date: Date, source?: 'bcv'|'p2p_avg'|'market'): Promise<number | null>;   // VES por USD, último <= date
  upsert(date: Date, source: string, vesPerUsd: number): Promise<void>;
  // cron diario: scrape BCV (bcv.org.ve, fallback pydolarve API) -> upsert 'bcv'
}
```
## InsightsModule (`api/src/insights`) — lo usan el bot (tools LLM) y el HTTP
```ts
type Range = { from: Date; to: Date };
class InsightsService {
  spendSummary(r: Range & { groupBy: 'category'|'account'|'merchant'|'day'; currency?: 'USD'|'VES' }): Promise<{ key: string; label: string; total: number; count: number }[]>;
  listTransactions(q: Partial<Range> & { categoryId?: number; accountId?: number; merchant?: string; text?: string; min?: number; max?: number; type?: string; status?: string; limit?: number; cursor?: number }): Promise<{ items: TxView[]; nextCursor: number | null }>;
  comparePeriods(a: Range, b: Range, groupBy: 'category'|'account'|'merchant'): Promise<{ key: string; label: string; a: number; b: number; delta: number }[]>;
  bagStatus(opts: { bagId?: number; openOnly?: boolean }): Promise<{ bag: Bag; account: string; spent: number; remaining: number; txs: TxView[] }[]>;
  overview(): Promise<{ netWorthUsd: number; today: number; week: number; month: number; lastMonth: number; toJustify: number; pending: number; rates: { bcv: number|null; p2p: number|null }; spark: { date: string; total: number }[] }>;
  heatmap(r: Range): Promise<{ dow: number; hour: number; total: number }[]>;
  rateHistory(r: Range): Promise<{ date: string; bcv: number|null; p2p: number|null }[]>;
}
```
Gastos = type in (expense, fee), status != void. Totales en USD por defecto (amountUsd).

## HTTP (`api/src/http`, prefijo global `/api`) — lo consume `web/`
Auth guard: header `Authorization: tma <initData>` (HMAC con TG_TOKEN, user.id == TG_ALLOWED_ID, auth_date < 24h) **o** cookie `plata_session` (tabla web_sessions). `GET /api/auth/magic?token=` canjea token (creado por el bot con `AuthService.createMagicToken(): Promise<string>`, 10 min) → set cookie → redirect `/`.
```
GET  /api/overview                         -> InsightsService.overview()
GET  /api/transactions?from&to&categoryId&accountId&type&status&text&cursor&limit
PATCH /api/transactions/:id   body Partial<TxInput>
POST /api/transactions/:id/void | /confirm | /undo
POST /api/transactions        body TxInput (manual desde web)
GET  /api/accounts                         -> balances()
POST /api/accounts/:id/reconcile  {actual}
GET  /api/categories
GET  /api/insights/summary?from&to&groupBy&currency
GET  /api/insights/compare?aFrom&aTo&bFrom&bTo&groupBy
GET  /api/insights/heatmap?from&to
GET  /api/insights/rates?from&to
GET  /api/bags?openOnly=1
POST /api/ask  {question} -> {answer: string, table?: {columns: string[], rows: (string|number)[][]}, chart?: {type:'bar'|'line', data:{label:string,value:number}[]}}   (implementa bot: AskService en api/src/ai, el controller de ledger sólo delega)
```
Fechas ISO en query/JSON. Decimales como number.

## Binance → resto (sin llamadas al bot)
El módulo binance crea transacciones vía `LedgerService.create`, bolsas vía `BagsService.open`, y **encola nudges insertando filas en `pending_prompts`** (el bot las despacha):
| kind | refId | payload | cuándo |
|---|---|---|---|
| `p2p_intro` | bag.id | `{usdt, ves, rate, account}` | al detectar SELL completado (dueAt=now) |
| `bag_followup` | bag.id | `{}` | uno por cada NUDGE_TIMES siguiente del mismo día (el dispatcher se salta si la bolsa ya está vacía/muted) |
| `reconcile` | account.id | `{expected}` | día siguiente 09:00 si la bolsa sigue con saldo |
| `card_delta` | tx.id (expense pending, source card_delta) | `{usdt, at}` | delta de funding sin explicar |
| `pay_classify` | tx.id | `{amount, currency, counterparty}` | Pay saliente a persona |
| `ask_account` | tx.id | `{payMethodName}` | payMethodName no mapea a cuenta |
`BinanceService` también expone `syncNow(): Promise<void>` y `backfill(): Promise<{p2p:number,pay:number}>` (el bot los usa en /sync, /backfill).

## Bot/AI → resto
- `AiModule` exporta `LlmService` (chat JSON vía omniroute), `EmbeddingsService.upsertFor(ownerType, ownerId, content)` + `search(query,k)`, `AskService.ask(question)`, `TranscribeService`.
- El bot llama `EmbeddingsService.upsertFor('transaction', tx.id, …)` tras crear/editar (ledger no depende de ai).
- `AuthService.createMagicToken()` vive en `api/src/http/auth.service.ts` (ledger lo implementa; bot lo usa en /panel).
