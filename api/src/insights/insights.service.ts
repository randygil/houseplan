import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { TZ, ymd } from '../fx/fx.service';
import { Prisma, type Bag } from '../generated/prisma/client';
import { CategoriesService } from '../ledger/categories.service';
import { LedgerService, TX_INCLUDE, type TxView } from '../ledger/ledger.service';

/** `to` is inclusive. */
export type Range = { from: Date; to: Date };
type Group = 'category' | 'account' | 'merchant' | 'day';
type Row = { key: string; label: string; total: number; count: number };

const SPEND = Prisma.sql`t.type IN ('expense','fee') AND t.status <> 'void'`;

@Injectable()
export class InsightsService {
  constructor(private db: PrismaService, private ledger: LedgerService, private categories: CategoriesService) {}

  async spendSummary(r: Range & { groupBy: Group; currency?: 'USD' | 'VES' }): Promise<Row[]> {
    const key = {
      category: Prisma.sql`coalesce(c.id::text, 'none')`,
      account: Prisma.sql`coalesce(a.code, 'none')`,
      merchant: Prisma.sql`coalesce(lower(t.merchant), 'none')`,
      day: Prisma.sql`to_char(t."occurredAt" AT TIME ZONE ${TZ}, 'YYYY-MM-DD')`,
    }[r.groupBy];
    const label = {
      category: Prisma.sql`coalesce(c.name, 'Sin categoría')`,
      account: Prisma.sql`coalesce(a.name, 'Sin cuenta')`,
      merchant: Prisma.sql`coalesce(min(t.merchant), 'Sin comercio')`,
      day: key,
    }[r.groupBy];
    // VES view: native VES amount, else USD converted at that day's rate (freshest; p2p_avg > market > bcv).
    const value = r.currency === 'VES'
      ? Prisma.sql`CASE WHEN t.currency = 'VES' THEN t.amount ELSE t."amountUsd" * (
          SELECT "vesPerUsd" FROM fx_rates WHERE date <= (t."occurredAt" AT TIME ZONE ${TZ})::date
          ORDER BY date DESC, array_position(ARRAY['p2p_avg','market','bcv'], source) LIMIT 1) END`
      : Prisma.sql`t."amountUsd"`;
    const rows = await this.db.$queryRaw<{ key: string; label: string; total: unknown; count: bigint }[]>`
      SELECT ${key} AS key, ${label} AS label, coalesce(sum(${value}), 0) AS total, count(*) AS count
      FROM transactions t
      LEFT JOIN categories c ON c.id = t."categoryId"
      LEFT JOIN accounts a ON a.id = t."fromAccountId"
      WHERE ${SPEND} AND t."occurredAt" BETWEEN ${r.from} AND ${r.to}
      GROUP BY 1${r.groupBy === 'merchant' ? Prisma.empty : Prisma.sql`, 2`}
      ORDER BY ${r.groupBy === 'day' ? Prisma.sql`1` : Prisma.sql`3 DESC`}`;
    const out = rows.map((x) => ({ key: x.key, label: x.label, total: Number(x.total), count: Number(x.count) }));
    if (r.groupBy === 'category') {
      const paths = new Map((await this.categories.list()).map((c) => [String(c.id), `${c.emoji ?? ''} ${c.path}`.trim()]));
      for (const o of out) o.label = paths.get(o.key) ?? o.label;
    }
    return out;
  }

