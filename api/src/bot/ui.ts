// Pure helpers for the bot: time in Caracas, money formatting, tx cards. No Nest/grammY here (tested in ui.test.ts).
import type { EntryView, MonthView } from '../ledger/plan.service';

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
  fxSource: string | null; merchant: string | null; note: string | null; occurredAt: Date; debt?: { name: string } | null; excluded?: boolean;
  category?: { name: string; emoji: string | null } | null; fromAccount?: { name: string } | null; toAccount?: { name: string; currency?: string } | null; toAmount?: unknown;
  planEntry?: { item: { name: string } } | null;
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
  if (t.debt) rows.push(`💳 Abono a ${esc(t.debt.name)}`);
  if (t.planEntry) rows.push(`📅 Plan: ${esc(t.planEntry.item.name)}`);
  if (t.excluded) rows.push('🚫 Solo registro: no cuenta como gasto');
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

// ── plan del mes ──
/** Compact for lists: "$300", "$18,20", "4.000 Bs" (USDT reads as dollars). */
export const amt = (n: number, cur: string) => (cur === 'VES' ? money(Math.round(n), 'VES') : `$${nf(n, Math.abs(n % 1) > 0.004 ? 2 : 0)}`);
const signed = (n: number, cur: string) => `${n > 0 ? '+' : '−'}${amt(Math.abs(n), cur)}`;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** One plan line for /plan and the reminders. */
export function planLine(v: EntryView): string {
  const e = v.emoji ?? (v.kind === 'bill' ? '🧾' : '💰');
  if (v.kind === 'envelope') {
    const over = v.status === 'over' ? ` 🔴 ${signed(v.diff, v.currency)}` : '';
    return `${e} ${esc(v.name)} — ${amt(v.spent, v.currency)} de ${amt(v.planned, v.currency)} (${pct(v.spentUsd, v.plannedUsd)}%)${over}`;
  }
  if (v.status === 'skipped') return `⏭️ ${esc(v.name)} — este mes no`;
  if (v.status === 'paid') {
    const d = Math.abs(v.diff) >= 0.01 * Math.max(1, v.planned) ? ` (${signed(v.diff, v.currency)})` : '';
    return `✅ ${esc(v.name)} — ${amt(v.planned, v.currency)} → pagaste ${amt(v.spent, v.currency)}${d}`;
  }
  const late = /^venció/.test(v.dueLabel), soon = /hoy|mañana|tienes hasta/.test(v.dueLabel);
  const icon = late ? '⚠️' : soon ? '⏰' : '◻️';
  const part = v.status === 'partial' ? ` · llevas ${amt(v.spent, v.currency)}` : '';
  return `${icon} ${esc(v.name)} — ${amt(v.planned, v.currency)}${part} · ${v.dueLabel}`;
}

/** /plan: totals, bills (unpaid first, by due date), envelopes, what fell outside the plan. */
export function planText(m: MonthView): string {
  if (!m.entries.length) return `📅 No tienes plan para ${m.label} todavía.
Dime «agrega alquiler 300$ del 1 al 5 al plan» o créalo en el panel.`;
  const t = m.totals;
  const bills = m.entries.filter((v) => v.kind === 'bill');
  const rank = (v: EntryView) => (v.status === 'paid' ? 2 : v.status === 'skipped' ? 3 : 0);
  bills.sort((a, b) => rank(a) - rank(b) || (a.dueFrom ?? '9999').localeCompare(b.dueFrom ?? '9999'));
  const envs = m.entries.filter((v) => v.kind === 'envelope');
  const head = m.isCurrent
    ? `Presupuesto <b>${usd(t.plannedUsd)}</b> · llevas ${usd(t.allSpentUsd)} (${pct(t.allSpentUsd, t.plannedUsd)}%) · pronóstico ${usd(t.allForecastUsd)}`
    : `Presupuesto <b>${usd(t.plannedUsd)}</b> · gastado ${usd(t.allSpentUsd)}`;
  const rows = [`📅 <b>Plan de ${m.label}</b>`, head];
  if (m.isCurrent && t.allForecastUsd > t.plannedUsd * 1.02) rows.push(`🔺 Vas ${usd(t.allForecastUsd - t.plannedUsd)} por encima del plan`);
  if (bills.length) rows.push('', `<b>Pagos</b> (${t.billsPaid}/${t.bills} pagados)`, ...bills.map(planLine));
  if (envs.length) rows.push('', '<b>Presupuestos</b>', ...envs.map(planLine));
  if (t.unplannedUsd > 0.005) rows.push('', `Fuera del plan: <b>${usd(t.unplannedUsd)}</b>${m.unplanned.length ? ` (${m.unplanned.slice(0, 3).map((u) => `${esc(u.label)} ${usd(u.total)}`).join(', ')})` : ''}`);
  return rows.join('\n');
}

