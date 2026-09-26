import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { FxService, ymd } from '../fx/fx.service';
import type { Transaction } from '../generated/prisma/client';
import { paidIn } from './debts.service';
import { LedgerService } from './ledger.service';

// ── pure helpers (plan.test.ts) ─────────────────────────────────────────────
// Months are Caracas-local "YYYY-MM"; days are "YYYY-MM-DD". Date columns (@db.Date) come back as UTC midnight.

const DAY = 864e5;
const isUsd = (c: string) => c === 'USD' || c === 'USDT';
export const sameMoney = (a: string, b: string) => a === b || (isUsd(a) && isUsd(b));
export const monthKey = (d: Date) => ymd(d).slice(0, 7);
export const monthDate = (key: string) => new Date(`${key}-01T00:00:00Z`);
export const daysIn = (key: string) => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
export const addMonths = (key: string, n: number) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** [from, to) in real instants for a Caracas month. */
export const monthRange = (key: string) => ({ from: new Date(`${key}-01T00:00:00-04:00`), to: new Date(`${addMonths(key, 1)}-01T00:00:00-04:00`) });
export const dayStr = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** b − a in days */
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
export const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('es-VE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** Due window of an item in a month, clamped to the month's length ("31" in February = the 28th). */
export function dueWindow(key: string, dueDay: number | null, dueDayEnd: number | null): { dueFrom: string | null; dueTo: string | null } {
  if (!dueDay) return { dueFrom: null, dueTo: null };
  const n = daysIn(key), d = (x: number) => `${key}-${String(Math.min(Math.max(1, x), n)).padStart(2, '0')}`;
  return { dueFrom: d(dueDay), dueTo: d(Math.max(dueDay, dueDayEnd ?? dueDay)) };
}

export type EntryStatus = 'pending' | 'partial' | 'paid' | 'over' | 'skipped';

/** A bill counts as paid at 90% (rates and estimates never land exactly); an envelope is "over" once past the plan. */
export function entryStatus(kind: string, plannedUsd: number, spentUsd: number, skipped: boolean): EntryStatus {
  if (skipped) return 'skipped';
  if (spentUsd <= 0.005) return 'pending';
  if (kind === 'bill') return spentUsd >= plannedUsd * 0.9 ? 'paid' : 'partial';
  return spentUsd > plannedUsd + 0.005 ? 'over' : 'partial';
}

/**
 * Where the month is heading. Past months: what was actually spent. Envelopes: the plan until a week of data exists,
 * then the pace (never below what's already gone). Bills: the plan until paid, then what was paid.
 */
export function forecast(kind: string, status: EntryStatus, plannedUsd: number, spentUsd: number, elapsed: number, days: number): number {
  if (status === 'skipped') return spentUsd;
  if (elapsed >= days) return spentUsd;
  if (kind === 'bill') return status === 'paid' ? spentUsd : Math.max(plannedUsd, spentUsd);
  if (elapsed < 7) return Math.max(plannedUsd, spentUsd);
  return Math.max(spentUsd, (spentUsd / elapsed) * days);
}

/** Money outside the plan projected to month end (only once there's a week of data). */
export const paceForecast = (spentUsd: number, elapsed: number, days: number) =>
  elapsed >= days || elapsed < 7 ? spentUsd : (spentUsd / elapsed) * days;

type Remindable = { kind: string; status: EntryStatus; dueFrom: string | null; dueTo: string | null; remindDays: number; remindedOn: string | null; snoozeUntil: string | null; month: string };
/**
 * Should a bill get a "¿ya pagaste?" today? Before the window (remindDays), when it opens, on its last day,
 * then 1/3/7 days late. Undated bills: 3 days before month end. "Mañana" (snooze) wins over the schedule.
 */
export function reminderFor(e: Remindable, today: string): 'before' | 'start' | 'last' | 'overdue' | 'snooze' | 'undated' | null {
  if (e.kind !== 'bill' || (e.status !== 'pending' && e.status !== 'partial') || e.remindedOn === today) return null;
  if (e.snoozeUntil) return today >= e.snoozeUntil ? 'snooze' : null;
  if (!e.dueFrom || !e.dueTo) return dayDiff(today, `${e.month}-${String(daysIn(e.month)).padStart(2, '0')}`) === 3 ? 'undated' : null;
  const toStart = dayDiff(today, e.dueFrom), toEnd = dayDiff(today, e.dueTo);
  if (e.remindDays > 0 && toStart === e.remindDays) return 'before';
  if (toStart === 0) return 'start';
  if (toEnd === 0) return 'last';
  if ([-1, -3, -7].includes(toEnd)) return 'overdue';
  return null;
}

const dm = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const days = (n: number) => `${n} día${n === 1 ? '' : 's'}`;
/** "vence mañana" | "toca del 01/10 al 05/10 (en 5 días)" | "tienes hasta el 05/10" | "venció hace 2 días" | "sin fecha" */
export function dueLabel(dueFrom: string | null, dueTo: string | null, today: string): string {
  if (!dueFrom || !dueTo) return 'sin fecha';
  const toStart = dayDiff(today, dueFrom), toEnd = dayDiff(today, dueTo), win = dueFrom !== dueTo;
  if (toStart > 0) {
    const when = toStart === 1 ? 'mañana' : `en ${days(toStart)}`;
    return win ? `toca del ${dm(dueFrom)} al ${dm(dueTo)} (${when})` : toStart === 1 ? 'vence mañana' : `vence el ${dm(dueFrom)} (${when})`;
  }
  if (toEnd === 0) return 'vence hoy';
  if (toEnd > 0) return `tienes hasta el ${dm(dueTo)} (${toEnd === 1 ? 'mañana' : `quedan ${days(toEnd)}`})`;
  return `venció hace ${days(-toEnd)}`;
}

/** Currency named in a typed answer ("11.500 bs", "310 usdt", "$20"); null = not said. */
export function currencyIn(text: string): string | null {
  const s = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/\b(bs|bss|bsf|bolos?|bolivares?|ves)\b/.test(s)) return 'VES';
  if (/usdt|tether/.test(s)) return 'USDT';
  if (/\$|\b(usd|dolar(es)?|verdes?|dls)\b/.test(s)) return 'USD';
  return null;
}

