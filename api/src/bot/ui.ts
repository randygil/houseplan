// Pure helpers for the bot: time in Caracas, money formatting, tx cards. No Nest/grammY here (tested in ui.test.ts).

const OFF = 4 * 3600e3; // America/Caracas = UTC-4 fijo
const DAY = 864e5;
const local = (d: Date) => new Date(d.getTime() - OFF); // read with getUTC*

export const startOfDay = (d: Date) => new Date(Math.floor(local(d).getTime() / DAY) * DAY + OFF);
export const startOfWeek = (d: Date) => {
  const s = startOfDay(d);
  return new Date(s.getTime() - ((local(s).getUTCDay() + 6) % 7) * DAY);
};
export const startOfMonth = (d: Date) => {
  const l = local(d);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1) + OFF);
};
export const hhmm = (d: Date) => local(d).toISOString().slice(11, 16);
/** "HH:MM" on the local day of `day` */
export const atLocal = (day: Date, t: string) => {
  const [h, m] = t.split(':').map(Number);
  return new Date(startOfDay(day).getTime() + (h * 60 + m) * 60e3);
};
/** QUIET_HOURS "22:00-08:00" (may wrap midnight) */
export function inQuiet(d: Date, spec = '22:00-08:00'): boolean {
  const [a, b] = spec.split('-').map((s) => s.trim());
  if (!a || !b) return false;
  const t = hhmm(d);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}
const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
/** "de esta mañana" | "de hoy" | "de ayer" | "del lunes" | "del 12/09" */
export function dayLabel(d: Date, now: Date): string {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / DAY);
  if (days === 0) return hhmm(d) < '12:00' ? 'de esta mañana' : 'de hoy';
  if (days === 1) return 'de ayer';
  if (days < 7) return `del ${DOW[local(d).getUTCDay()]}`;
  const l = local(d);
  return `del ${String(l.getUTCDate()).padStart(2, '0')}/${String(l.getUTCMonth() + 1).padStart(2, '0')}`;
}

const nf = (n: number, dec: number) =>
  new Intl.NumberFormat('es-VE', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n);
/** 1200 VES -> "1.200 Bs", 6 USD -> "$6,00", 23.4 USDT -> "23,40 USDT" */
export function money(amount: number, currency: string): string {
  if (currency === 'USD') return `$${nf(amount, 2)}`;
  if (currency === 'VES') return `${nf(amount, Number.isInteger(amount) ? 0 : 2)} Bs`;
  return `${nf(amount, 2)} ${currency}`;
}
export const usd = (n: number) => money(n, 'USD');

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type CardTx = {
  id: number; type: string; status: string; amount: unknown; currency: string; amountUsd: unknown; fxRate: unknown;
  fxSource: string | null; merchant: string | null; note: string | null; justification: string | null; occurredAt: Date; debt?: { name: string } | null;
  category?: { name: string; emoji: string | null } | null; fromAccount?: { name: string } | null; toAccount?: { name: string; currency?: string } | null; toAmount?: unknown;
};

const FX_LABEL: Record<string, string> = { bag: 'de tu cambio', p2p: 'del cambio', p2p_avg: 'P2P prom.', market: 'P2P mercado', bcv: 'BCV', manual: 'manual' };