  async listTransactions(q: Partial<Range> & {
    categoryId?: number; accountId?: number; merchant?: string; text?: string; min?: number; max?: number;
    type?: string; status?: string; limit?: number; cursor?: number;
  }): Promise<{ items: TxView[]; nextCursor: number | null }> {
    const take = Math.min(q.limit ?? 50, 500);
    const where: Prisma.TransactionWhereInput = {
      status: q.status ?? { not: 'void' },
      type: q.type,
      ...((q.from || q.to) && { occurredAt: { gte: q.from, lte: q.to } }),
      ...((q.min != null || q.max != null) && { amountUsd: { gte: q.min, lte: q.max } }),
      merchant: q.merchant ? { contains: q.merchant, mode: 'insensitive' } : undefined,
      AND: [
        q.accountId ? { OR: [{ fromAccountId: q.accountId }, { toAccountId: q.accountId }] } : {},
        q.categoryId ? { OR: [{ categoryId: q.categoryId }, { category: { parentId: q.categoryId } }] } : {},
        q.text ? { OR: (['merchant', 'note', 'justification'] as const).map((f) => ({ [f]: { contains: q.text, mode: 'insensitive' } })) } : {},
      ],
    };
    const items = await this.db.transaction.findMany({
      where, include: TX_INCLUDE, take, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    });
    return { items, nextCursor: items.length === take ? items[items.length - 1].id : null };
  }