/** "¿Ya pagaste?" — one bill with its window, or several grouped in one message. */
export function planDueText(vs: EntryView[]): string {
  if (vs.length === 1) {
    const v = vs[0];
    const part = v.status === 'partial' ? `\nLlevas ${amt(v.spent, v.currency)}, faltan ${amt(v.planned - v.spent, v.currency)}.` : '';
    const when = v.dueFrom ? v.dueLabel[0].toUpperCase() + v.dueLabel.slice(1) : 'No lo has registrado este mes';
    return `📅 <b>${esc(v.name)}</b> · ${amt(v.planned, v.currency)}\n${when}.${part} ¿Ya lo pagaste?`;
  }
  return `📅 <b>Pagos del plan</b> sin registrar:\n${vs.map(planLine).join('\n')}\n\nToca los que ya pagaste (por lo planificado). Si fue otro monto, dímelo: «pagué la luz 18$».`;
}

/** After "ya pagué": planned vs what really went out (rates/estimates). */
export function paidText(v: EntryView): string {
  const d = v.diff, close = Math.abs(d) < 0.01 * Math.max(1, v.planned);
  const how = close ? 'justo lo planificado 👌' : `${signed(d, v.currency)} ${d > 0 ? 'más' : 'menos'} de lo planificado`;
  const done = v.status === 'paid' ? '✅' : '🟡';
  return `${done} <b>${esc(v.name)}</b>: planificado ${amt(v.planned, v.currency)}, pagaste ${amt(v.spent, v.currency)} (${how}).${v.status === 'partial' ? ` Faltan ${amt(v.planned - v.spent, v.currency)}.` : ''}`;
}

/** 1st of the month: how last month closed + what this one looks like. */
export function monthTurnText(prev: MonthView, cur: MonthView): string {
  const rows: string[] = [];
  const p = prev.totals;
  if (prev.entries.length) {
    const d = p.allSpentUsd - p.plannedUsd;
    rows.push(`🗓️ <b>Cerraste ${prev.label}</b>: planificaste ${usd(p.plannedUsd)} y gastaste ${usd(p.allSpentUsd)} (${d >= 0 ? '+' : '−'}${usd(Math.abs(d))}).`);
    if (p.unplannedUsd > 0.005) rows.push(`Fuera del plan: ${usd(p.unplannedUsd)}.`);
    const over = prev.entries.filter((v) => !v.skipped && v.diffUsd > 1).sort((a, b) => b.diffUsd - a.diffUsd).slice(0, 3);
    if (over.length) rows.push(`Lo que más se pasó: ${over.map((v) => `${esc(v.name)} +${usd(v.diffUsd)}`).join(', ')}.`);
    rows.push('');
  }
  const bills = cur.entries.filter((v) => v.kind === 'bill' && !v.skipped);
  const first = bills.filter((v) => v.dueFrom).sort((a, b) => a.dueFrom!.localeCompare(b.dueFrom!)).slice(0, 3);
  rows.push(`📅 <b>Plan de ${cur.label}: ${usd(cur.totals.plannedUsd)}</b> · ${bills.length} pagos, ${cur.entries.filter((v) => v.kind === 'envelope').length} presupuestos.`);
  if (first.length) rows.push(`Primeros: ${first.map((v) => `${esc(v.name)} (${v.dueFrom!.slice(8, 10)}/${v.dueFrom!.slice(5, 7)})`).join(', ')}.`);
  rows.push('Te aviso cuando toque cada pago. /plan para verlo.');
  return rows.join('\n');
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
