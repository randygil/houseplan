import { Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { PrismaService } from '../db/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { BagsService } from '../ledger/bags.service';
import { FxService } from '../fx/fx.service';
import { BinanceClient, P2POrder, PayTx } from './binance.client';
import {
  Movement, caracasAt, caracasDay, followupTimes, fundingDelta, isMerchant, isRefund, payWalletMoves,
} from './binance.logic';

type Mode = 'live' | 'backfill';
const H = 3_600_000, DAY = 24 * H;
const P2P_CANCELLED = ['CANCELLED', 'CANCELLED_BY_SYSTEM'];
const MOVE_LOOKBACK = 3 * H;     // P2P orders can sit in escrow for a while
const SNAPSHOT_MAX_GAP = 20 * 60_000; // older previous snapshot (downtime) => just re-baseline

@Injectable()
export class BinanceService {
  private log = new Logger('Binance');
  private running: Promise<unknown> | null = null;
  private warned = false;
  /** Final movements already used to explain a funding delta (key -> ms). In-memory: after a restart we re-baseline. */
  private consumed: Map<string, number> | null = null;

  constructor(
    private db: PrismaService, private api: BinanceClient,
    private ledger: LedgerService, private bags: BagsService, private fx: FxService,
  ) {}

  // ---------- scheduling ----------

  @Interval('sync:p2p', 2 * 60_000) cronP2p() { return this.cron(() => this.syncP2p()); }
  // sync:pay, snapshot:funding and snapshot:all share one 5-min run: the snapshot needs fresh P2P/Pay to explain deltas.
  @Interval('sync:pay+snapshot:funding', 5 * 60_000) cronFunding() { return this.cron(() => this.syncAll()); }
  @Cron('0 * * * *', { name: 'snapshot:spot' }) cronSpot() { return this.cron(() => this.snapshotSpot()); }

  /** Cron entry: no-op without keys, skip if another job is running, never throw. */
  private async cron(fn: () => Promise<unknown>) {
    if (!this.api.enabled) { if (!this.warned) this.log.warn('BINANCE_KEY/BINANCE_SECRET not set: Binance sync disabled'); this.warned = true; return; }
    if (this.running) return;
    await this.exclusive(fn).catch((e) => this.log.error(e instanceof Error ? e.message : e));
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running) await this.running.catch(() => {});
    const p = fn();
    this.running = p;
    try { return await p; } finally { this.running = null; }
  }

  private requireKey() { if (!this.api.enabled) throw new Error('Binance no configurado (BINANCE_KEY/BINANCE_SECRET)'); }

  async syncNow(): Promise<void> { this.requireKey(); await this.exclusive(async () => { await this.syncAll(); await this.snapshotSpot(); }); }

  async backfill(): Promise<{ p2p: number; pay: number }> {
    this.requireKey();
    return this.exclusive(async () => {
      const now = Date.now();
      let p2p = 0, pay = 0;
      for (let end = now; end > now - 180 * DAY; end -= 30 * DAY)
        for (const side of ['SELL', 'BUY'] as const)
          for (const o of await this.api.p2pOrders(side, Math.max(end - 30 * DAY + 1, now - 180 * DAY), end)) p2p += +await this.upsertP2p(o);
      for (let end = now; end > now - 540 * DAY; end -= 90 * DAY)
        for (const t of await this.api.payTransactions(Math.max(end - 90 * DAY + 1, now - 540 * DAY), end)) pay += +await this.upsertPay(t);
      await this.processPending('backfill');
      return { p2p, pay };
    });
  }

  private async syncAll() { await this.syncP2p(); await this.syncPay(); await this.snapshotFunding(); await this.snapshotAll(); }

  // ---------- sync ----------

  async syncP2p() {
    const end = Date.now(), start = end - 48 * H;
    for (const side of ['SELL', 'BUY'] as const) for (const o of await this.api.p2pOrders(side, start, end)) await this.upsertP2p(o);
    await this.processPending('live');
  }

  async syncPay() {
    const end = Date.now();
    for (const t of await this.api.payTransactions(end - 48 * H, end)) await this.upsertPay(t);
    await this.processPending('live');
  }

  private upsertP2p(o: P2POrder) { return this.upsertRaw('p2p', o.orderNumber, new Date(o.createTime), o); }
  private upsertPay(t: PayTx) { return this.upsertRaw('pay', t.transactionId, new Date(t.transactionTime), t); }

  /** Returns true if new. A changed payload is re-processed only if it hasn't produced transactions yet. */
  private async upsertRaw(source: string, externalId: string, occurredAt: Date, payload: object): Promise<boolean> {
    const ex = await this.db.rawEvent.findUnique({ where: { source_externalId: { source, externalId } }, include: { _count: { select: { transactions: true } } } });
    if (!ex) { await this.db.rawEvent.create({ data: { source, externalId, occurredAt, payload } }); return true; }
    if (JSON.stringify(ex.payload) !== JSON.stringify(payload))
      await this.db.rawEvent.update({ where: { id: ex.id }, data: { payload, ...(ex._count.transactions ? {} : { processedAt: null }) } });
    return false;
  }

  private async processPending(mode: Mode) {
    const evs = await this.db.rawEvent.findMany({ where: { processedAt: null, source: { in: ['p2p', 'pay'] } }, orderBy: { occurredAt: 'asc' } });
    for (const ev of evs) {
      // claim first so a crash can't double-create
      const { count } = await this.db.rawEvent.updateMany({ where: { id: ev.id, processedAt: null }, data: { processedAt: new Date() } });
      if (!count) continue;
      try {
        if (ev.source === 'p2p') await this.processP2p(ev.id, ev.payload as unknown as P2POrder, mode);
        else await this.processPay(ev.id, ev.payload as unknown as PayTx, mode);
      } catch (e) {
        this.log.error(`processing ${ev.source}:${ev.externalId} failed: ${e instanceof Error ? e.message : e}`);
        if (!(await this.db.transaction.count({ where: { rawEventId: ev.id } }))) await this.db.rawEvent.update({ where: { id: ev.id }, data: { processedAt: null } });
      }
    }
  }

  // ---------- P2P ----------

  private async processP2p(rawEventId: number, o: P2POrder, mode: Mode) {
    if (o.orderStatus !== 'COMPLETED') return; // stays processed; a status change resets processedAt
    const occurredAt = new Date(o.createTime);
    const crypto = Number(o.amount), fiat = Number(o.totalPrice), rate = Number(o.unitPrice);
    const fee = Number(o.commission) || Number(o.takerCommission) || 0;
    const funding = await this.ledger.accountByCode('binance');
    const bank = await this.ledger.accountByPayMethod(o.payMethodName);
    const status = bank ? 'confirmed' : 'pending';
    const note = `P2P ${o.tradeType} ${crypto} ${o.asset} @ ${rate} (${o.payMethodName}, ${o.counterPartNickName})`;

    const tx = o.tradeType === 'SELL'
      ? await this.ledger.create({ type: 'transfer', status, occurredAt, amount: crypto, currency: o.asset, fromAccountId: funding.id, toAccountId: bank?.id, toAmount: fiat, note, source: 'p2p', rawEventId })
      : await this.ledger.create({ type: 'transfer', status, occurredAt, amount: fiat, currency: o.fiat, fromAccountId: bank?.id, toAccountId: funding.id, toAmount: crypto, note, source: 'p2p', rawEventId });
    if (fee > 0)
      await this.ledger.create({ type: 'fee', status: 'confirmed', occurredAt, amount: fee, currency: o.asset, fromAccountId: funding.id, note: `Comisión P2P ${o.orderNumber}`, source: 'p2p', rawEventId });

    if (!bank && mode === 'live') await this.prompt('ask_account', tx.id, { payMethodName: o.payMethodName });
    if (o.tradeType !== 'SELL') return;
    if (!bank || (mode === 'backfill' && occurredAt.getTime() < Date.now() - 7 * DAY)) return this.updateP2pAvg(occurredAt);

    const bag = await this.bags.open(tx, bank.id, fiat, rate);
    await this.updateP2pAvg(occurredAt); // after open(): bags.open refreshes p2p_avg from bags only; ours covers every SELL
    if (mode === 'backfill') return;
    const now = new Date();
    await this.prompt('p2p_intro', bag.id, { usdt: crypto, ves: fiat, rate, account: bank.code });
    for (const at of followupTimes(now, process.env.NUDGE_TIMES ?? '13:30,20:30', process.env.QUIET_HOURS ?? '22:00-08:00'))
      await this.prompt('bag_followup', bag.id, {}, at);
    const expected = (await this.ledger.balances()).find((b) => b.accountId === bank.id)?.balance ?? null;
    await this.prompt('reconcile', bank.id, { expected }, caracasAt(now, '09:00', 1));
  }

  /** fx_rates p2p_avg for that Caracas day = weighted avg of my completed SELLs. */
  private async updateP2pAvg(at: Date) {
    const day = caracasDay(at);
    const from = new Date(day.getTime() + 4 * H); // Caracas midnight in UTC
    const evs = await this.db.rawEvent.findMany({ where: { source: 'p2p', occurredAt: { gte: from, lt: new Date(from.getTime() + DAY) } } });
    let ves = 0, usdt = 0;
    for (const { payload } of evs) {
      const o = payload as unknown as P2POrder;
      if (o.tradeType === 'SELL' && o.orderStatus === 'COMPLETED' && o.fiat === 'VES') { ves += Number(o.totalPrice); usdt += Number(o.amount); }
    }
    if (usdt > 0) await this.fx.upsert(at, 'p2p_avg', ves / usdt); // FxService maps to the Caracas day itself
  }

  // ---------- Pay ----------

  private async processPay(rawEventId: number, t: PayTx, mode: Mode) {
    const amt = Number(t.amount);
    if (!amt) return;
    const account = await this.ledger.accountByCode('binance');
    const occurredAt = new Date(t.transactionTime);
    const base = { occurredAt, amount: Math.abs(amt), currency: t.currency, source: 'pay', rawEventId };

    if (amt > 0) {
      const from = t.payerInfo?.name;
      await this.ledger.create({
        ...base, type: 'income', toAccountId: account.id, merchant: from,
        status: isRefund(t) || mode === 'backfill' ? 'confirmed' : 'pending',
        note: isRefund(t) ? `Reembolso Binance Pay ${t.orderType} ${t.transactionId}` : `Binance Pay ${t.orderType} de ${from ?? '?'}`,
      });
      return;
    }
    const to = t.receiverInfo, person = !isMerchant(to);
    const tx = await this.ledger.create({
      ...base, type: 'expense', fromAccountId: account.id, merchant: to?.name,
      status: mode === 'backfill' && !person ? 'confirmed' : 'pending',
      note: `Binance Pay ${t.orderType} a ${to?.name ?? '?'} (${to?.type ?? '?'})`,
    });
    if (person && mode === 'live') await this.prompt('pay_classify', tx.id, { amount: Math.abs(amt), currency: t.currency, counterparty: to?.name ?? null });
  }

  // ---------- snapshots ----------

  async snapshotFunding() {
    const now = new Date();
    const balances: Record<string, number> = {};
    for (const a of await this.api.fundingAssets())
      balances[a.asset] = Number(a.free) + Number(a.locked) + Number(a.freeze ?? 0) + Number(a.withdrawing ?? 0);
    const prev = await this.db.walletSnapshot.findFirst({ where: { wallet: 'funding' }, orderBy: { takenAt: 'desc' } });
    await this.db.walletSnapshot.create({ data: { takenAt: now, wallet: 'funding', balances: toJson(balances) } });
    if (!prev) return;

    const moves = await this.fundingMoves(prev.takenAt.getTime() - MOVE_LOOKBACK, now.getTime());
    const baseline = !this.consumed || now.getTime() - prev.takenAt.getTime() > SNAPSHOT_MAX_GAP;
    this.consumed ??= new Map();
    const fresh = moves.filter((m) => !this.consumed!.has(m.key));
    for (const m of fresh) if (m.final) this.consumed.set(m.key, now.getTime());
    for (const [k, t] of this.consumed) if (t < now.getTime() - DAY) this.consumed.delete(k);
    if (baseline) return;

    const prevBal = Object.fromEntries(Object.entries(prev.balances as Record<string, string>).map(([k, v]) => [k, Number(v)]));
    const drops = fundingDelta(prevBal, balances, fresh, Number(process.env.CARD_DELTA_MIN_USDT ?? 1));
    if (!drops.length) return;
    const funding = await this.ledger.accountByCode('binance');
    for (const { asset, drop } of drops) {
      this.log.log(`unexplained funding drop ${drop} ${asset} -> card_delta`);
      const tx = await this.ledger.create({ type: 'expense', status: 'pending', occurredAt: now, amount: drop, currency: asset, fromAccountId: funding.id, note: 'probable tarjeta', source: 'card_delta' });
      await this.prompt('card_delta', tx.id, { usdt: drop, at: now.toISOString() });
    }
  }

  /** Known funding-wallet movements since `since`: P2P + Pay (raw_events) and transfers/deposits/withdrawals (API). */
  private async fundingMoves(since: number, end: number): Promise<Movement[]> {
    const moves: Movement[] = [];
    const evs = await this.db.rawEvent.findMany({ where: { source: { in: ['p2p', 'pay'] }, occurredAt: { gte: new Date(since) } } });
    for (const ev of evs) {
      if (ev.source === 'p2p') {
        const o = ev.payload as unknown as P2POrder;
        const fee = Number(o.commission) || Number(o.takerCommission) || 0;
        const final = o.orderStatus === 'COMPLETED';
        if (o.tradeType === 'SELL' && !P2P_CANCELLED.includes(o.orderStatus))
          moves.push({ key: `p2p:${o.orderNumber}`, asset: o.asset, amount: -(Number(o.amount) + fee), final });
        else if (o.tradeType === 'BUY' && final)
          moves.push({ key: `p2p:${o.orderNumber}`, asset: o.asset, amount: Number(o.amount) - fee, final });
      } else {
        const t = ev.payload as unknown as PayTx;
        for (const m of payWalletMoves(t, 1)) moves.push({ key: `pay:${t.transactionId}:${m.asset}`, ...m, final: true });
      }
    }
    for (const [type, sign] of [['MAIN_FUNDING', 1], ['FUNDING_MAIN', -1]] as const)
      for (const r of await this.api.transfers(type, since, end))
        if (r.status === 'CONFIRMED') moves.push({ key: `tr:${r.tranId}`, asset: r.asset, amount: sign * Number(r.amount), final: true });
    for (const d of await this.api.deposits(since, end))
      if (d.walletType === 1 && (d.status === 1 || d.status === 6)) moves.push({ key: `dep:${d.id}`, asset: d.coin, amount: Number(d.amount), final: true });
    for (const w of await this.api.withdrawals(since, end))
      if (w.walletType === 1 && w.status !== 3) moves.push({ key: `wd:${w.id}`, asset: w.coin, amount: -(Number(w.amount) + Number(w.transactionFee)), final: w.status === 6 });
    return moves;
  }

  async snapshotSpot() {
    const balances: Record<string, number> = {};
    for (const b of await this.api.spotBalances()) balances[b.asset] = Number(b.free) + Number(b.locked);
    await this.db.walletSnapshot.create({ data: { wallet: 'spot', balances: toJson(balances) } });
  }

  // wallet 'all' = USDT value per Binance wallet (net worth incl. Earn/bots/other coins)
  async snapshotAll() {
    await this.db.walletSnapshot.create({ data: { wallet: 'all', balances: toJson(await this.api.walletBalances()) } });
  }

  private prompt(kind: string, refId: number, payload: object, dueAt = new Date()) {
    return this.db.pendingPrompt.create({ data: { kind, refId, payload, dueAt } });
  }
}

/** Snapshots store amounts as strings: { "USDT": "123.4" }. */
const toJson = (b: Record<string, number>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v)]));
