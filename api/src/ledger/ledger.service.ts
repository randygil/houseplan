import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { FxService } from '../fx/fx.service';
import type { Account, Category, Debt, Prisma, Transaction } from '../generated/prisma/client';
import { BagsService } from './bags.service';
import { CategoriesService } from './categories.service';

export type TxInput = {
  type: 'transfer' | 'expense' | 'income' | 'fee'; status?: 'pending' | 'confirmed';
  occurredAt: Date; amount: number; currency: string;
  fromAccountId?: number; toAccountId?: number; toAmount?: number;
  categoryId?: number; merchant?: string; note?: string; debtId?: number;
  source: string; rawEventId?: number; confidence?: number; fxRate?: number; fxSource?: string;
};
export type TxView = Transaction & { category: Category | null; fromAccount: Account | null; toAccount: Account | null; debt: Debt | null };
type Db = Prisma.TransactionClient;
type Patch = Omit<Partial<TxInput>, 'status'> & { status?: string };

export const TX_INCLUDE = { category: true, fromAccount: true, toAccount: true, debt: true } as const;
const isUsd = (c: string) => c === 'USD' || c === 'USDT';
// Changing any of these re-runs FX + bag allocation.
const MONEY_KEYS = ['type', 'amount', 'currency', 'fromAccountId', 'toAccountId', 'toAmount', 'occurredAt', 'fxRate'] as const;
const FIELDS = [
  'type', 'status', 'occurredAt', 'amount', 'currency', 'fromAccountId', 'toAccountId', 'toAmount', 'categoryId',
  'merchant', 'note', 'debtId', 'source', 'rawEventId', 'confidence', 'fxRate', 'fxSource',
] as const;

@Injectable()
export class LedgerService {
  constructor(
    private db: PrismaService,
    private fx: FxService,
    private categories: CategoriesService,
    @Inject(forwardRef(() => BagsService)) private bags: BagsService,
  ) {}

  /** `preferBagId` is internal (BagsService.explainRest). */
  async create(input: TxInput, preferBagId?: number): Promise<Transaction> {
    let categoryId = input.categoryId;
    if (!categoryId && input.merchant) categoryId = (await this.categories.ruleFor(input.merchant))?.categoryId;
    return this.db.$transaction(async (db) => {
      const row = await db.transaction.create({
        data: { ...pick(input), categoryId, status: input.status ?? 'pending', fxRate: null, fxSource: null },
      });
      await db.transactionVersion.create({ data: { transactionId: row.id, snapshot: {}, reason: 'create' } });
      return db.transaction.update({ where: { id: row.id }, data: await this.money(db, row, input, preferBagId) });
    });
  }

  async update(id: number, patch: Partial<TxInput>, reason = 'edit'): Promise<Transaction> {
    const res = await this.db.$transaction((db) => this.apply(db, id, patch, reason));
    if (patch.categoryId && res.prev.categoryId !== patch.categoryId && res.tx.merchant)
      await this.categories.learn(res.tx.merchant, patch.categoryId, res.tx.fromAccountId ?? undefined);
    return res.tx;
  }

  confirm(id: number) { return this.update(id, { status: 'confirmed' }); }

  async void(id: number): Promise<Transaction> {
    return (await this.db.$transaction((db) => this.apply(db, id, { status: 'void' }, 'void'))).tx;
  }

  /**
   * Reverts the latest non-undo version (of txId, or globally) and consumes it. A 'create' => void.
   * Globally, system-created txs (p2p, pay…) are only undone for edits, never voided.
   */
  async undoLast(txId?: number): Promise<Transaction | null> {
    return this.db.$transaction(async (db) => {
      const v = await db.transactionVersion.findFirst({
        where: txId
          ? { reason: { not: 'undo' }, transactionId: txId }
          : { reason: { not: 'undo' }, OR: [{ reason: { not: 'create' } }, { transaction: { source: { startsWith: 'manual' } } }] },
        orderBy: { id: 'desc' },
      });
      if (!v) return null;
      await db.transactionVersion.delete({ where: { id: v.id } });
      if (v.reason === 'create') return (await this.apply(db, v.transactionId, { status: 'void' }, 'undo')).tx;
      const snap = v.snapshot as Record<string, any>;
      const patch: Record<string, unknown> = {};
      for (const k of FIELDS) patch[k] = snap[k] == null ? null : k === 'occurredAt' ? new Date(snap[k]) : NUM_FIELDS.has(k) ? Number(snap[k]) : snap[k];
      if (snap.fxSource !== 'manual') delete patch.fxRate, delete patch.fxSource;
      return (await this.apply(db, v.transactionId, patch as Patch, 'undo')).tx;
    });
  }

  recent(n = 5): Promise<TxView[]> {
    return this.db.transaction.findMany({ where: { status: { not: 'void' } }, orderBy: { updatedAt: 'desc' }, take: n, include: TX_INCLUDE });
  }

