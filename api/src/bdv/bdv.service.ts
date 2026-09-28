import { BadRequestException, CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { BotService } from '../bot/bot.service';
import { esc, money } from '../bot/ui';
import { checkPassword } from '../http/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { match, parseRow, unseen, type RawRow, type Row } from './bdv.logic';

/** Rows younger than this wait for the next run: gives Randy time to log the expense himself first. */
const GRACE = 2 * 3_600_000;
const DAY = 86_400_000;
const MAX_CARDS = 5;
/** Below this a movement isn't worth its own card: unmatched ones go into one "menores" line per direction. */
const MIN_BS = 1000;

/** The tray app on Randy's PC authenticates with `Authorization: Bearer $BDV_SYNC_TOKEN`. */
@Injectable()
export class BdvTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const h = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers.authorization ?? '';
    if (!checkPassword(h.replace(/^Bearer /, ''), process.env.BDV_SYNC_TOKEN)) throw new UnauthorizedException();
    return true;
  }
}

@Injectable()
export class BdvService {
  private log = new Logger('BDV');

  constructor(private db: PrismaService, private ledger: LedgerService, private bot: BotService) {}

  async failed(error: string) {
    this.log.warn(`sync failed: ${error}`);
    await this.bot.send(`⚠️ BDV: no pude consultar (${esc(error.slice(0, 200))}).\nPausé las consultas automáticas: revisa y dale «Sincronizar ahora» en la bandeja.`);
  }

  /** `from`: also (re)process rows up to that far back, even ones an earlier run skipped as history. */
  async sync(raw: RawRow[], from?: Date) {
    if (!Array.isArray(raw) || !raw.length) throw new BadRequestException('rows required');
    const acct = await this.ledger.accountByCode('bdv');
    const since = acct.lastReconciledAt ?? acct.openingAt;
    // Table order is newest first; the first row old enough is the reconcile anchor (its saldo = balance right after it).
    const rows = raw.map(parseRow).filter((r) => +r.at <= Date.now() - GRACE);
    const anchor = rows[0];
    if (!anchor) return { rows: 0 };

    const events = await this.db.rawEvent.findMany({
      where: { source: 'bdv', externalId: { in: rows.map((r) => r.ref) } }, select: { externalId: true, occurredAt: true, payload: true },
    });
    const fresh = unseen(rows, events, from);
    // First run ever: everything already on the statement is history (baked into today's balance), just anchor.
    const first = !from && !(await this.db.rawEvent.count({ where: { source: 'bdv' } }));
    const todo = first ? [] : fresh.filter((r) => r.at > (from ?? since));

    const cands = await this.candidates(acct.id, todo);
    const matched = match(todo, cands);
    const fees = todo.filter((r) => r.fee);
    const small = todo.filter((r) => !r.fee && !matched.has(r.ref) && Math.abs(r.amount) < MIN_BS);
    const created: number[] = [];

    const feeTx = fees.length ? await this.ledger.create({
      type: 'fee', status: 'confirmed', occurredAt: fees[0].at, amount: round(fees.reduce((s, r) => s - r.amount, 0)), currency: 'VES',
      fromAccountId: acct.id, categoryId: (await this.db.category.findFirst({ where: { name: 'Comisiones' } }))?.id,
      note: `Comisiones BDV (${fees.length})`, source: 'bdv',
    }) : null;

    const smallTx = new Map<Row, number>();
    for (const inflow of [false, true]) {
      const g = small.filter((r) => r.amount > 0 === inflow);
      if (!g.length) continue;
      const tx = await this.ledger.create({
        type: inflow ? 'income' : 'expense', occurredAt: g[0].at, amount: round(Math.abs(g.reduce((s, r) => s + r.amount, 0))), currency: 'VES',
        ...(inflow ? { toAccountId: acct.id } : { fromAccountId: acct.id }), source: 'bdv',
        note: `Movimientos menores de ${money(MIN_BS, 'VES')} (${g.length}): ${g.map((r) => r.desc.toLowerCase()).filter((d, i, a) => a.indexOf(d) === i).join(', ')}`.slice(0, 500),
      });
      for (const r of g) smallTx.set(r, tx.id);
      created.push(tx.id);
    }

    for (const r of fresh) {
      const txId = matched.get(r.ref) ?? (r.fee ? feeTx?.id : smallTx.get(r));
      const data = { source: 'bdv', externalId: r.ref, occurredAt: r.at, processedAt: new Date(), payload: { ...r, at: r.at.toISOString(), txId, skipped: todo.includes(r) ? undefined : true } };
      const ev = await this.db.rawEvent.upsert({ where: { source_externalId: { source: 'bdv', externalId: r.ref } }, create: data, update: data });
      if (!todo.includes(r) || txId) continue;
      const tx = await this.ledger.create({
        type: r.amount < 0 ? 'expense' : 'income', occurredAt: r.at, amount: Math.abs(r.amount), currency: 'VES',
        ...(r.amount < 0 ? { fromAccountId: acct.id } : { toAccountId: acct.id }), note: r.desc, source: 'bdv', rawEventId: ev.id,
      });
      await this.db.rawEvent.update({ where: { id: ev.id }, data: { payload: { ...(ev.payload as object), txId: tx.id } } });
      created.push(tx.id);
    }

    // A tx logged by hand after the bank posted it would land past the anchor and count twice: move it to the bank's time.
    for (const r of todo) {
      const id = matched.get(r.ref);
      const c = cands.find((x) => x.id === id);
      if (c && c.at > anchor.at) await this.ledger.update(c.id, { occurredAt: r.at }, 'bdv');
    }
    // Logged by hand on BDV in this window but not on the statement: maybe the wrong account.
    const matchedIds = new Set(matched.values());
    const phantoms = cands.filter((c) => !matchedIds.has(c.id) && c.at > since && c.at <= anchor.at);

    // No lump "diferencia" tx: every movement is its own line now; whatever is left over is only reported.
    const rec = anchor.at > since ? await this.ledger.reconcile(acct.id, anchor.saldo, anchor.at, false) : null;
    await this.report({ anchor, todo, matched: matched.size, created, fees, rec, phantoms, first });
    return { rows: rows.length, fresh: fresh.length, matched: matched.size, created: created.length, fees: fees.length, diff: rec?.diff ?? null };
  }

