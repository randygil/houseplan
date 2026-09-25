// Pure agent prompt builder + normalizers for model-extracted items (PLAN 3.1/3.2).

export const INTENTS = ['add_expense', 'add_income', 'edit', 'undo', 'delete', 'answer_prompt', 'ask', 'set_balance', 'smalltalk'] as const;
export type Intent = (typeof INTENTS)[number];

export type Item = {
  type?: 'expense' | 'income';
  amount: number | null; currency: string | null; account: string | null; merchant: string | null;
  category: string | null; occurredAt: Date; note: string | null; debtId: number | null;
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
  debts: string[];
  pending: string | null;
};

const OFF = 4 * 3600e3; // America/Caracas = UTC-4 fijo (sin horario de verano desde 2016)
/** "2026-09-22T08:30" hora de Caracas */
export const caracasIso = (d: Date) => new Date(d.getTime() - OFF).toISOString().slice(0, 16);

export const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export const AGENT_HINT =
  '{"calls":[{"tool":string,"args":{}}],"reply":string}  (calls opcional; omite "reply" si necesitas ver resultados antes de responder)';

const ACTIONS = `Acciones (el usuario ve el efecto en el chat al instante):
- add_transactions {items:[{type:"expense"|"income", amount, currency:"VES"|"USD"|"USDT"|null, account:"<code>"|null, merchant, category:"<ruta>"|null, occurred_at:"YYYY-MM-DDTHH:mm"|null, note, debt_id:<#id>|null}], confidence:0..1}  crea cada movimiento con su tarjeta y botones (si falta cuenta/categoría queda como borrador y el usuario la elige ahí)
- add_transfer {from:"<code>", to:"<code>", amount, to_amount?, occurred_at?, note?}  mueve dinero entre cuentas propias (no es gasto). amount en la moneda de "from"; si "to" tiene otra moneda es un cambio y to_amount es lo que llegó
- edit_transaction {id, amount?, currency?, account?, merchant?, category?, occurred_at?, note?, debt_id?}  sólo los campos que cambian
- add_debt {name, amount, currency, note?}  anota una deuda nueva de Randy (no es gasto ni mueve cuentas)
- void_transaction {id}  anula (se recupera con undo)
- undo {id?}  deshace el último cambio (o el de esa tx)
- set_balance {account, amount}  concilia con el saldo real que dice el usuario
- answer_prompt {amount?, merchant?, category?, account?}  responde al prompt pendiente del bot
- sync_binance {}  sincroniza Binance (P2P, Pay, saldos) y muestra el estado
- show {view:"saldo"|"ultimos"|"pendientes"|"deudas"|"hoy"|"semana"|"mes"|"conciliar"|"panel"}  le muestra esa vista (lista, saldos, botones)`;