  get(id: number): Promise<TxView | null> {
    return this.db.transaction.findUnique({ where: { id }, include: TX_INCLUDE });
  }

  async balances() {
    const accounts = await this.db.account.findMany({ orderBy: { id: 'asc' } });
    const rate = await this.fx.rate(new Date());
    return Promise.all(accounts.map(async (a) => {
      const synced = a.kind === 'synced' ? await this.syncedBalance(a) : null;
      const balance = synced?.balance ?? await this.balanceOf(a, true);
      return {
        accountId: a.id, code: a.code, name: a.name, currency: a.currency, kind: a.kind, balance,
        balanceUsd: isUsd(a.currency) ? balance : rate ? balance / rate : null,
        lastReconciledAt: a.lastReconciledAt,
        lastSyncedAt: synced?.at ?? null, // null on a synced account = never read from Binance yet
      };
    }));
  }

  async reconcile(accountId: number, actual: number): Promise<{ diff: number; tx: Transaction | null }> {
    const acct = await this.db.account.findUniqueOrThrow({ where: { id: accountId } });
    const diff = actual - (await this.balanceOf(acct, true));
    const at = new Date();
    // Diff tx sits exactly at the reconcile instant, which balanceOf excludes (strictly after).
    const tx = diff < -0.005
      ? await this.create({ type: 'expense', occurredAt: at, amount: -diff, currency: acct.currency, fromAccountId: acct.id, source: 'reconcile', note: 'Diferencia de conciliación' })
      : null;
    await this.db.account.update({ where: { id: accountId }, data: { lastReconciledBalance: actual, lastReconciledAt: at } });
    return { diff, tx };
  }

  accountByCode(code: string): Promise<Account> {
    return this.db.account.findUniqueOrThrow({ where: { code } });
  }

  async accountByPayMethod(payMethodName: string): Promise<Account | null> {
    const k = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = k(payMethodName);
    return (await this.db.account.findMany()).find((a) => a.payMethodAliases.some((x) => k(x) === want)) ?? null;
  }

  // ---- internals

  /** The single Binance account = USDT value of every wallet (all-wallets snapshot), else funding+spot USDT. */
  private async syncedBalance(a: Account): Promise<{ balance: number; at: Date } | null> {
    const last = (wallet: string) => this.db.walletSnapshot.findFirst({ where: { wallet }, orderBy: { takenAt: 'desc' } });
    const [all, funding, spot] = await Promise.all([last('all'), last('funding'), last('spot')]);
    const sum = (s: { balances: unknown } | null) => Object.values((s?.balances ?? {}) as Record<string, unknown>).reduce<number>((n, v) => n + Number(v), 0);
    if (all) return { balance: sum(all), at: all.takenAt };
    const usdt = (s: { balances: unknown } | null) => Number((s?.balances as Record<string, unknown> | undefined)?.[a.currency] ?? 0);
    return funding || spot ? { balance: usdt(funding) + usdt(spot), at: (funding ?? spot)!.takenAt } : null;
  }

  private async balanceOf(a: Account, ledgerOnly = false): Promise<number> {
    if (a.kind === 'synced' && !ledgerOnly) {
      const s = await this.syncedBalance(a);
      if (s) return s.balance;
    }
    const base = Number(a.lastReconciledBalance ?? a.openingBalance);
    const since = a.lastReconciledAt ?? a.openingAt;
    const [r] = await this.db.$queryRaw<{ inc: unknown; out: unknown }[]>`
      SELECT
        coalesce(sum(coalesce("toAmount", amount)) FILTER (WHERE "toAccountId" = ${a.id}), 0) AS inc,
        coalesce(sum(amount) FILTER (WHERE "fromAccountId" = ${a.id}), 0) AS out
      FROM transactions
      WHERE status <> 'void' AND "occurredAt" > ${since} AND (${a.id} IN ("toAccountId", "fromAccountId"))`;
    return base + Number(r.inc) - Number(r.out);
  }

  /** Snapshot prev → version, patch row, redo FX/bags if money fields changed. */
  private async apply(db: Db, id: number, patch: Patch, reason: string) {
    const prev = await db.transaction.findUniqueOrThrow({ where: { id } });
    await db.transactionVersion.create({ data: { transactionId: id, snapshot: toJson(prev), reason } });
    const data: Prisma.TransactionUncheckedUpdateInput = { ...pick(patch) };
    const voidFlip = 'status' in patch && (patch.status === 'void') !== (prev.status === 'void');
    const moneyChanged = voidFlip || MONEY_KEYS.some((k) => k in patch && String(patch[k] ?? null) !== String(prev[k] ?? null));
    if (moneyChanged) {
      await this.shiftBaselines(db, prev, { ...prev, ...pick(patch) });
      await this.bags.release(db, id);
      const merged = { ...prev, ...patch } as any;
      if (merged.status === 'void') data.bagId = null;
      else Object.assign(data, await this.money(db, { ...merged, id }, {
        ...merged,
        amount: Number(merged.amount),
        toAmount: merged.toAmount == null ? undefined : Number(merged.toAmount),
        // keep a manual rate unless the patch replaces it
        fxRate: 'fxRate' in patch ? patch.fxRate : prev.fxSource === 'manual' ? Number(prev.fxRate) : undefined,
      }));
    }
    const tx = await db.transaction.update({ where: { id }, data });
    return { prev, tx };
  }