export const convert = (amount: number, from: string, to: string, vesPerUsd: number | null): number | null =>
  sameMoney(from, to) ? amount : !vesPerUsd ? null : from === 'VES' ? amount / vesPerUsd : amount * vesPerUsd;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Unlinked payment whose merchant names the bill ("Pago Starlink" → Starlink). */
export const merchantMatches = (merchant: string | null, name: string) => {
  const n = norm(name);
  return !!merchant && n.length >= 3 && ` ${norm(merchant)} `.includes(` ${n} `);
};

// ── views ───────────────────────────────────────────────────────────────────

export type PlanTx = { id: number; occurredAt: Date; amount: number; currency: string; amountUsd: number | null; merchant: string | null; status: string; linked: boolean };
export type EntryView = {
  id: number; itemId: number; month: string; name: string; emoji: string | null; kind: string; categoryId: number | null; accountId: number | null; note: string | null;
  currency: string; planned: number; plannedUsd: number; spent: number; spentUsd: number; diff: number; diffUsd: number;
  status: EntryStatus; dueFrom: string | null; dueTo: string | null; dueLabel: string; remindDays: number;
  overridden: boolean; skipped: boolean; remindedOn: string | null; snoozeUntil: string | null;
  forecastUsd: number; expectedUsd: number; avgUsd: number | null; itemAmount: number; txs: PlanTx[];
};
export type MonthView = {
  month: string; label: string; days: number; elapsed: number; today: string; isCurrent: boolean; rate: number | null;
  totals: { plannedUsd: number; spentUsd: number; forecastUsd: number; leftUsd: number; unplannedUsd: number; unplannedForecastUsd: number; allSpentUsd: number; allForecastUsd: number; bills: number; billsPaid: number };
  unplanned: { label: string; total: number; count: number }[];
  entries: EntryView[];
};
export type ItemInput = {
  name: string; emoji?: string | null; kind?: 'bill' | 'envelope'; amount: number; currency: string; dueDay?: number | null; dueDayEnd?: number | null;
  remindDays?: number; categoryId?: number | null; accountId?: number | null; note?: string | null; sort?: number;
};

const ITEM_FIELDS = ['name', 'emoji', 'kind', 'amount', 'currency', 'dueDay', 'dueDayEnd', 'remindDays', 'categoryId', 'accountId', 'note', 'sort'] as const;

@Injectable()
export class PlanService {
  constructor(
    private db: PrismaService,
    private fx: FxService,
    private ledger: LedgerService,
  ) {}

