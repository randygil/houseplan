import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { FxService } from '../fx/fx.service';

const isUsd = (c: string) => c === 'USD' || c === 'USDT';
type Pay = { amount: unknown; currency: string; amountUsd: unknown };

/** How much of `debtCurrency` a payment covers. Bs debt paid in $ → today's rate. */
export function paidIn(debtCurrency: string, p: Pay, vesPerUsd: number | null): number {
  if (p.currency === debtCurrency || (isUsd(p.currency) && isUsd(debtCurrency))) return Number(p.amount);
  if (p.amountUsd == null) return 0;
  return isUsd(debtCurrency) ? Number(p.amountUsd) : Number(p.amountUsd) * (vesPerUsd ?? 0);
}

export type DebtView = {
  id: number; name: string; currency: string; amount: number; note: string | null; createdAt: Date;
  paid: number; remaining: number; remainingUsd: number; payments: number;
};

@Injectable()
export class DebtsService {
  constructor(private db: PrismaService, private fx: FxService) {}

  async list(): Promise<DebtView[]> {
    const [rows, rate] = await Promise.all([
      this.db.debt.findMany({ orderBy: { id: 'asc' }, include: { payments: { where: { status: { not: 'void' } } } } }),
      this.fx.rate(new Date()),
    ]);
    return rows.map(({ payments, ...d }) => {
      const paid = payments.reduce((s, p) => s + paidIn(d.currency, p, rate), 0);
      const remaining = Math.max(0, Number(d.amount) - paid);
      return { ...d, amount: Number(d.amount), paid, remaining, remainingUsd: isUsd(d.currency) ? remaining : rate ? remaining / rate : 0, payments: payments.length };
    });
  }

  async get(id: number) { return (await this.list()).find((d) => d.id === id) ?? null; }

  create(d: { name: string; currency: string; amount: number; note?: string }) {
    return this.db.debt.create({ data: d });
  }

  /** Payments stay as expenses, just unlinked (FK is ON DELETE SET NULL). */
  remove(id: number) { return this.db.debt.delete({ where: { id } }); }
}