  /**
   * balanceOf only sums txs after an account's baseline (last reconcile, else opening). A tx that was already
   * counted when that baseline was set is baked into it, so voiding/editing it moves the baseline instead.
   */
  private async shiftBaselines(db: Db, prev: Transaction, next: Transaction) {
    const ids = [...new Set([prev.fromAccountId, prev.toAccountId, next.fromAccountId, next.toAccountId])].filter((x) => x != null);
    for (const a of await db.account.findMany({ where: { id: { in: ids } } })) {
      const since = a.lastReconciledAt ?? a.openingAt;
      const effect = (t: Transaction) => t.status === 'void' || new Date(t.occurredAt) > since || prev.createdAt > since ? 0
        : (t.toAccountId === a.id ? Number(t.toAmount ?? t.amount) : 0) - (t.fromAccountId === a.id ? Number(t.amount) : 0);
      const d = effect(next) - effect(prev);
      if (Math.abs(d) < 1e-9) continue;
      await db.account.update({ where: { id: a.id }, data: a.lastReconciledAt
        ? { lastReconciledBalance: Number(a.lastReconciledBalance ?? a.openingBalance) + d }
        : { openingBalance: Number(a.openingBalance) + d } });
    }
  }

  /** amountUsd / fxRate / fxSource / bagId (+ bag allocation for VES expense/fee). */
  private async money(db: Db, row: Transaction, input: Partial<TxInput>, preferBagId?: number) {
    const amount = Number(input.amount ?? row.amount);
    const currency = input.currency ?? row.currency;
    const out = { amountUsd: null as number | null, fxRate: null as number | null, fxSource: null as string | null, bagId: null as number | null };
    if (isUsd(currency)) return { ...out, amountUsd: amount };
    if (input.fxRate) return { ...out, amountUsd: amount / input.fxRate, fxRate: input.fxRate, fxSource: input.fxSource ?? 'manual' };
    const to = input.toAmount && row.toAccountId ? await db.account.findUnique({ where: { id: row.toAccountId } }) : null;
    if (to && isUsd(to.currency)) {
      // Bs leaving for a USD account (P2P BUY, cambio a Zelle) drain that bank's bags like an expense would.
      // ponytail: VES→VES moves (bdv→mercantil) leave bags where they were; move them if follow-ups nag about it.
      const bagId = currency === 'VES' && row.fromAccountId
        ? (await this.bags.allocate(db, { id: row.id, fromAccountId: row.fromAccountId, amount, occurredAt: input.occurredAt ?? row.occurredAt }, preferBagId)).bagId : null;
      return { ...out, amountUsd: input.toAmount!, fxRate: amount / input.toAmount!, fxSource: 'p2p', bagId };
    }

    const type = input.type ?? row.type;
    let covered = 0, usd = 0;
    if (currency === 'VES' && (type === 'expense' || type === 'fee') && row.fromAccountId) {
      const a = await this.bags.allocate(db, { id: row.id, fromAccountId: row.fromAccountId, amount, occurredAt: input.occurredAt ?? row.occurredAt }, preferBagId);
      ({ covered, usd } = a);
      out.bagId = a.bagId;
    }
    const occurredAt = input.occurredAt ?? row.occurredAt;
    let fallback: number | null = null, src = 'none';
    if (covered < amount) {
      const b = await this.fx.best(occurredAt);
      if (b) ({ rate: fallback, source: src } = b);
    }
    if (covered > 0) {
      // uncovered remainder (bags ran dry) priced at the fallback, or at the bag average if no rate exists
      usd += (amount - covered) / (fallback ?? covered / usd);
      return { ...out, amountUsd: usd, fxRate: amount / usd, fxSource: 'bag' };
    }
    if (fallback) return { ...out, amountUsd: amount / fallback, fxRate: fallback, fxSource: src };
    return { ...out, fxSource: 'none' };
  }
}

const NUM_FIELDS = new Set(['amount', 'toAmount', 'fxRate', 'confidence']);
const pick = (o: Patch) => {
  const r: Record<string, unknown> = {};
  for (const k of FIELDS) if (k in o && (o as any)[k] !== undefined) r[k] = (o as any)[k];
  return r as any;
};
const toJson = (row: Transaction) => JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue;
