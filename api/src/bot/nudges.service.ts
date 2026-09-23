import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InlineKeyboard } from 'grammy';
import { EmbeddingsService } from '../ai/embeddings.service';
import { LlmService } from '../ai/llm.service';
import { PrismaService } from '../db/prisma.service';
import type { PendingPrompt } from '../generated/prisma/client';
import { InsightsService } from '../insights/insights.service';
import { BagsService } from '../ledger/bags.service';
import { CategoriesService } from '../ledger/categories.service';
import { LedgerService } from '../ledger/ledger.service';
import { BotService } from './bot.service';
import { atLocal, cb, dayLabel, esc, inQuiet, money, startOfDay, startOfWeek, usd } from './ui';

const TZ = 'America/Caracas';
const ORDER = ['p2p_intro', 'card_delta', 'pay_classify', 'ask_account', 'reconcile', 'bag_followup'];
const CAPPED = ['reconcile', 'bag_followup'];
type Bagish = { id: number; amountVes: unknown; remainingVes: unknown; openedAt: Date; account: { name: string }; _count: { allocations: number } };

/** Pure: text for one grouped bag_followup message (PLAN 4.3). */
export function followupText(bags: Bagish[], now: Date): string {
  if (bags.length === 1) {
    const b = bags[0], rem = money(Math.round(Number(b.remainingVes)), 'VES'), n = b._count.allocations;
    const when = dayLabel(b.openedAt, now);
    if (n > 0) {
      const spent = money(Math.round(Number(b.amountVes) - Number(b.remainingVes)), 'VES');
      return `Del cambio ${when} registraste ${n} gasto${n > 1 ? 's' : ''} (${spent}). Quedan ~${rem} en ${esc(b.account.name)}. ¿Algo más?`;
    }
    return `Del cambio ${when} quedan ~${rem} en ${esc(b.account.name)} sin movimientos registrados. ¿Gastaste algo?`;
  }
  const lines = bags.map((b) => `• ${esc(b.account.name)}: ~${money(Math.round(Number(b.remainingVes)), 'VES')} (cambio ${dayLabel(b.openedAt, now)}${b._count.allocations ? `, ${b._count.allocations} gastos` : ''})`);
  return `Tienes ${bags.length} cambios con saldo sin explicar:\n${lines.join('\n')}\n¿Gastaste algo?`;
}

@Injectable()
export class NudgesService implements OnModuleInit {
  private log = new Logger('Nudges');
  private busy = false;

  constructor(
    private db: PrismaService,
    private botSvc: BotService,
    private ledger: LedgerService,
    private bags: BagsService,
    private cats: CategoriesService,
    private insights: InsightsService,
    private llm: LlmService,
    private emb: EmbeddingsService,
  ) {}

