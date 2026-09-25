import {
  BadRequestException, Body, CallHandler, Controller, Delete, ExecutionContext, Get, Injectable, NestInterceptor,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { map } from 'rxjs';
import { AskService } from '../ai/ask.service';
import { Prisma } from '../generated/prisma/client';
import { InsightsService } from '../insights/insights.service';
import { BagsService } from '../ledger/bags.service';
import { CategoriesService } from '../ledger/categories.service';
import { DebtsService } from '../ledger/debts.service';
import { LedgerService, type TxInput } from '../ledger/ledger.service';
import { AuthGuard } from './auth.service';

/** Prisma Decimal/bigint -> number in JSON responses. */
const plain = (v: unknown): unknown =>
  Prisma.Decimal.isDecimal(v) ? Number(v)
  : typeof v === 'bigint' ? Number(v)
  : v instanceof Date || v == null || typeof v !== 'object' ? v
  : Array.isArray(v) ? v.map(plain)
  : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));

@Injectable()
class PlainJson implements NestInterceptor {
  intercept(_: ExecutionContext, next: CallHandler) { return next.handle().pipe(map(plain)); }
}

const date = (v: unknown, name: string, required = true): Date | undefined => {
  if (v == null || v === '') { if (required) throw new BadRequestException(`${name} required`); return undefined; }
  const d = new Date(String(v));
  if (isNaN(+d)) throw new BadRequestException(`${name}: invalid date`);
  return d;
};
const num = (v: unknown, name: string): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequestException(`${name}: not a number`);
  return n;
};
const oneOf = <T extends string>(v: unknown, opts: readonly T[], name: string, def?: T): T => {
  if ((v == null || v === '') && def) return def;
  if (!opts.includes(v as T)) throw new BadRequestException(`${name}: one of ${opts.join(', ')}`);
  return v as T;
};

const TYPES = ['transfer', 'expense', 'income', 'fee'] as const;
const NUMERIC = ['amount', 'fromAccountId', 'toAccountId', 'toAmount', 'categoryId', 'debtId', 'rawEventId', 'confidence', 'fxRate'] as const;
const STRINGS = ['currency', 'merchant', 'note', 'justification', 'source', 'fxSource'] as const;

function txBody(b: any, partial: boolean): Partial<TxInput> {
  if (!b || typeof b !== 'object') throw new BadRequestException('body required');
  const out: Record<string, unknown> = {};
  if (b.type !== undefined || !partial) out.type = oneOf(b.type, TYPES, 'type');
  if (b.status !== undefined) out.status = oneOf(b.status, ['pending', 'confirmed'] as const, 'status');
  if (b.occurredAt !== undefined || !partial) out.occurredAt = date(b.occurredAt, 'occurredAt');
  for (const k of NUMERIC) if (b[k] !== undefined) out[k] = b[k] === null ? null : num(b[k], k);
  for (const k of STRINGS) if (b[k] !== undefined) {
    if (b[k] !== null && typeof b[k] !== 'string') throw new BadRequestException(`${k}: string`);
    out[k] = b[k];
  }
  if (!partial) {
    if (!(Number(out.amount) > 0)) throw new BadRequestException('amount > 0 required');
    if (!out.currency) throw new BadRequestException('currency required');
    out.source ??= 'manual_web';
  } else if (out.amount !== undefined && !(Number(out.amount) > 0)) throw new BadRequestException('amount > 0');
  return out as Partial<TxInput>;
}

@Controller()
@UseGuards(AuthGuard)
@UseInterceptors(PlainJson)
export class ApiController {
  constructor(
    private ledger: LedgerService,
    private bags: BagsService,
    private categories: CategoriesService,
    private insights: InsightsService,
    private asker: AskService,
    private debts: DebtsService,
  ) {}

  @Get('overview') overview() { return this.insights.overview(); }

  @Get('transactions')
  transactions(@Query() q: Record<string, string>) {
    return this.insights.listTransactions({
      from: date(q.from, 'from', false), to: date(q.to, 'to', false),
      categoryId: num(q.categoryId, 'categoryId'), accountId: num(q.accountId, 'accountId'),
      type: q.type || undefined, status: q.status || undefined, text: q.text || undefined, merchant: q.merchant || undefined,
      min: num(q.min, 'min'), max: num(q.max, 'max'),
      cursor: num(q.cursor, 'cursor'), limit: num(q.limit, 'limit'),
    });
  }