/** Tx card (HTML). `catPath` = "Comida › Panadería" when known. */
export function txCard(t: CardTx, catPath?: string | null, now = new Date()): string {
  const amount = Number(t.amount);
  const emoji = t.category?.emoji ?? (t.type === 'income' ? '💰' : t.type === 'transfer' ? '🔁' : '🧾');
  const title = t.merchant || t.category?.name || (t.type === 'income' ? 'Ingreso' : t.type === 'transfer' ? 'Transferencia' : 'Gasto');
  let line = `${emoji} <b>${esc(title)}</b> · ${money(amount, t.currency)}`;
  if (t.currency !== 'USD' && t.amountUsd != null) {
    const fx = t.currency === 'VES' && t.fxRate != null ? ` · tasa ${nf(Number(t.fxRate), 2)}${t.fxSource ? ` ${FX_LABEL[t.fxSource] ?? t.fxSource}` : ''}` : '';
    line += ` (≈ ${usd(Number(t.amountUsd))}${fx})`;
  }
  const acct = (t.type === 'income' ? t.toAccount : t.fromAccount ?? t.toAccount)?.name;
  const rows = [line, `Cuenta: ${acct ? esc(acct) : '❓'}   Categoría: ${catPath ? esc(catPath) : t.category ? esc(t.category.name) : '❓'}`];
  if (t.type === 'transfer') {
    const got = t.toAmount != null && t.toAccount?.currency ? ` (llegaron ${money(Number(t.toAmount), t.toAccount.currency)})` : '';
    rows[1] = `${esc(t.fromAccount?.name ?? '❓')} → ${esc(t.toAccount?.name ?? '❓')}${got}`;
  }
  const day = dayLabel(t.occurredAt, now).replace(/^de (esta mañana|hoy)$/, 'hoy').replace(/^del? /, '');
  rows.push(`🕒 ${day} ${hhmm(t.occurredAt)}`);
  if (t.note) rows.push(`📝 ${esc(t.note)}`);
  if (t.justification) rows.push(`💬 ${esc(t.justification)}`);
  if (t.debt) rows.push(`💳 Abono a ${esc(t.debt.name)}`);
  rows.push(t.status === 'confirmed' ? '✅ Registrado' : t.status === 'void' ? '❌ Cancelado' : '📝 Borrador');
  return rows.join('\n');
}

/** /deudas: open ones first with what's left, then paid-off ones; total per currency. */
export function debtsText(ds: { name: string; currency: string; amount: number; paid: number; remaining: number }[]): string {
  if (!ds.length) return 'No tienes deudas anotadas 🙌 Dime «le debo 200$ a Juan» para anotar una.';
  const open = ds.filter((d) => d.remaining > 0), done = ds.filter((d) => d.remaining <= 0);
  const rows = open.map((d) => `💳 <b>${esc(d.name)}</b> · queda ${money(d.remaining, d.currency)}${d.paid > 0 ? ` de ${money(d.amount, d.currency)}` : ''}`);
  const tot = new Map<string, number>();
  for (const d of open) tot.set(d.currency, (tot.get(d.currency) ?? 0) + d.remaining);
  if (open.length > 1) rows.push(`\nTotal: <b>${[...tot].map(([c, n]) => money(n, c)).join(' + ')}</b>`);
  if (done.length) rows.push(`\n✅ Saldadas: ${done.map((d) => esc(d.name)).join(', ')}`);
  return rows.join('\n') || 'Todo saldado 🎉';
}

export function needsJustification(t: { type: string; amountUsd: unknown; justification: string | null; debtId?: number | null; category?: { name: string } | null }, overUsd: number): boolean {
  if (t.justification || t.debtId || (t.type !== 'expense' && t.type !== 'fee')) return false;
  return (t.amountUsd != null && Number(t.amountUsd) > overUsd) || /^otros?$/i.test(t.category?.name ?? '');
}

/** Callback data must be ≤64 bytes. */
export const cb = (...parts: (string | number)[]) => {
  const s = parts.join(':');
  if (Buffer.byteLength(s) > 64) throw new Error(`callback_data demasiado largo: ${s}`);
  return s;
};

/** "ayer 8pm", "hoy 13:30", "20/09 19:00", "20/09/2026" -> Date (Caracas). null if unparseable. */
export function parseWhen(input: string, now: Date): Date | null {
  const s = input.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  let day: Date | null = null;
  let rest = s;
  const rel = s.match(/^(hoy|anteayer|ayer)\b/);
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (rel) {
    day = new Date(startOfDay(now).getTime() - { hoy: 0, ayer: 1, anteayer: 2 }[rel[1] as 'hoy'] * DAY);
    rest = s.slice(rel[0].length);
  } else if (dmy) {
    const y = dmy[3] ? Number(dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]) : local(now).getUTCFullYear();
    day = new Date(Date.UTC(y, Number(dmy[2]) - 1, Number(dmy[1])) + OFF);
    rest = s.slice(dmy[0].length);
  }
  const tm = rest.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?/);
  if (!day && !tm) return null;
  day ??= startOfDay(now);
  let h = 12, m = 0;
  if (tm) {
    h = Number(tm[1]);
    m = Number(tm[2] ?? 0);
    if (tm[3]?.startsWith('p') && h < 12) h += 12;
    if (tm[3]?.startsWith('a') && h === 12) h = 0;
  }
  if (h > 23 || m > 59 || Number.isNaN(day.getTime())) return null;
  return new Date(day.getTime() + (h * 60 + m) * 60e3);
}