  /** Ledger txs on BDV that a bank row could be (not bank-made, not already claimed by an earlier row). */
  private async candidates(accountId: number, rows: Row[]) {
    if (!rows.length) return [];
    const times = rows.map((r) => +r.at);
    const claimed = (await this.db.$queryRaw<{ id: number }[]>`
      SELECT DISTINCT (payload->>'txId')::int AS id FROM raw_events
      WHERE source = 'bdv' AND payload->>'txId' IS NOT NULL AND "occurredAt" > ${new Date(Math.min(...times) - 7 * DAY)}`).map((x) => x.id);
    const txs = await this.db.transaction.findMany({
      where: {
        status: { not: 'void' }, source: { notIn: ['bdv', 'reconcile'] }, id: { notIn: claimed },
        OR: [{ fromAccountId: accountId }, { toAccountId: accountId }],
        occurredAt: { gte: new Date(Math.min(...times) - 2 * DAY), lte: new Date(Math.max(...times) + 2 * DAY) },
      },
    });
    return txs.map((t) => {
      const inflow = t.toAccountId === accountId;
      return { id: t.id, at: t.occurredAt, inflow, amount: Number(inflow ? t.toAmount ?? t.amount : t.amount) };
    });
  }

  private async report(o: {
    anchor: Row; todo: Row[]; matched: number; created: number[]; fees: Row[];
    rec: { diff: number } | null; phantoms: { id: number; at: Date; amount: number }[]; first: boolean;
  }) {
    const hm = o.anchor.at.toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Caracas' });
    const lines = [`🏦 <b>BDV</b> al ${hm}: saldo ${money(o.anchor.saldo, 'VES')}`];
    if (o.first) lines.push('Primera consulta: tomo este saldo como punto de partida.');
    else if (!o.todo.length) return; // nothing new since the last run: stay quiet
    else {
      lines.push(`${o.todo.length} movimientos nuevos: ${o.matched} ya los tenías, ${o.created.length} por clasificar` + (o.fees.length ? `, ${o.fees.length} comisiones (${money(-o.fees.reduce((s, r) => s + r.amount, 0), 'VES')})` : ''));
      const d = o.rec?.diff ?? 0;
      if (Math.abs(d) < 0.01) lines.push('✅ Cuadra.');
      else if (d > 0) lines.push(`👌 Había ${money(d, 'VES')} más de lo anotado; ajusté.`);
      else lines.push(`⚠️ Faltan ${money(-d, 'VES')} que no explica ningún movimiento; ajusté el saldo.`);
      if (o.phantoms.length) lines.push(`❓ No aparecen en el banco: ${o.phantoms.map((p) => money(p.amount, 'VES')).join(', ')}. ¿Eran de otra cuenta?`);
    }
    await this.bot.send(lines.join('\n'), undefined, o.phantoms.map((p) => p.id));
    for (const id of o.created.slice(0, MAX_CARDS)) await this.bot.showTx(id, { prefix: 'Nuevo en BDV:' });
    if (o.created.length > MAX_CARDS) await this.bot.send(`…y ${o.created.length - MAX_CARDS} más pendientes en el panel.`);
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