  items() {
    return this.db.planItem.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { id: 'asc' }], include: { category: true, account: true } });
  }

  async findItem(name: string) {
    const n = norm(name);
    const all = await this.db.planItem.findMany({ where: { active: true } });
    return all.find((i) => norm(i.name) === n) ?? all.find((i) => norm(i.name).includes(n) || n.includes(norm(i.name))) ?? null;
  }

  async createItem(d: ItemInput) {
    const sort = d.sort ?? ((await this.db.planItem.aggregate({ _max: { sort: true } }))._max.sort ?? 0) + 1;
    const item = await this.db.planItem.create({ data: { ...pickItem(d), sort } });
    await this.ensureMonth(monthKey(new Date()));
    return item;
  }

  /** Re-plans this and future months that weren't touched by hand and have nothing paid yet. */
  async updateItem(id: number, patch: Partial<ItemInput>) {
    const item = await this.db.planItem.update({ where: { id }, data: pickItem(patch) });
    const entries = await this.db.planEntry.findMany({
      where: { itemId: id, month: { gte: monthDate(monthKey(new Date())) }, overridden: false, transactions: { none: { status: { not: 'void' } } } },
    });
    for (const e of entries) {
      const w = dueWindow(dayStr(e.month)!.slice(0, 7), item.dueDay, item.dueDayEnd);
      await this.db.planEntry.update({
        where: { id: e.id },
        data: { planned: item.amount, currency: item.currency, dueFrom: w.dueFrom ? new Date(w.dueFrom) : null, dueTo: w.dueTo ? new Date(w.dueTo) : null },
      });
    }
    return item;
  }

  /** Gone from the plan from this month on; past months keep their history. */
  async removeItem(id: number) {
    await this.db.planEntry.deleteMany({
      where: { itemId: id, month: { gte: monthDate(monthKey(new Date())) }, transactions: { none: { status: { not: 'void' } } } },
    });
    return this.db.planItem.update({ where: { id }, data: { active: false } });
  }

  /** Current and future months get an entry per active item (idempotent). Past months are never back-filled. */
  async ensureMonth(key: string) {
    if (key < monthKey(new Date())) return;
    const items = await this.db.planItem.findMany({ where: { active: true } });
    if (!items.length) return;
    await this.db.planEntry.createMany({
      skipDuplicates: true,
      data: items.map((i) => {
        const w = dueWindow(key, i.dueDay, i.dueDayEnd);
        return { itemId: i.id, month: monthDate(key), planned: i.amount, currency: i.currency, dueFrom: w.dueFrom ? new Date(w.dueFrom) : null, dueTo: w.dueTo ? new Date(w.dueTo) : null };
      }),
    });
  }

  /** This month only: amount, due window or "este mes no". */
  async updateEntry(id: number, p: { planned?: number; skipped?: boolean; dueFrom?: string | null; dueTo?: string | null }) {
    const touched = p.planned !== undefined || p.dueFrom !== undefined || p.dueTo !== undefined;
    if (p.dueFrom && p.dueTo === undefined) { // moving the start alone never leaves the end before it
      const cur = dayStr((await this.db.planEntry.findUniqueOrThrow({ where: { id } })).dueTo);
      if (!cur || cur < p.dueFrom) p = { ...p, dueTo: p.dueFrom };
    }
    if (p.dueFrom && p.dueTo && p.dueTo < p.dueFrom) p = { ...p, dueTo: p.dueFrom };
    if (p.dueFrom === null) p = { ...p, dueTo: null }; // undated this month
    return this.db.planEntry.update({
      where: { id },
      data: {
        ...(p.planned !== undefined && { planned: p.planned }),
        ...(p.skipped !== undefined && { skipped: p.skipped }),
        ...(p.dueFrom !== undefined && { dueFrom: p.dueFrom ? new Date(p.dueFrom) : null }),
        ...(p.dueTo !== undefined && { dueTo: p.dueTo ? new Date(p.dueTo) : p.dueFrom ? new Date(p.dueFrom) : null }),
        ...(touched && { overridden: true }),
      },
    });
  }

  async snooze(id: number, days = 1) {
    const until = new Date(Date.parse(ymd(new Date())) + days * DAY);
    return this.db.planEntry.update({ where: { id }, data: { snoozeUntil: until } });
  }

  async entry(id: number): Promise<EntryView> {
    const e = await this.db.planEntry.findUnique({ where: { id } });
    if (!e) throw new NotFoundException(`plan entry ${id}`);
    return (await this.month(dayStr(e.month)!.slice(0, 7))).entries.find((x) => x.id === id)!;
  }

  /**
   * The month: each plan line with what's been paid/spent against it, plus what fell outside the plan.
   * A spend counts for a line if it's linked (planEntryId), else if its merchant names a bill, else by an envelope's category.
   */
  async month(key: string, o: { history?: boolean; now?: Date } = {}): Promise<MonthView> {
    const now = o.now ?? new Date(), today = ymd(now), cur = today.slice(0, 7), n = daysIn(key);
    await this.ensureMonth(key);
    const { from, to } = monthRange(key);
    const [entries, rate] = await Promise.all([
      this.db.planEntry.findMany({ where: { month: monthDate(key) }, include: { item: true }, orderBy: [{ item: { sort: 'asc' } }, { id: 'asc' }] }),
      this.fx.rate(now),
    ]);
    const ids = entries.map((e) => e.id);
    const txs = await this.db.transaction.findMany({
      where: {
        type: { in: ['expense', 'fee'] }, status: { not: 'void' },
        OR: [{ occurredAt: { gte: from, lt: to }, OR: [{ planEntryId: null }, { planEntryId: { in: ids } }] }, { planEntryId: { in: ids } }],
      },
      include: { category: true },
      orderBy: { occurredAt: 'asc' },
    });

    const byEntry = new Map<number, (Transaction & { linked: boolean })[]>(ids.map((id) => [id, []]));
    const envByCat = new Map<number, number>();
    for (const e of entries) if (e.item.kind === 'envelope' && e.item.categoryId && !envByCat.has(e.item.categoryId)) envByCat.set(e.item.categoryId, e.id);
    const bills = entries.filter((e) => e.item.kind === 'bill');
    const outside: typeof txs = [];
    for (const t of txs) {
      const target = t.planEntryId
        ?? bills.find((b) => merchantMatches(t.merchant, b.item.name))?.id
        ?? (t.categoryId ? envByCat.get(t.categoryId) ?? (t.category?.parentId ? envByCat.get(t.category.parentId) : undefined) : undefined);
      if (target) byEntry.get(target)!.push({ ...t, linked: t.planEntryId === target });
      else outside.push(t);
    }

    const elapsed = key < cur ? n : key > cur ? 0 : Number(today.slice(8, 10));
    const toUsd = (amount: number, currency: string) => (isUsd(currency) ? amount : rate ? amount / rate : 0);
    const avg = o.history === false ? new Map<number, number>() : await this.history(key, entries.map((e) => e.itemId), now);
    const views: EntryView[] = entries.map((e) => {
      const lines = byEntry.get(e.id)!;
      const planned = Number(e.planned), plannedUsd = toUsd(planned, e.currency);
      const spentUsd = lines.reduce((s, t) => s + Number(t.amountUsd ?? 0), 0);
      const spent = lines.reduce((s, t) => s + paidIn(e.currency, t, rate), 0);
      const status = entryStatus(e.item.kind, plannedUsd, spentUsd, e.skipped);
      const dueFrom = dayStr(e.dueFrom), dueTo = dayStr(e.dueTo);
      return {
        id: e.id, itemId: e.itemId, month: key, name: e.item.name, emoji: e.item.emoji, kind: e.item.kind, categoryId: e.item.categoryId, accountId: e.item.accountId, note: e.item.note,
        currency: e.currency, planned, plannedUsd, spent, spentUsd, diff: spent - planned, diffUsd: spentUsd - plannedUsd,
        status, dueFrom, dueTo, dueLabel: dueLabel(dueFrom, dueTo, today), remindDays: e.item.remindDays,
        overridden: e.overridden, skipped: e.skipped, remindedOn: dayStr(e.remindedOn), snoozeUntil: dayStr(e.snoozeUntil),
        forecastUsd: forecast(e.item.kind, status, plannedUsd, spentUsd, elapsed, n),
        expectedUsd: e.item.kind === 'envelope' ? (plannedUsd * elapsed) / n : dueTo && dueTo <= today ? plannedUsd : 0,
        avgUsd: avg.get(e.itemId) ?? null, itemAmount: Number(e.item.amount),
        txs: lines.map((t) => ({ id: t.id, occurredAt: t.occurredAt, amount: Number(t.amount), currency: t.currency, amountUsd: t.amountUsd == null ? null : Number(t.amountUsd), merchant: t.merchant, status: t.status, linked: t.linked })),
      };
    });

    const unplannedUsd = outside.reduce((s, t) => s + Number(t.amountUsd ?? 0), 0);
    const groups = new Map<string, { label: string; total: number; count: number }>();
    for (const t of outside) {
      const k = t.category?.name ?? 'Sin categoría';
      const g = groups.get(k) ?? { label: `${t.category?.emoji ?? ''} ${k}`.trim(), total: 0, count: 0 };
      g.total += Number(t.amountUsd ?? 0); g.count++;
      groups.set(k, g);
    }
    const live = views.filter((v) => !v.skipped);
    const sum = (xs: EntryView[], f: (v: EntryView) => number) => xs.reduce((s, v) => s + f(v), 0);
    const plannedUsd = sum(live, (v) => v.plannedUsd), spentUsd = sum(views, (v) => v.spentUsd), forecastUsd = sum(views, (v) => v.forecastUsd);
    const unplannedForecastUsd = paceForecast(unplannedUsd, elapsed, n);
    return {
      month: key, label: monthLabel(key), days: n, elapsed, today, isCurrent: key === cur, rate,
      totals: {
        plannedUsd, spentUsd, forecastUsd, leftUsd: sum(live, (v) => Math.max(0, v.plannedUsd - v.spentUsd)),
        unplannedUsd, unplannedForecastUsd, allSpentUsd: spentUsd + unplannedUsd, allForecastUsd: forecastUsd + unplannedForecastUsd,
        bills: live.filter((v) => v.kind === 'bill').length, billsPaid: live.filter((v) => v.kind === 'bill' && v.status === 'paid').length,
      },
      unplanned: [...groups.values()].sort((a, b) => b.total - a.total),
      entries: views,
    };
  }

  /** Mean USD really paid/spent per item over the 3 months before `key` (months where it was planned and not skipped). */
  private async history(key: string, itemIds: number[], now: Date) {
    const acc = new Map<number, number[]>();
    for (let i = 1; i <= 3; i++) {
      const m = await this.month(addMonths(key, -i), { history: false, now });
      for (const e of m.entries) if (!e.skipped && itemIds.includes(e.itemId) && e.spentUsd > 0) acc.set(e.itemId, [...(acc.get(e.itemId) ?? []), e.spentUsd]);
    }
    return new Map([...acc].map(([id, xs]) => [id, xs.reduce((s, x) => s + x, 0) / xs.length]));
  }

  /**
   * "Ya pagué": an expense linked to the entry, from the item's usual account. No amount → what's left of the plan,
   * unless the account's currency differs (Bs for a $ bill): then the caller must ask, with an estimate at today's rate.
   */
  async pay(entryId: number, o: { amount?: number; currency?: string | null; accountId?: number | null; occurredAt?: Date; note?: string; source?: string } = {}) {
    const e = await this.db.planEntry.findUnique({ where: { id: entryId }, include: { item: true } });
    if (!e) throw new NotFoundException(`plan entry ${entryId}`);
    let acc = await this.db.account.findUnique({ where: { id: o.accountId ?? e.item.accountId ?? -1 } });
    const currency = o.currency ?? acc?.currency ?? e.currency;
    if (acc && !sameMoney(acc.currency, currency)) acc = null; // said "$" but the usual account is in Bs: let them pick
    let amount = o.amount;
    if (amount == null) {
      const v = await this.entry(entryId);
      const left = v.planned - v.spent > 0.005 ? v.planned - v.spent : v.planned;
      if (!sameMoney(currency, e.currency)) return { need: { currency, estimate: convert(left, e.currency, currency, await this.fx.rate(new Date())) } };
      amount = Math.round(left * 100) / 100;
    }
    const tx = await this.ledger.create({
      type: 'expense', status: acc ? 'confirmed' : 'pending', occurredAt: o.occurredAt ?? new Date(), amount, currency,
      fromAccountId: acc?.id, categoryId: e.item.categoryId ?? undefined, merchant: e.item.name, note: o.note, planEntryId: e.id, source: o.source ?? 'plan',
    });
    return { tx };
  }

  /** Voids the payments linked to this entry (a merchant-matched one is left alone: it's a real expense). */
  async unpay(entryId: number) {
    const txs = await this.db.transaction.findMany({ where: { planEntryId: entryId, status: { not: 'void' } } });
    for (const t of txs) await this.ledger.void(t.id);
    return txs.length;
  }

  /** Bills that need a "¿ya pagaste?" today (this and last month, for late ones). Marks them reminded. */
  async dueReminders(now = new Date()) {
    const today = ymd(now), key = today.slice(0, 7);
    const [prev, cur] = await Promise.all([this.month(addMonths(key, -1), { history: false, now }), this.month(key, { history: false, now })]);
    const out: { entry: EntryView; reason: NonNullable<ReturnType<typeof reminderFor>> }[] = [];
    for (const e of [...prev.entries, ...cur.entries]) {
      const reason = reminderFor(e, today);
      if (reason) out.push({ entry: e, reason });
    }
    if (out.length) await this.db.planEntry.updateMany({ where: { id: { in: out.map((x) => x.entry.id) } }, data: { remindedOn: new Date(today), snoozeUntil: null } });
    return out;
  }
}

function pickItem(d: Partial<ItemInput>) {
  const r: Record<string, unknown> = {};
  for (const k of ITEM_FIELDS) if (d[k] !== undefined) r[k] = d[k];
  return r as any;
}