  onModuleInit() {
    this.botSvc.bot?.callbackQuery(/^n:/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, act, pid, arg] = ctx.callbackQuery.data.split(':');
      try { await this.onButton(act, Number(pid), arg, ctx.callbackQuery.message?.message_id); }
      catch (e) { this.log.error(e); await this.botSvc.send('Uy, algo falló 😅').catch(() => {}); }
    });
  }

  // ── dispatcher ──────────────────────────────────────────────────────────
  @Cron('* * * * *', { timeZone: TZ })
  async tick() {
    if (!this.botSvc.bot || this.busy) return;
    this.busy = true;
    try { await this.dispatch(new Date()); }
    catch (e) { this.log.error(e); }
    finally { this.busy = false; }
  }

  private async dispatch(now: Date) {
    if (inQuiet(now, process.env.QUIET_HOURS ?? '22:00-08:00')) return;
    const due = await this.db.pendingPrompt.findMany({
      where: { sentAt: null, answeredAt: null, cancelledAt: null, dueAt: { lte: now }, kind: { in: ORDER } },
      orderBy: { dueAt: 'asc' },
    });
    if (!due.length) return;
    const cancel = (ids: number[]) => ids.length && this.db.pendingPrompt.updateMany({ where: { id: { in: ids } }, data: { cancelledAt: now } });

    // Follow-ups: drop stale (from a previous day) and dead bags; one message for all open bags.
    const follow = due.filter((p) => p.kind === 'bag_followup');
    const live: { p: PendingPrompt; bag: Bagish }[] = [];
    const dead: number[] = [];
    for (const p of follow) {
      const bag = p.refId ? await this.db.bag.findUnique({ where: { id: p.refId }, include: { account: true, _count: { select: { allocations: true } } } }) : null;
      const ok = bag && !bag.closedAt && !bag.muted && Number(bag.remainingVes) > 0 && p.dueAt >= startOfDay(now);
      if (!ok || live.some((l) => l.bag.id === bag.id)) dead.push(p.id); else live.push({ p, bag });
    }
    await cancel(dead);

    // Cap only the repetitive reminders; event prompts (a P2P/card/Pay that just happened) always go out.
    let budget = Number(process.env.NUDGE_DAILY_CAP ?? 4) - await this.db.pendingPrompt.count({ where: { sentAt: { gte: startOfDay(now) }, kind: { in: CAPPED } } });
    const others = due.filter((p) => p.kind !== 'bag_followup').sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    for (const p of others) {
      const capped = CAPPED.includes(p.kind);
      if (capped && budget <= 0) continue;
      if (await this.sendOne(p, now) && capped) budget--;
    }
    if (live.length && budget > 0) await this.sendFollowups(live, now);
  }

  private async mark(ids: number[], messageId: number) {
    await this.db.pendingPrompt.updateMany({ where: { id: { in: ids } }, data: { sentAt: new Date(), telegramMessageId: messageId, attempts: { increment: 1 } } });
  }

  private async failed(p: PendingPrompt, e: unknown) {
    this.log.warn(`prompt ${p.id} (${p.kind}): ${(e as Error).message}`);
    await this.db.pendingPrompt.update({ where: { id: p.id }, data: { attempts: { increment: 1 }, ...(p.attempts >= 2 ? { cancelledAt: new Date() } : {}) } });
  }

  private async sendFollowups(live: { p: PendingPrompt; bag: Bagish }[], now: Date) {
    const pid = live[0].p.id;
    const k = new InlineKeyboard().text('Sí, registrar', cb('n', 'reg', pid)).text('Nada todavía', cb('n', 'nada', pid)).row();
    if (live.length === 1) k.text('Ya lo gasté todo en…', cb('n', 'all', pid)).text('Recordar mañana', cb('n', 'tmrw', pid)).row().text('No preguntes por este', cb('n', 'mute', pid));
    else k.text('Recordar mañana', cb('n', 'tmrw', pid));
    try {
      const m = await this.botSvc.send(followupText(live.map((l) => l.bag), now), k);
      await this.mark(live.map((l) => l.p.id), m.message_id);
    } catch (e) { for (const l of live) await this.failed(l.p, e); }
  }

  private async sendOne(p: PendingPrompt, now: Date): Promise<boolean> {
    const pl = (p.payload ?? {}) as Record<string, any>;
    let text: string;
    const k = new InlineKeyboard();
    switch (p.kind) {
      case 'p2p_intro':
        ({ text } = p2pIntro(p.id, pl, k));
        break;
      case 'reconcile': {
        const acc = p.refId ? await this.db.account.findUnique({ where: { id: p.refId } }) : null;
        if (!acc) { await this.db.pendingPrompt.update({ where: { id: p.id }, data: { cancelledAt: now } }); return false; }
        text = `🏦 ${esc(acc.name)} debería tener ~${money(Math.round(Number(pl.expected)), acc.currency)}. ¿Es así?`;
        k.text('✅ Sí', cb('n', 'rok', p.id)).text('No, tengo…', cb('n', 'rno', p.id));
        break;
      }
      case 'card_delta': {
        const merchants = await this.frequentMerchants();
        text = `💳 Salieron ${money(Number(pl.usdt), 'USDT')} del Funding${pl.at ? ` a las ${new Date(pl.at).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ })}` : ''}, probablemente tarjeta. ¿Dónde fue?`;
        merchants.forEach((m, i) => { k.text(m, cb('n', 'm', p.id, i)); if (i % 2) k.row(); });
        k.row().text('Otro…', cb('n', 'mo', p.id)).text('No fue compra', cb('n', 'mx', p.id));
        await this.db.pendingPrompt.update({ where: { id: p.id }, data: { payload: { ...pl, merchants } } });
        break;
      }
      case 'pay_classify':
        text = `📤 Enviaste ${money(Number(pl.amount), String(pl.currency ?? 'USDT'))} por Binance Pay${pl.counterparty ? ` a ${esc(String(pl.counterparty))}` : ''}. ¿Qué fue?`;
        k.text('Gasto', cb('n', 'pg', p.id)).text('Le presté', cb('n', 'pl', p.id)).text('Es mío (otra cuenta)', cb('n', 'pm', p.id));
        break;
      case 'ask_account':
        text = `🏦 ¿De qué banco fue el pago móvil «${esc(String(pl.payMethodName ?? ''))}»?`;
        k.text('Mercantil', cb('n', 'acc', p.id, 'mercantil')).text('BDV', cb('n', 'acc', p.id, 'bdv'));
        break;
      default:
        return false;
    }
    try {
      const m = await this.botSvc.send(text, k, p.kind === 'reconcile' || !p.refId ? [] : [p.refId]);
      await this.mark([p.id], m.message_id);
      return true;
    } catch (e) { await this.failed(p, e); return false; }
  }

  private async frequentMerchants(): Promise<string[]> {
    const rows = await this.db.transaction.groupBy({
      by: ['merchant'], where: { merchant: { not: null }, status: 'confirmed', currency: { in: ['USDT', 'USD'] }, type: 'expense' },
      _count: { merchant: true }, orderBy: { _count: { merchant: 'desc' } }, take: 4,
    });
    return rows.map((r) => r.merchant!).filter((m) => Buffer.byteLength(m) <= 40);
  }

  // ── buttons ─────────────────────────────────────────────────────────────
  private async onButton(act: string, pid: number, arg: string | undefined, msgId?: number) {
    const p = await this.db.pendingPrompt.findUnique({ where: { id: pid } });
    if (!p) return;
    // grouped follow-ups share the telegram message: act on all of them
    const group = p.telegramMessageId ? await this.db.pendingPrompt.findMany({ where: { telegramMessageId: p.telegramMessageId } }) : [p];
    const answer = () => this.db.pendingPrompt.updateMany({ where: { id: { in: group.map((g) => g.id) } }, data: { answeredAt: new Date() } });
    const reply = async (html: string) => { await answer(); if (msgId) await this.botSvc.edit(msgId, html); };
    const bagIds = group.map((g) => g.refId!).filter(Boolean);
    const cancelFollowups = (ids: number[]) => this.db.pendingPrompt.updateMany({
      where: { kind: { in: ['bag_followup', 'reconcile'] }, refId: { in: ids }, sentAt: null, cancelledAt: null }, data: { cancelledAt: new Date() },
    });
    const pl = (p.payload ?? {}) as Record<string, any>;

    switch (act) {
      // p2p_intro
      case 'day': return reply('👌 Dale, más tarde te pregunto qué gastaste.');
      case 'one': return reply('👌 Cuando pagues, cuéntame qué fue y cuánto.');
      case 'save':
        await this.bags.explainRest(p.refId!, 'savings');
        await cancelFollowups([p.refId!]);
        return reply('🐷 Anotado como ahorro en Bs. No te pregunto más por este cambio.');
      case 'move':
        await this.bags.mute(p.refId!);
        return reply('👌 Listo, no te pregunto más por este cambio.');
      case 'bank': { // payMethodName guessed the wrong bank
        const acc = await this.ledger.accountByCode(arg!);
        await this.bags.move(p.refId!, acc.id);
        const payload = { ...pl, account: acc.code };
        await this.db.pendingPrompt.update({ where: { id: p.id }, data: { payload } });
        const k = new InlineKeyboard();
        return msgId && this.botSvc.edit(msgId, p2pIntro(p.id, payload, k).text, k);
      }
      // bag_followup
      case 'reg': await answer(); return this.botSvc.send('Dale 🙂 escríbeme o mándame una nota de voz: «gasté 350 en pan».');
      case 'nada': return reply('👌 Ok, te pregunto luego.');
      case 'tmrw': {
        await cancelFollowups(bagIds);
        const at = atLocal(new Date(startOfDay(new Date()).getTime() + 864e5), (process.env.NUDGE_TIMES ?? '13:30').split(',')[0]);
        await this.db.pendingPrompt.createMany({ data: bagIds.map((refId) => ({ kind: 'bag_followup', refId, dueAt: at })) });
        return reply('⏰ Te recuerdo mañana.');
      }
      case 'mute':
        for (const id of bagIds) await this.bags.mute(id);
        await cancelFollowups(bagIds);
        return reply('🔕 No te pregunto más por este cambio.');
      case 'all': {
        const top = (await this.cats.list()).filter((c) => !c.parentId);
        const k = new InlineKeyboard();
        top.forEach((c, i) => { k.text(`${c.emoji ?? ''} ${c.name}`.trim(), cb('n', 'allc', pid, c.id)); if (i % 3 === 2) k.row(); });
        return msgId && this.botSvc.edit(msgId, '¿En qué se fue todo?', k);
      }
      case 'allc':
        await this.bags.explainRest(p.refId!, 'spent', Number(arg));
        await cancelFollowups([p.refId!]);
        return reply('✅ Registré el resto de ese cambio como gasto.');
      // reconcile
      case 'rok': {
        await answer();
        if (msgId) await this.botSvc.edit(msgId, '✅ Perfecto.');
        await this.ledger.reconcile(p.refId!, Number(pl.expected));
        return;
      }
      case 'rno': {
        const acc = await this.db.account.findUnique({ where: { id: p.refId! } });
        this.botSvc.awaiting = { kind: 'balance', accountId: p.refId!, promptId: p.id, at: Date.now() };
        return this.botSvc.send(`¿Cuánto tiene ${esc(acc?.name ?? 'la cuenta')}? Escribe el monto.`);
      }
      // card_delta
      case 'm': {
        const merchant = (pl.merchants ?? [])[Number(arg)];
        if (!merchant) return;
        const rule = await this.cats.ruleFor(merchant);
        await this.ledger.update(p.refId!, { merchant, ...(rule ? { categoryId: rule.categoryId } : {}) });
        if (rule) await this.ledger.confirm(p.refId!);
        await answer();
        await this.botSvc.showTx(p.refId!, { msgId });
        if (rule) await this.botSvc.afterConfirm(p.refId!);
        return;
      }
      case 'mo':
        await answer();
        this.botSvc.awaiting = { kind: 'merchant', txId: p.refId!, msgId, at: Date.now() };
        return this.botSvc.send('🏪 ¿Dónde fue?');
      case 'mx':
        await this.ledger.void(p.refId!);
        return reply('👌 Ok, lo descarto.');
      // pay_classify
      case 'pg': await answer(); return this.botSvc.showTx(p.refId!, { msgId, mode: 'cat' });
      case 'pl':
      case 'pm':
        await this.ledger.update(p.refId!, { type: 'transfer', note: act === 'pl' ? `Préstamo${pl.counterparty ? ` a ${pl.counterparty}` : ''}` : 'A cuenta propia' });
        await this.ledger.confirm(p.refId!);
        return reply(act === 'pl' ? '🤝 Anotado como préstamo (no cuenta como gasto).' : '🔁 Anotado como movimiento entre tus cuentas.');
      // ask_account
      case 'acc': await answer(); if (msgId) await this.botSvc.edit(msgId, '👌'); return this.botSvc.setTxBank(p.refId!, arg!);
    }
  }

  // ── summaries ───────────────────────────────────────────────────────────
  @Cron('0 21 * * *', { timeZone: TZ })
  async daily() {
    await this.db.chatTurn.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 864e5) } } });
    if (!this.botSvc.bot || !(await this.botSvc.setting('daily_summary', true))) return;
    try {
      const now = new Date();
      let text = await this.botSvc.summaryText(startOfDay(now), now, 'de hoy');
      const o = await this.insights.overview();
      if (o.toJustify) text += `\n\n💬 ${o.toJustify} por justificar`;
      if (o.pending) text += `\n📝 ${o.pending} borradores en /pendientes`;
      await this.botSvc.send(text);
    } catch (e) { this.log.error(e); }
  }

  @Cron('30 21 * * 0', { timeZone: TZ })
  async weekly() {
    if (!this.botSvc.bot) return;
    try {
      const now = new Date(), a = startOfWeek(now), prev = new Date(a.getTime() - 7 * 864e5);
      const [cmp, byMerchant] = await Promise.all([
        this.insights.comparePeriods({ from: a, to: now }, { from: prev, to: a }, 'category'),
        this.insights.spendSummary({ from: a, to: now, groupBy: 'merchant' }),
      ]);
      const total = cmp.reduce((s, r) => s + r.a, 0), last = cmp.reduce((s, r) => s + r.b, 0);
      let text = `📅 <b>Tu semana: ${usd(total)}</b> (semana pasada ${usd(last)})`;
      try {
        const r = await this.llm.json<{ text: string }>(
          `Resumen semanal de gastos (USD) de Randy, en español venezolano neutro, cálido y breve (máx 6 líneas, sin markdown). Menciona el total vs. la semana pasada, las 3 categorías principales y anomalías (ej. "gastaste 2,3× más en delivery"). Datos por categoría (a=esta semana, b=pasada): ${JSON.stringify(cmp)}. Top comercios: ${JSON.stringify(byMerchant.slice(0, 5))}.`,
          '{"text":string}', this.llm.smart,
        );
        if (r?.text) text += `\n\n${esc(r.text)}`;
      } catch (e) {
        text += '\n' + cmp.sort((x, y) => y.a - x.a).slice(0, 5).map((r) => `• ${esc(r.label)}: ${usd(r.a)} (${r.delta >= 0 ? '+' : ''}${usd(r.delta)})`).join('\n');
      }
      await this.botSvc.send(text);
      const weekId = Math.floor(a.getTime() / 864e5); // days since epoch of the week's Monday
      await this.emb.upsertFor('summary', weekId, `Resumen semana del ${a.toISOString().slice(0, 10)}: ${text.replace(/<[^>]+>/g, '')}`);
    } catch (e) { this.log.error(e); }
  }
}

/** p2p_intro text + buttons. The bank is a guess from the ad's payMethodName, so the other bank is one tap away. */
function p2pIntro(pid: number, pl: Record<string, any>, k: InlineKeyboard) {
  const isBdv = /bdv/i.test(String(pl.account));
  const [bank, other, otherCode] = isBdv ? ['BDV', 'Mercantil', 'mercantil'] : ['Mercantil', 'BDV', 'bdv'];
  const text = `💱 Cambiaste ${money(Number(pl.usdt), 'USDT')} → ${money(Number(pl.ves), 'VES')} a <b>${bank}</b> (${Number(pl.rate).toLocaleString('es-VE')}). ¿Es para algo concreto?`;
  k.text('Gastos del día', cb('n', 'day', pid)).text('Pagar algo puntual…', cb('n', 'one', pid)).row()
    .text('Solo ahorro en Bs', cb('n', 'save', pid)).text(`Pasarlo a ${other}`, cb('n', 'move', pid)).row()
    .text(`🏦 No, llegó a ${other}`, cb('n', 'bank', pid, otherCode));
  return { text };
}
