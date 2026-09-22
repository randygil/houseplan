import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import type { Bag, Prisma, Transaction } from '../generated/prisma/client';
import { LedgerService } from './ledger.service';

type Db = Prisma.TransactionClient;

@Injectable()
export class BagsService {
  constructor(
    private db: PrismaService,
    @Inject(forwardRef(() => LedgerService)) private ledger: LedgerService,
  ) {}

  async open(p2pTx: Transaction, accountId: number, amountVes: number, rate: number): Promise<Bag> {
    const bag = await this.db.bag.create({
      data: { p2pTransactionId: p2pTx.id, accountId, amountVes, remainingVes: amountVes, rate, openedAt: p2pTx.occurredAt },
    });
    return bag;
  }

  async openBags(): Promise<(Bag & { allocatedCount: number })[]> {
    const bags = await this.db.bag.findMany({
      where: { remainingVes: { gt: 0 }, closedAt: null, muted: false },
      include: { _count: { select: { allocations: true } } },
      orderBy: { openedAt: 'asc' },
    });
    return bags.map(({ _count, ...b }) => ({ ...b, allocatedCount: _count.allocations }));
  }

  async mute(bagId: number): Promise<void> {
    await this.db.bag.update({ where: { id: bagId }, data: { muted: true } });
  }

  async explainRest(bagId: number, how: 'savings' | 'spent', categoryId?: number): Promise<void> {
    const bag = await this.db.bag.findUniqueOrThrow({ where: { id: bagId } });
    if (how === 'savings' || Number(bag.remainingVes) <= 0) {
      await this.db.bag.update({ where: { id: bagId }, data: { closedAt: new Date() } });
      return;
    }
    await this.ledger.create(
      {
        type: 'expense', status: 'confirmed', occurredAt: new Date(), amount: Number(bag.remainingVes), currency: 'VES',
        fromAccountId: bag.accountId, categoryId, note: `Resto de la bolsa #${bag.id}`, source: 'manual_text',
      },
      bag.id,
    );
  }

  /**
   * FIFO: drain open bags of the account (opened at/before the tx), oldest first; `preferBagId` goes first.
   * Returns the VES covered, the USD equivalent at each bag's rate, and the first bag used.
   */
  async allocate(db: Db, tx: { id: number; fromAccountId: number; amount: number; occurredAt: Date }, preferBagId?: number) {
    const bags = await db.bag.findMany({
      where: { accountId: tx.fromAccountId, closedAt: null, remainingVes: { gt: 0 }, openedAt: { lte: tx.occurredAt } },
      orderBy: { openedAt: 'asc' },
    });
    if (preferBagId) bags.sort((a, b) => Number(b.id === preferBagId) - Number(a.id === preferBagId));
    let left = tx.amount, usd = 0, firstBagId: number | null = null;
    for (const bag of bags) {
      if (left <= 0) break;
      const remaining = Number(bag.remainingVes);
      const take = Math.min(left, remaining);
      await db.bagAllocation.create({ data: { bagId: bag.id, transactionId: tx.id, amountVes: take } });
      await db.bag.update({
        where: { id: bag.id },
        data: { remainingVes: { decrement: take }, closedAt: take >= remaining ? new Date() : null },
      });
      left -= take;
      usd += take / Number(bag.rate);
      firstBagId ??= bag.id;
    }
    return { covered: tx.amount - Math.max(left, 0), usd, bagId: firstBagId };
  }

  /** Give a tx's VES back to its bags. Bags emptied by allocation reopen; bags closed as savings stay closed. */
  async release(db: Db, transactionId: number): Promise<void> {
    const allocs = await db.bagAllocation.findMany({ where: { transactionId }, include: { bag: true } });
    for (const a of allocs) {
      const wasEmptied = Number(a.bag.remainingVes) <= 0;
      await db.bag.update({
        where: { id: a.bagId },
        data: { remainingVes: { increment: a.amountVes }, ...(wasEmptied && { closedAt: null }) },
      });
    }
    await db.bagAllocation.deleteMany({ where: { transactionId } });
  }
}