  /** delta = a − b. */
  async comparePeriods(a: Range, b: Range, groupBy: Exclude<Group, 'day'>) {
    const [ra, rb] = await Promise.all([this.spendSummary({ ...a, groupBy }), this.spendSummary({ ...b, groupBy })]);
    const m = new Map<string, { key: string; label: string; a: number; b: number; delta: number }>();
    for (const x of ra) m.set(x.key, { key: x.key, label: x.label, a: x.total, b: 0, delta: 0 });
    for (const x of rb) m.set(x.key, { key: x.key, label: x.label, a: 0, ...m.get(x.key), b: x.total, delta: 0 });
    return [...m.values()].map((x) => ({ ...x, delta: x.a - x.b })).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta));
  }

  async bagStatus(opts: { bagId?: number; openOnly?: boolean }): Promise<{ bag: Bag; account: string; spent: number; remaining: number; txs: TxView[] }[]> {
    const bags = await this.db.bag.findMany({
      where: { id: opts.bagId, ...(opts.openOnly && { closedAt: null, remainingVes: { gt: 0 } }) },
      include: { account: true, allocations: { include: { transaction: { include: TX_INCLUDE } } } },
      orderBy: { openedAt: 'desc' },
      take: 50,
    });
    return bags.map(({ account, allocations, ...bag }) => ({
      bag, account: account.name,
      spent: Number(bag.amountVes) - Number(bag.remainingVes),
      remaining: Number(bag.remainingVes),
      txs: allocations.map((x) => x.transaction),
    }));
  }

  async overview() {
    const justifyOver = Number(process.env.JUSTIFY_OVER_USD ?? 20);
    const day = Prisma.sql`date_trunc('day', now() AT TIME ZONE ${TZ})`;
    const at = (p: Prisma.Sql) => Prisma.sql`((${p}) AT TIME ZONE ${TZ})`;
    const [[s], balances, bcv, p2p, market, spark] = await Promise.all([
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT
          coalesce(sum(t."amountUsd") FILTER (WHERE t."occurredAt" >= ${at(day)}), 0) AS today,
          coalesce(sum(t."amountUsd") FILTER (WHERE t."occurredAt" >= ${at(Prisma.sql`date_trunc('week', now() AT TIME ZONE ${TZ})`)}), 0) AS week,
          coalesce(sum(t."amountUsd") FILTER (WHERE t."occurredAt" >= ${at(Prisma.sql`date_trunc('month', now() AT TIME ZONE ${TZ})`)}), 0) AS month,
          coalesce(sum(t."amountUsd") FILTER (WHERE t."occurredAt" >= ${at(Prisma.sql`date_trunc('month', now() AT TIME ZONE ${TZ}) - interval '1 month'`)}
                                              AND t."occurredAt" < ${at(Prisma.sql`date_trunc('month', now() AT TIME ZONE ${TZ})`)}), 0) AS "lastMonth",
          count(*) FILTER (WHERE NOT t.justified AND (t."amountUsd" > ${justifyOver} OR c.name = 'Otros')) AS "toJustify"
        FROM transactions t LEFT JOIN categories c ON c.id = t."categoryId"
        WHERE ${SPEND}`,
      this.ledger.balances(),
      this.db.fxRate.findFirst({ where: { source: 'bcv' }, orderBy: { date: 'desc' } }),
      this.db.fxRate.findFirst({ where: { source: 'p2p_avg' }, orderBy: { date: 'desc' } }),
      this.db.fxRate.findFirst({ where: { source: 'market' }, orderBy: { date: 'desc' } }),
      this.db.$queryRaw<{ date: string; total: unknown }[]>`
        SELECT to_char(d, 'YYYY-MM-DD') AS date, coalesce(sum(t."amountUsd"), 0) AS total
        FROM generate_series(${day} - interval '29 days', ${day}, interval '1 day') d
        LEFT JOIN transactions t ON ${SPEND} AND (t."occurredAt" AT TIME ZONE ${TZ})::date = d::date
        GROUP BY d ORDER BY d`,
    ]);
    const [pending, all] = await Promise.all([
      this.db.transaction.count({ where: { status: 'pending' } }),
      this.db.walletSnapshot.findFirst({ where: { wallet: 'all' }, orderBy: { takenAt: 'desc' } }),
    ]);
    // Binance part from the all-wallets snapshot (Earn, bots, other coins) when we have it; synced accounts only hold USDT
    const binanceAll = all ? Object.values(all.balances as Record<string, number>).reduce((n, v) => n + Number(v), 0) : null;
    return {
      netWorthUsd: balances.reduce((n, b) => n + (binanceAll != null && b.kind === 'synced' ? 0 : b.balanceUsd ?? 0), 0) + (binanceAll ?? 0),
      today: Number(s.today), week: Number(s.week), month: Number(s.month), lastMonth: Number(s.lastMonth),
      toJustify: Number(s.toJustify), pending,
      rates: { bcv: bcv ? Number(bcv.vesPerUsd) : null, p2p: p2p ? Number(p2p.vesPerUsd) : null, market: market ? Number(market.vesPerUsd) : null },
      spark: spark.map((x) => ({ date: x.date, total: Number(x.total) })),
    };
  }

  /** dow: 0 = Sunday (Caracas time). */
  async heatmap(r: Range): Promise<{ dow: number; hour: number; total: number }[]> {
    const rows = await this.db.$queryRaw<{ dow: number; hour: number; total: unknown }[]>`
      SELECT extract(dow FROM t."occurredAt" AT TIME ZONE ${TZ})::int AS dow, extract(hour FROM t."occurredAt" AT TIME ZONE ${TZ})::int AS hour,
             coalesce(sum(t."amountUsd"), 0) AS total
      FROM transactions t WHERE ${SPEND} AND t."occurredAt" BETWEEN ${r.from} AND ${r.to}
      GROUP BY 1, 2 ORDER BY 1, 2`;
    return rows.map((x) => ({ dow: x.dow, hour: x.hour, total: Number(x.total) }));
  }

  async rateHistory(r: Range): Promise<{ date: string; bcv: number | null; p2p: number | null; market: number | null }[]> {
    const rows = await this.db.$queryRaw<{ date: string; bcv: unknown; p2p: unknown; market: unknown }[]>`
      SELECT to_char(date, 'YYYY-MM-DD') AS date,
             max("vesPerUsd") FILTER (WHERE source = 'bcv') AS bcv, max("vesPerUsd") FILTER (WHERE source = 'p2p_avg') AS p2p,
             max("vesPerUsd") FILTER (WHERE source = 'market') AS market
      FROM fx_rates WHERE date BETWEEN ${ymd(r.from)}::date AND ${ymd(r.to)}::date
      GROUP BY date ORDER BY date`;
    return rows.map((x) => ({ date: x.date, bcv: x.bcv == null ? null : Number(x.bcv), p2p: x.p2p == null ? null : Number(x.p2p), market: x.market == null ? null : Number(x.market) }));
  }
}