  @Post('transactions') create(@Body() b: unknown) { return this.ledger.create(txBody(b, false) as TxInput); }

  @Patch('transactions/:id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() b: unknown) {
    await this.found(id);
    return this.ledger.update(id, txBody(b, true));
  }

  @Post('transactions/:id/void') async void(@Param('id', ParseIntPipe) id: number) { await this.found(id); return this.ledger.void(id); }
  @Post('transactions/:id/confirm') async confirm(@Param('id', ParseIntPipe) id: number) { await this.found(id); return this.ledger.confirm(id); }
  @Post('transactions/:id/undo') async undo(@Param('id', ParseIntPipe) id: number) { await this.found(id); return this.ledger.undoLast(id); }

  @Get('accounts') accounts() { return this.ledger.balances(); }

  @Post('accounts/:id/reconcile')
  reconcile(@Param('id', ParseIntPipe) id: number, @Body() b: { actual?: unknown }) {
    const actual = num(b?.actual, 'actual');
    if (actual === undefined || actual < 0) throw new BadRequestException('actual >= 0 required');
    return this.ledger.reconcile(id, actual);
  }

  @Get('categories') cats() { return this.categories.list(); }

  @Get('insights/summary')
  summary(@Query() q: Record<string, string>) {
    return this.insights.spendSummary({
      from: date(q.from, 'from')!, to: date(q.to, 'to')!,
      groupBy: oneOf(q.groupBy, ['category', 'account', 'merchant', 'day'] as const, 'groupBy', 'category'),
      currency: oneOf(q.currency, ['USD', 'VES'] as const, 'currency', 'USD'),
    });
  }

  @Get('insights/compare')
  compare(@Query() q: Record<string, string>) {
    return this.insights.comparePeriods(
      { from: date(q.aFrom, 'aFrom')!, to: date(q.aTo, 'aTo')! },
      { from: date(q.bFrom, 'bFrom')!, to: date(q.bTo, 'bTo')! },
      oneOf(q.groupBy, ['category', 'account', 'merchant'] as const, 'groupBy', 'category'),
    );
  }

  @Get('insights/heatmap') heatmap(@Query() q: Record<string, string>) { return this.insights.heatmap({ from: date(q.from, 'from')!, to: date(q.to, 'to')! }); }
  @Get('insights/rates') rates(@Query() q: Record<string, string>) { return this.insights.rateHistory({ from: date(q.from, 'from')!, to: date(q.to, 'to')! }); }

  @Get('bags')
  bagsList(@Query('openOnly') openOnly?: string, @Query('bagId') bagId?: string) {
    return this.insights.bagStatus({ openOnly: openOnly === '1' || openOnly === 'true', bagId: num(bagId, 'bagId') });
  }

  @Get('debts') debtsList() { return this.debts.list(); }

  @Post('debts')
  createDebt(@Body() b: { name?: unknown; amount?: unknown; currency?: unknown; note?: unknown }) {
    const name = typeof b?.name === 'string' ? b.name.trim() : '';
    const amount = num(b?.amount, 'amount');
    if (!name) throw new BadRequestException('name required');
    if (!(Number(amount) > 0)) throw new BadRequestException('amount > 0 required');
    return this.debts.create({
      name, amount: amount!, currency: oneOf(b.currency, ['VES', 'USD', 'USDT'] as const, 'currency'),
      note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : undefined,
    });
  }

  @Delete('debts/:id') removeDebt(@Param('id', ParseIntPipe) id: number) { return this.debts.remove(id); }

  @Post('ask')
  ask(@Body() b: { question?: unknown }) {
    if (typeof b?.question !== 'string' || !b.question.trim()) throw new BadRequestException('question required');
    // single-user panel: surface the real cause (omniroute down, bad key…) instead of a bare 500
    return this.asker.ask(b.question.trim().slice(0, 2000))
      .catch((e) => ({ answer: `⚠️ No pude responder: ${(e as Error).message}` }));
  }

  private async found(id: number) {
    if (!(await this.ledger.get(id))) throw new NotFoundException();
  }
}
