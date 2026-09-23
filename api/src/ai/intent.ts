// Pure prompt builder + response normalizer for the one-call intent/extraction step (PLAN 3.1/3.2).

export const INTENTS = ['add_expense', 'add_income', 'edit', 'undo', 'delete', 'answer_prompt', 'ask', 'set_balance', 'smalltalk'] as const;
export type Intent = (typeof INTENTS)[number];

export type Item = {
  amount: number | null; currency: string | null; account: string | null; merchant: string | null;
  category: string | null; occurredAt: Date; note: string | null;
};
export type Parsed = {
  intent: Intent; items: Item[]; targetTxId: number | null; patch: Partial<Item> | null;
  balance: { account: string | null; amount: number } | null; confidence: number; needs: string[]; reply: string | null; sync: boolean;
};
export type IntentCtx = {
  now: Date;
  accounts: { code: string; name: string; currency: string; balance: number }[];
  categories: string[];
  turns: { role: string; text: string }[];
  recent: string[];
  pending: string | null;
};

const OFF = 4 * 3600e3; // America/Caracas = UTC-4 fijo (sin horario de verano desde 2016)
/** "2026-09-22T08:30" hora de Caracas */
export const caracasIso = (d: Date) => new Date(d.getTime() - OFF).toISOString().slice(0, 16);

export const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export const INTENT_SCHEMA =
  '{"intent":"add_expense|add_income|edit|undo|delete|answer_prompt|ask|set_balance|smalltalk","items":[{"amount":number|null,"currency":"VES|USD|USDT"|null,"account":"<code>"|null,"merchant":string|null,"category":"<ruta>"|null,"occurred_at":"YYYY-MM-DDTHH:mm"|null,"note":string|null}],"target_tx_id":number|null,"patch":{...campos de item a cambiar}|null,"balance":{"account":"<code>","amount":number}|null,"confidence":0..1,"needs":[],"sync":boolean,"reply":string|null}';

export function buildIntentPrompt(text: string, ctx: IntentCtx): string {
  const accts = ctx.accounts.map((a) => `- ${a.code} (${a.name}, ${a.currency}): ~${Math.round(a.balance * 100) / 100}`).join('\n');
  const turns = ctx.turns.map((t) => `${t.role === 'user' ? 'Yo' : 'Bot'}: ${t.text}`).join('\n') || '(ninguno)';
  return `Eres el parser de un bot de gastos personales en Venezuela. Ahora: ${caracasIso(ctx.now)} (America/Caracas).
Cuentas (código, moneda, saldo estimado):
${accts}
Categorías: ${ctx.categories.join(' | ')}

Últimos turnos:
${turns}
Últimas transacciones (#id):
${ctx.recent.join('\n') || '(ninguna)'}
Prompt pendiente del bot: ${ctx.pending ?? '(ninguno)'}

Reglas:
- IMPORTANTE: tú NO respondes al usuario ni ejecutas nada; sólo extraes. El bot ejecuta lo que pongas en el JSON.
- Si el mensaje pide registrar uno o más gastos, intent=add_expense con TODOS los items, aunque también traiga otras órdenes ("sincroniza", "y luego…"). Nunca lo trates como smalltalk.
- sync=true si pide sincronizar/actualizar Binance (puede ir junto con items; el bot sincroniza primero).
- Si el mensaje es una confirmación ("sí", "dale", "hazlo", "ok") de gastos que el Bot mencionó en los últimos turnos y que no aparecen en Últimas transacciones, intent=add_expense con esos items.
- intent: add_expense (gasté/pagué/compré), add_income (me pagaron/cobré), edit (corrige una tx: "no, eran 500", "cámbialo a BDV"), undo ("deshaz eso"), delete ("borra el de la gasolina"), answer_prompt (responde al prompt pendiente), ask (pregunta sobre sus gastos/saldos), set_balance ("mercantil tiene 8400"), smalltalk (sólo charla, nada que registrar; pon una respuesta corta y cálida en "reply", SIN afirmar ni prometer que hiciste o harás algo).
- Jerga: "bs", "bolos", "bolívares" = VES; "dólares", "verdes", "$", "dls" = USD; "usdt" = USDT. "mil" y "lucas" = miles ("5 lucas" = 5000, casi siempre Bs). "pago móvil" = cuenta bancaria (mercantil o bdv); si no dice cuál, account=null. "efectivo" = cash_usd o cash_ves según la moneda. "tarjeta", "la Binance", "spot", "funding" = binance.
- Un mensaje puede traer varios gastos: un item por cada uno. Montos siempre positivos.
- occurred_at en hora local sin zona; "ayer", "anoche", "el lunes" relativos a ahora. Si no dice, null.
- merchant: el lugar o a quién se pagó, tal como lo dice ("panadería", "farmacia", "Farmatodo"), aunque sea genérico. category: exactamente una ruta de la lista; si no sabes, null.
- edit/undo/delete: target_tx_id = #id de la lista (en edit/undo por defecto la más reciente; en delete null si no está claro cuál). En edit, "patch" sólo con los campos que cambian.
- confidence: qué tan seguro estás de todo el registro. needs: campos que faltan (amount, account, category).

Mensaje: ${JSON.stringify(text)}`;
}