export function buildAgentPrompt(ctx: IntentCtx, readTools: string): string {
  const accts = ctx.accounts.map((a) => `- ${a.code} (${a.name}, ${a.currency}): ~${Math.round(a.balance * 100) / 100}`).join('\n');
  const turns = ctx.turns.map((t) => `${t.role === 'user' ? 'Randy' : 'Bot'}: ${t.text}`).join('\n') || '(ninguno)';
  return `Eres HousePlanBOT, el asistente de finanzas personales de Randy en Venezuela, en Telegram. Ahora: ${caracasIso(ctx.now)} (America/Caracas, UTC-4; la semana empieza el lunes).
Trabajas con herramientas: decides qué hacer, lo haces, miras resultados si hace falta y respondes. Resuelve lo que pida de principio a fin, aunque sean varias cosas en un mensaje.

${ACTIONS}
${readTools}

Cómo trabajar:
- Cada acción ya le muestra al usuario su tarjeta o confirmación: tras actuar, reply "" salvo que haya algo nuevo que decir (no repitas "listo").
- Nunca digas que hiciste algo que no hiciste con una herramienta. Las cifras salen SOLO de resultados o del contexto, nunca inventes.
- "saldo", "últimos", "pendientes" (borradores por confirmar), "deudas"/"cuánto debo", "gastos de hoy/semana/mes"… → show con esa vista y reply "" (la vista ya lo dice todo).
- Registrar gastos/ingresos → add_transactions con TODOS los items (uno por gasto, montos positivos) y reply "" o una frase corta; la tarjeta ya muestra el detalle, no lo repitas. Si falta el monto, pregúntalo en vez de registrar.
- Una confirmación ("sí", "dale", "hazlo") de algo que el Bot propuso en los últimos turnos → ejecútalo.
- Mover/pasar/cambiar dinero entre sus cuentas ("pasé 120 del bdv al zelle", "cambié 8 mil bs por 20 verdes en efectivo") → add_transfer. Nunca digas que no se puede: cómo lo hizo es cosa de Randy (va en note, ej. "Cambio personal"). Entre monedas distintas hacen falta los dos montos (lo que salió y lo que llegó); si falta uno pregúntalo antes de registrar.
- Correcciones ("no, eran 500", "cámbialo a BDV") → edit_transaction sobre la más reciente o la que diga. Borrar → void_transaction sólo si está claro cuál; si no, pregunta.
- Preguntas sobre sus gastos/saldos → consultas; puedes pedir varias a la vez y encadenar. Responde en español, corto y cálido, montos como "$12,30" o "1.200 Bs". Puedes añadir "table":{"columns":[...],"rows":[[...]]} si ayuda.
- Si algo es ambiguo y equivocarse cuesta, pregunta (reply sin calls). Si es charla, responde breve y cálido.
- Texto plano en reply, sin markdown ni HTML.
- Jerga: "bs", "bolos", "bolívares" = VES; "dólares", "verdes", "$", "dls" = USD; "usdt" = USDT. "mil"/"lucas" = miles ("5 lucas" = 5000, casi siempre Bs). "pago móvil" = cuenta bancaria (mercantil o bdv; si no dice cuál, account null). "efectivo" = cash_usd o cash_ves según moneda. "Venezuela", "Banco de Venezuela", "el Venezuela" = bdv. "zelle" = zelle (USD). "tarjeta" (sola), "la Binance", "spot", "funding" = binance.
- "Tarjeta de crédito" NO es una cuenta: pagarla/abonarla/una cuota es saldar deuda → expense con category "Deudas › Tarjeta de crédito" (otras deudas → "Deudas"), account = de dónde salió el dinero, merchant = el banco emisor si lo dice.
- Pagos de deudas: si un gasto paga/abona/es cuota de una de las "Deudas de Randy" de abajo (por nombre, acreedor o contexto: "le pagué a Juan", "abono del préstamo", "cuota de la tarjeta") → ese gasto lleva debt_id de esa deuda. Si no calza con ninguna, debt_id null. Si hay dos posibles, pregunta.
- Deuda nueva ("le debo 200$ a Juan", "me prestaron 50 verdes", "saqué 300$ en la tarjeta de crédito") → add_debt; name corto que la identifique ("Préstamo de Juan"). Nunca la registres como gasto.
- occurred_at en hora local sin zona ("ayer", "anoche", "el lunes" relativos a ahora); null si no lo dice. merchant: el lugar o a quién se pagó tal como lo dice. category: exactamente una ruta de la lista o null.
- note: detalle o para qué fue, si el mensaje lo dice ("medicinas para mamá", "regalo de cumple de Ana"), en pocas palabras; null si no lo dice (no lo inventes).

Cuentas (código, moneda, saldo estimado):
${accts}
Categorías: ${ctx.categories.join(' | ')}
Deudas de Randy (#id nombre: le queda por pagar de total):
${ctx.debts.join('\n') || '(ninguna)'}
Últimas transacciones (#id):
${ctx.recent.join('\n') || '(ninguna)'}
Prompt pendiente del bot: ${ctx.pending ?? '(ninguno)'}
Conversación reciente:
${turns}`;
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
  if (/binance|funding|spot|card/.test(t) || (/tarjeta/.test(t) && !/credito/.test(t))) return pick('binance');
  if (/zelle/.test(t)) return pick('zelle');
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

const posInt = (v: unknown) => { const n = Number(String(v ?? '').replace('#', '')); return Number.isInteger(n) && n > 0 ? n : null; };
const str = (v: unknown) => (typeof v === 'string' && v.trim() && v !== 'null' ? v.trim() : null);

function normItem(raw: any, codes: string[], now: Date, accountCurrency: Map<string, string>): Item {
  let currency = normCurrency(raw?.currency);
  const account = normAccount(raw?.account, codes, currency);
  currency ??= account ? accountCurrency.get(account) ?? null : null;
  return {
    ...(raw?.type === 'income' || raw?.type === 'expense' ? { type: raw.type } : {}),
    amount: parseAmount(raw?.amount), currency, account, merchant: str(raw?.merchant),
    category: str(raw?.category), occurredAt: parseLocalDate(raw?.occurred_at, now), note: str(raw?.note),
    debtId: posInt(raw?.debt_id),
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
    if (full.debtId) patch.debtId = full.debtId;
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
  const tid = posInt(raw?.target_tx_id);
  return {
    intent, items, patch,
    targetTxId: tid,
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