/** "350", "1.200", "1.200,50", "1,5", "5 mil", "5k", "3 lucas", "$20" -> number */
export function parseAmount(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : null;
  if (typeof input !== 'string') return null;
  const s = norm(input);
  const m = s.match(/(\d[\d.,]*)\s*(mil|lucas?|k)?/);
  if (!m) return null;
  let n = m[1];
  if (/,\d{1,2}$/.test(n)) n = n.replace(/\./g, '').replace(',', '.'); // 1.200,50
  else if (/\.\d{3}($|\.)/.test(n) || /,\d{3}($|,)/.test(n)) n = n.replace(/[.,]/g, ''); // 1.200 / 1,200
  else n = n.replace(',', '.');
  let v = Number(n);
  if (m[2]) v *= 1000;
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function normCurrency(c: unknown): string | null {
  if (typeof c !== 'string' || !c.trim()) return null;
  const s = norm(c);
  if (/^(ves|bs|bss|bsf|bsd|bol)/.test(s)) return 'VES';
  if (/usdt|tether/.test(s)) return 'USDT';
  if (/usd|\$|dol|verde|dls/.test(s)) return 'USD';
  return null;
}

export function normAccount(a: unknown, codes: string[], currency: string | null): string | null {
  if (typeof a !== 'string' || !a.trim()) return null;
  const s = norm(a).replace(/\s/g, '_');
  if (codes.includes(s)) return s;
  const t = norm(a);
  const pick = (c: string) => (codes.includes(c) ? c : null);
  if (/mercantil/.test(t)) return pick('mercantil');
  if (/bdv|venezuela/.test(t)) return pick('bdv');
  if (/binance|funding|spot|tarjeta|card/.test(t)) return pick('binance');
  if (/efectivo|cash/.test(t)) return pick(currency === 'VES' ? 'cash_ves' : 'cash_usd');
  return null;
}

/** Local "YYYY-MM-DDTHH:mm" (Caracas) or full ISO -> Date. Invalid/missing -> now. */
export function parseLocalDate(s: unknown, now: Date): Date {
  if (typeof s !== 'string' || !s.trim()) return now;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.length === 10 ? s + 'T12:00' : s}-04:00`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) || d.getTime() > now.getTime() + 3600e3 ? now : d;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() && v !== 'null' ? v.trim() : null);

function normItem(raw: any, codes: string[], now: Date, accountCurrency: Map<string, string>): Item {
  let currency = normCurrency(raw?.currency);
  const account = normAccount(raw?.account, codes, currency);
  currency ??= account ? accountCurrency.get(account) ?? null : null;
  return {
    amount: parseAmount(raw?.amount), currency, account, merchant: str(raw?.merchant),
    category: str(raw?.category), occurredAt: parseLocalDate(raw?.occurred_at, now), note: str(raw?.note),
  };
}

export function normalizeIntent(raw: any, ctx: { now: Date; accounts: { code: string; currency: string }[] }): Parsed {
  const codes = ctx.accounts.map((a) => a.code);
  const cur = new Map(ctx.accounts.map((a) => [a.code, a.currency]));
  const intent: Intent = INTENTS.includes(raw?.intent) ? raw.intent : 'smalltalk';
  const items = (Array.isArray(raw?.items) ? raw.items : []).map((i: any) => normItem(i, codes, ctx.now, cur));
  let patch: Partial<Item> | null = null;
  if (raw?.patch && typeof raw.patch === 'object') {
    const p = raw.patch, full = normItem(p, codes, ctx.now, cur);
    patch = {};
    for (const k of ['amount', 'currency', 'account', 'merchant', 'category', 'note'] as const)
      if (p[k] != null && full[k] != null) (patch as any)[k] = full[k];
    if (p.occurred_at) patch.occurredAt = full.occurredAt;
  }
  const bAmount = parseAmount(raw?.balance?.amount);
  const needs = new Set<string>();
  if (intent === 'add_expense' || intent === 'add_income')
    for (const it of items) {
      if (it.amount == null) needs.add('amount');
      if (!it.account) needs.add('account');
      if (!it.category && intent === 'add_expense') needs.add('category');
    }
  const c = Number(raw?.confidence);
  const tid = Number(raw?.target_tx_id);
  return {
    intent, items, patch,
    targetTxId: Number.isInteger(tid) && tid > 0 ? tid : null,
    balance: bAmount != null ? { account: normAccount(raw?.balance?.account, codes, null), amount: bAmount } : null,
    confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5,
    needs: [...needs],
    reply: str(raw?.reply),
    sync: raw?.sync === true,
  };
}

type TxLike = {
  id: number; type: string; status: string; occurredAt: Date; amount: unknown; currency: string; merchant: string | null;
  category?: { name: string } | null; fromAccount?: { code: string } | null; toAccount?: { code: string } | null;
};
/** "#12 2026-09-22T08:30 expense 350 VES · panadería · Panadería · mercantil · confirmed" (for LLM context) */
export const txLine = (t: TxLike) =>
  `#${t.id} ${caracasIso(t.occurredAt)} ${t.type} ${Number(t.amount)} ${t.currency}` +
  [t.merchant, t.category?.name, t.fromAccount?.code ?? t.toAccount?.code, t.status].filter(Boolean).map((s) => ` · ${s}`).join('');
