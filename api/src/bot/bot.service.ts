import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { AskAnswer, shape } from '../ai/ask.service';
import { Tools } from '../ai/agent';
import { EmbeddingsService } from '../ai/embeddings.service';
import { caracasIso, normAccount, normCurrency, normalizeIntent, Parsed, parseAmount, parseLocalDate } from '../ai/intent';
import { IntentService } from '../ai/intent.service';
import { TranscribeService } from '../ai/transcribe.service';
import { bankTwin } from '../bdv/bdv.logic';
import type { Transaction } from '../generated/prisma/client';
import { BinanceService } from '../binance/binance.service';
import { PrismaService } from '../db/prisma.service';
import { AuthService } from '../http/auth.service';
import { InsightsService } from '../insights/insights.service';
import { CategoriesService } from '../ledger/categories.service';
import { BagsService } from '../ledger/bags.service';
import { DebtsService } from '../ledger/debts.service';
import { LedgerService, MISSING_ACCOUNT_WHERE, missingAccount, TxInput, TxView } from '../ledger/ledger.service';
import { currencyIn, monthKey, PlanService, sameMoney, type EntryView } from '../ledger/plan.service';
import { amt, cb, dayLabel, debtsText, esc, hhmm, money, paidText, parseWhen, planDueText, planText, startOfDay, startOfMonth, startOfWeek, txCard, usd } from './ui';

type Field = 'amount' | 'merchant' | 'note' | 'date';
export type Awaiting = { kind: Field | 'balance' | 'plan_amount'; txId?: number; accountId?: number; promptId?: number; entryId?: number; msgId?: number; at: number };
type Mode = 'view' | 'edit' | 'acc' | 'cat';

const COMMANDS = [
  ['saldo', 'Saldos de tus cuentas'], ['hoy', 'Gastos de hoy'], ['semana', 'Gastos de la semana'], ['mes', 'Gastos del mes'],
  ['plan', 'Plan del mes: pagos y presupuestos'], ['ultimos', 'Últimos movimientos'], ['deudas', 'Lo que debes'], ['deshacer', 'Deshacer el último cambio'], ['pendientes', 'Borradores por confirmar'],
  ['conciliar', 'Cuadrar un banco o efectivo'], ['panel', 'Abrir el panel'], ['sync', 'Sincronizar Binance'],
  ['backfill', 'Importar historial de Binance'], ['ajustes', 'Ajustes'],
] as const;
const FIELD_ASK: Record<Field, string> = {
  amount: '💵 Escribe el monto nuevo (ej. 350 o 1.200,50)',
  merchant: '🏪 ¿Dónde fue?',
  note: '📝 Escribe la nota',
  date: '📅 ¿Cuándo fue? (ej. «ayer 8pm», «20/09 13:00»)',
};

@Injectable()
export class BotService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private log = new Logger('Bot');
  readonly bot = process.env.TG_TOKEN ? new Bot(process.env.TG_TOKEN) : null;
  readonly chatId = Number(process.env.TG_ALLOWED_ID);
  /** Single user => one pending free-text answer at a time. */
  awaiting: Awaiting | null = null;
  private publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');

  constructor(
    private db: PrismaService,
    private ledger: LedgerService,
    private cats: CategoriesService,
    private bags: BagsService,
    private insights: InsightsService,
    private auth: AuthService,
    private binance: BinanceService,
    private intent: IntentService,
    private emb: EmbeddingsService,
    private transcriber: TranscribeService,
    private debts: DebtsService,
    private plan: PlanService,
  ) {
    // Allowlist first, in the constructor, so it precedes every handler (NudgesService registers its own).
    this.bot?.use(async (ctx, next) => { if (ctx.from?.id === this.chatId) await next(); });
  }

  onModuleInit() {
    const bot = this.bot;
    if (!bot) return;
    const safe = (fn: () => Promise<unknown>) => fn().catch(async (e) => {
      this.log.error(e);
      await this.send('Uy, algo falló 😅 Intenta de nuevo en un momento.').catch(() => {});
    });
    bot.command('start', () => safe(() => this.send('¡Hola! 👋 Cuéntame tus gastos como me los dirías a mí: «gasté 350 en pan por Mercantil». También puedes mandarme notas de voz o fotos de facturas.')));
    for (const [name, fn] of Object.entries(this.views)) bot.command(name, () => safe(fn));
    bot.command('deuda', () => safe(this.views.deudas));
    bot.command('deshacer', () => safe(() => this.undo(null)));
    bot.command('sync', () => safe(() => this.sync()));
    bot.command('backfill', () => safe(async () => {
      await this.send('⏳ Importando historial de Binance, esto tarda un rato…');
      const r = await this.binance.backfill();
      await this.send(`✅ Importé ${r.p2p} órdenes P2P y ${r.pay} pagos. Lo dudoso quedó en /pendientes.`);
    }));
    bot.command('ajustes', () => safe(() => this.ajustes()));

    bot.callbackQuery(/^t:/, (ctx) => safe(async () => {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, act, id, arg] = ctx.callbackQuery.data.split(':');
      await this.onTxButton(act, Number(id), arg, ctx.callbackQuery.message?.message_id);
    }));
    bot.callbackQuery(/^pl:/, (ctx) => safe(async () => {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, act, id, arg] = ctx.callbackQuery.data.split(':');
      await this.onPlanButton(act, Number(id), arg, ctx.callbackQuery.message?.message_id);
    }));
    bot.callbackQuery(/^p:/, (ctx) => safe(async () => {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, act, y] = ctx.callbackQuery.data.split(':');
      const msgId = ctx.callbackQuery.message?.message_id;
      if (act === 'no') return msgId && this.edit(msgId, '👌 Ok, no toqué nada.');
      return this.bulkPending(act as 'ok' | 'void', y === 'y', msgId);
    }));
    bot.callbackQuery(/^[rs]:/, (ctx) => safe(async () => {
      await ctx.answerCallbackQuery().catch(() => {});
      const [k, a, b] = ctx.callbackQuery.data.split(':');
      const msgId = ctx.callbackQuery.message?.message_id;
      if (k === 's') return this.toggleSetting(a, msgId);
      if (a === 'no') return msgId && this.edit(msgId, '👌 Ok, no lo toco.');
      if (b) return this.reconcile(Number(a), Number(b));
      const acc = (await this.ledger.balances()).find((x) => x.accountId === Number(a));
      this.awaiting = { kind: 'balance', accountId: Number(a), at: Date.now() };
      await this.send(`¿Cuánto tiene <b>${esc(acc?.name ?? 'la cuenta')}</b> ahorita? Escribe el monto.`);
    }));

    bot.on('message:voice', (ctx) => safe(async () => {
      const buf = await this.download(ctx.message.voice.file_id);
      let text: string;
      try { text = await this.transcriber.transcribe(buf, 'ogg'); }
      catch (e) {
        return this.send(/no está configurada/.test((e as Error).message) ? `🎙️ No pude transcribir 😅\n<code>${esc((e as Error).message)}</code>` : '🎙️ No pude entender el audio 😅 ¿Me lo escribes?');
      }
      if (!text) return this.send('🎙️ No escuché nada 🤔');
      await this.send(`🎙️ <i>«${esc(text)}»</i>`);
      await this.handleText(text, 'manual_voice');
    }));
    bot.on('message:photo', (ctx) => safe(() => this.photo(ctx.message.photo.at(-1)!.file_id)));
    bot.on('message:text', (ctx) => safe(() =>
      ctx.message.text.startsWith('/') ? this.send('No conozco ese comando 🤔 Escribe / para ver la lista.') : this.handleText(ctx.message.text, 'manual_text')));
    bot.catch((e) => this.log.error(e.error));
  }

  async onApplicationBootstrap() {
    if (!this.bot) return this.log.warn('TG_TOKEN no configurado: bot desactivado');
    try {
      await this.bot.init();
      await this.bot.api.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description })));
      if (process.env.TG_POLLING === '1') {
        await this.bot.api.deleteWebhook();
        void this.bot.start({ allowed_updates: ['message', 'callback_query'] });
        this.log.log('long polling');
      } else if (!process.env.TG_WEBHOOK_SECRET || !this.publicUrl) {
        this.log.error('Falta TG_WEBHOOK_SECRET o PUBLIC_URL: webhook no configurado');
      } else {
        await this.bot.api.setWebhook(`${this.publicUrl}/api/telegram`, { secret_token: process.env.TG_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
        this.log.log(`webhook ${this.publicUrl}/api/telegram`);
      }
    } catch (e) {
      this.log.error(`no pude iniciar el bot: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy() { if (this.bot?.isRunning()) await this.bot.stop(); }

  // ── plumbing ────────────────────────────────────────────────────────────
  async send(html: string, kb?: InlineKeyboard, txIds: number[] = []) {
    const m = await this.bot!.api.sendMessage(this.chatId, html, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
    await this.turn('bot', html, txIds);
    return m;
  }
  async edit(msgId: number, html: string, kb?: InlineKeyboard) {
    await this.bot!.api.editMessageText(this.chatId, msgId, html, { parse_mode: 'HTML', reply_markup: kb })
      .catch((e) => { if (!/not modified/.test(e.message)) throw e; });
  }
  async turn(role: 'user' | 'bot', text: string, txIds: number[] = []) {
    await this.db.chatTurn.create({ data: { role, text: text.replace(/<[^>]+>/g, '').slice(0, 1000), txIds } });
  }
  private async download(fileId: string): Promise<Buffer> {
    const f = await this.bot!.api.getFile(fileId);
    const r = await fetch(`https://api.telegram.org/file/bot${process.env.TG_TOKEN}/${f.file_path}`);
    if (!r.ok) throw new Error(`telegram file ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  embedTx(tx: TxView, catPath?: string | null) {
    const content = [
      tx.type === 'income' ? 'ingreso' : 'gasto', tx.merchant, catPath ?? tx.category?.name, money(Number(tx.amount), tx.currency),
      tx.fromAccount?.name ?? tx.toAccount?.name, tx.note, caracasIso(tx.occurredAt).replace('T', ' '),
    ].filter(Boolean).join(' · ');
    this.emb.upsertFor('transaction', tx.id, content).catch((e) => this.log.warn(`embed: ${e.message}`));
  }

  // ── tx cards ────────────────────────────────────────────────────────────
  /** Renders a tx card; edits `msgId` in place if given, else sends a new message. */
  async showTx(id: number, o: { msgId?: number; mode?: Mode; parent?: number; prefix?: string } = {}) {
    const tx = await this.ledger.get(id);
    if (!tx) return;
    const cats = await this.cats.list();
    const text = (o.prefix ? `${o.prefix}\n\n` : '') + txCard(tx, cats.find((c) => c.id === tx.categoryId)?.path);
    const kb = await this.txKeyboard(tx, cats, o.mode, o.parent);
    if (o.msgId) await this.edit(o.msgId, text, kb);
    else await this.send(text, kb, [tx.id]);
  }

  private async txKeyboard(tx: TxView, cats: { id: number; name: string; parentId: number | null; emoji: string | null }[], mode?: Mode, parent?: number) {
    if (tx.status === 'void') return undefined;
    const k = new InlineKeyboard();
    const hasAcc = !!(tx.type === 'income' ? tx.toAccountId : tx.fromAccountId ?? tx.toAccountId);
    const needsCat = !tx.categoryId && (tx.type === 'expense' || tx.type === 'fee');
    mode ??= tx.status === 'pending' ? (!hasAcc ? 'acc' : needsCat ? 'cat' : 'view') : 'view';
    const back = () => k.row().text('↩️ Volver', cb('t', 'v', tx.id)).text('❌ Cancelar', cb('t', 'no', tx.id));
    if (mode === 'acc') {
      (await this.ledger.balances()).forEach((a, i) => { k.text(a.name, cb('t', 'ac', tx.id, a.accountId)); if (i % 3 === 2) k.row(); });
      return back();
    }
    if (mode === 'cat') {
      const list = parent ? cats.filter((c) => c.parentId === parent) : cats.filter((c) => !c.parentId);
      if (parent) k.text(`${cats.find((c) => c.id === parent)?.name ?? ''} (general)`, cb('t', 'ct', tx.id, parent)).row();
      list.forEach((c, i) => {
        const hasKids = !parent && cats.some((x) => x.parentId === c.id);
        k.text(`${c.emoji ?? ''} ${c.name}`.trim(), cb('t', hasKids ? 'cp' : 'ct', tx.id, c.id));
        if (i % 3 === 2) k.row();
      });
      if (parent) k.row().text('⬅️ Categorías', cb('t', 'cts', tx.id));
      else if (tx.status === 'pending' && hasAcc) k.row().text('🚫 Solo registro', cb('t', 'xo', tx.id));
      return back();
    }
    if (mode === 'edit')
      return k.text('💵 Monto', cb('t', 'f', tx.id, 'amount')).text('🏪 Comercio', cb('t', 'f', tx.id, 'merchant')).text('📅 Fecha', cb('t', 'f', tx.id, 'date')).row()
        .text('📝 Nota', cb('t', 'f', tx.id, 'note')).text('🏦 Cuenta', cb('t', 'acs', tx.id)).text('🏷️ Categoría', cb('t', 'cts', tx.id)).row()
        .text(tx.excluded ? '🧾 Contar como gasto' : '🚫 Solo registro', cb('t', 'xc', tx.id)).row()
        .text('🗑️ Anular', cb('t', 'no', tx.id)).text('↩️ Volver', cb('t', 'v', tx.id));
    if (tx.status === 'confirmed') return k.text('↩️ Deshacer', cb('t', 'un', tx.id)).text('✏️ Editar', cb('t', 'ed', tx.id));
    // no account = nothing to confirm yet: the first button picks it
    k.text(hasAcc ? '✅ Ok' : '🏦 Elegir cuenta', cb('t', hasAcc ? 'ok' : 'acs', tx.id)).text('✏️ Editar', cb('t', 'ed', tx.id));
    if (hasAcc && !tx.excluded) k.text('🚫 Solo registro', cb('t', 'xo', tx.id));
    return k.row().text('🏦 Cuenta', cb('t', 'acs', tx.id)).text('🏷️ Categoría', cb('t', 'cts', tx.id)).text('❌ Cancelar', cb('t', 'no', tx.id));
  }

  private async onTxButton(act: string, id: number, arg: string | undefined, msgId?: number) {
    const n = Number(arg);
    switch (act) {
      case 'ok': {
        const tx = await this.ledger.get(id);
        if (tx && missingAccount(tx)) return this.showTx(id, { msgId, mode: 'acc', prefix: '🏦 Antes de confirmar, ¿de qué cuenta salió?' });
        await this.ledger.confirm(id); await this.showTx(id, { msgId }); return this.afterConfirm(id);
      }
      case 'no': await this.ledger.void(id); return this.showTx(id, { msgId });
      case 'ed': return this.showTx(id, { msgId, mode: 'edit' });
      case 'v': return this.showTx(id, { msgId, mode: 'view' });
      case 'acs': return this.showTx(id, { msgId, mode: 'acc' });
      case 'cts': return this.showTx(id, { msgId, mode: 'cat' });
      case 'cp': return this.showTx(id, { msgId, mode: 'cat', parent: n });
      case 'o': return this.showTx(id, { mode: 'edit' }); // from /ultimos: open card as a new message
      case 'x': await this.ledger.void(id); return this.send(`🗑️ Anulado #${id}`);
      case 'xc': { // toggle "solo registro"
        const tx = await this.ledger.get(id);
        if (!tx) return;
        await this.ledger.update(id, { excluded: !tx.excluded });
        return this.showTx(id, { msgId, mode: 'edit' });
      }
      case 'xo': // pending card: "solo registro" and done (moves the balance, never counts as spending)
        await this.ledger.update(id, { excluded: true });
        await this.ledger.confirm(id); await this.showTx(id, { msgId }); return this.afterConfirm(id);
      case 'dup': { // hand-logged `id` is the bank's `n`: keep the bank tx (real amount/time), give it what Randy said
        const [mine, bank] = await Promise.all([this.ledger.get(id), this.ledger.get(n)]);
        if (!mine || !bank || mine.status === 'void' || bank.status === 'void') return;
        const keep = <T,>(v: T | null) => v ?? undefined;
        await this.ledger.update(bank.id, {
          categoryId: keep(mine.categoryId), merchant: keep(mine.merchant), note: keep(mine.note ?? bank.note), debtId: keep(mine.debtId),
          planEntryId: keep(mine.planEntryId), ...(mine.excluded && { excluded: true }),
        });
        await this.ledger.void(mine.id);
        if (msgId) await this.edit(msgId, '🔗 Listo, lo uní con el de BDV (quedó el monto del banco).');
        const done = mine.categoryId != null || bank.type === 'income';
        if (done) await this.ledger.confirm(bank.id);
        await this.showTx(bank.id);
        if (done) await this.afterConfirm(bank.id);
        return;
      }
      case 'ndup': if (msgId) await this.edit(msgId, '👌 Ok, son distintos: quedan los dos.'); return;
      case 'un': {
        const tx = await this.ledger.undoLast(id);
        return tx ? this.showTx(id, { msgId }) : this.send('No hay nada que deshacer ahí 🙂');
      }
      case 'ac': {
        const tx = await this.ledger.get(id);
        const acc = (await this.ledger.balances()).find((a) => a.accountId === n);
        if (!tx || !acc) return;
        const patch: Partial<TxInput> = tx.type === 'income' ? { toAccountId: n } : { fromAccountId: n };
        if (tx.status === 'pending' && tx.currency !== acc.currency) patch.currency = acc.currency; // an expense is in its account's currency
        await this.ledger.update(id, patch);
        return this.showTx(id, { msgId });
      }
      case 'ct': {
        const tx = await this.ledger.update(id, { categoryId: n }); // ledger learns the merchant rule
        await this.showTx(id, { msgId });
        const v = await this.ledger.get(tx.id);
        if (v && v.status === 'confirmed') this.embedTx(v);
        return;
      }
      case 'f':
        this.awaiting = { kind: arg as Field, txId: id, msgId, at: Date.now() };
        return this.send(FIELD_ASK[arg as Field] ?? '¿Qué valor?');
    }
  }

  /** After a tx is confirmed: embed it for semantic search. */
  async afterConfirm(id: number) {
    const tx = await this.ledger.get(id);
    if (!tx) return;
    this.embedTx(tx, (await this.cats.list()).find((c) => c.id === tx.categoryId)?.path);
  }

  /** Screens shared by /commands and the agent's `show` tool. */
  private views: Record<string, () => Promise<unknown>> = {
    saldo: () => this.saldo(),
    hoy: () => this.summary(startOfDay(new Date()), 'hoy'),
    semana: () => this.summary(startOfWeek(new Date()), 'esta semana'),
    mes: () => this.summary(startOfMonth(new Date()), 'este mes'),
    ultimos: () => this.ultimos(),
    pendientes: () => this.pendientes(),
    deudas: async () => this.send(debtsText(await this.debts.list())),
    plan: () => this.planView(),
    conciliar: () => this.conciliar(),
    panel: () => this.panel(),
  };

  private async sync() {
    await this.send('🔄 Sincronizando…');
    await this.binance.syncNow();
    await this.syncStatus();
  }

  // ── free text: agent loop ───────────────────────────────────────────────
  async handleText(text: string, source: string) {
    await this.turn('user', text);
    const a = this.awaiting;
    this.awaiting = null;
    if (a && Date.now() - a.at < 15 * 60e3 && (await this.fill(a, text))) return;
    await this.bot!.api.sendChatAction(this.chatId, 'typing').catch(() => {});
    let r: Awaited<ReturnType<IntentService['agent']>>;
    try { r = await this.intent.agent(text, this.actions(source)); }
    catch (e) {
      this.log.error(`agent: ${(e as Error).message}`);
      return this.send('Uy, no pude procesar eso ahorita 😅 Intenta de nuevo en un momento.');
    }
    if (typeof r.reply === 'string' && r.reply.trim()) return this.send(answerHtml(shape(r)));
    if (!r.ran.length) return this.send('Aquí estoy 🙂 Cuéntame un gasto o pregúntame algo.');
  }

  /** The agent's action tools: thin wrappers over the same handlers the buttons/commands use. */
  private actions(source: string): Tools {
    const parse = async (raw: object) => normalizeIntent(raw, { now: new Date(), accounts: await this.ledger.balances() });
    const ok = (p: Promise<unknown>) => p.then(() => 'ok');
    return {
      add_transactions: async (a) => this.addItems(await parse({ intent: 'add_expense', items: a.items, confidence: a.confidence }), source),
      add_transfer: (a) => this.addTransfer(a, source),
      add_debt: (a) => this.addDebt(a),
      edit_transaction: async (a) => ok(this.editTx(await parse({ intent: 'edit', target_tx_id: a.id, patch: a }))),
      void_transaction: (a) => ok(this.remove(Number(a.id) || null)),
      undo: (a) => ok(this.undo(Number(a.id) || null)),
      set_balance: async (a) => ok(this.setBalance((await parse({ balance: a })).balance, false)),
      answer_prompt: async (a) => ok(this.answerPrompt(await parse({
        intent: 'answer_prompt', items: [a], balance: a.amount != null ? { account: a.account, amount: a.amount } : null, confidence: 0.8,
      }), source)),
      pay_plan: async (a) => {
        const accs = await this.ledger.balances();
        const code = a.account ? normAccount(a.account, accs.map((x) => x.code), normCurrency(a.currency)) : null;
        return this.payPlan(Number(a.entry_id), {
          amount: parseAmount(a.amount) ?? undefined, currency: normCurrency(a.currency),
          accountId: accs.find((x) => x.code === code)?.accountId, occurredAt: a.occurred_at ? parseLocalDate(a.occurred_at, new Date()) : undefined,
        }, undefined, source);
      },
      plan_set: (a) => this.setPlanItem(a),
      plan_month: async (a) => {
        const id = Number(a.entry_id), amount = parseAmount(a.amount);
        await this.plan.updateEntry(id, { ...(amount != null && { planned: amount }), ...(typeof a.skip === 'boolean' && { skipped: a.skip }) });
        const v = await this.plan.entry(id);
        await this.send(v.skipped ? `⏭️ <b>${esc(v.name)}</b>: este mes no.` : `📅 <b>${esc(v.name)}</b> este mes: ${amt(v.planned, v.currency)}.`);
        return { id, name: v.name, planned: v.planned, skipped: v.skipped };
      },
      plan_remove: async (a) => {
        const it = await this.plan.findItem(String(a.name ?? ''));
        if (!it) throw new Error(`no hay línea «${a.name}» en el plan`);
        await this.plan.removeItem(it.id);
        await this.send(`🗑️ Saqué <b>${esc(it.name)}</b> del plan (los meses pasados quedan).`);
        return { removed: it.name };
      },
      sync_binance: () => ok(this.sync()),
      show: async (a) => {
        const v = this.views[String(a.view)];
        if (!v) throw new Error(`vista desconocida: ${a.view}; usa ${Object.keys(this.views).join('|')}`);
        await v();
        return 'mostrado al usuario';
      },
    };
  }

  /** Consumes a typed answer to a button ("escribe el monto…"). false => not an answer, run the normal pipeline. */
  private async fill(a: Awaiting, text: string): Promise<boolean> {
    const t = text.trim();
    if (a.kind === 'balance') {
      const n = parseAmount(t);
      if (n == null) return false;
      await this.reconcile(a.accountId!, n, a.promptId);
      return true;
    }
    if (a.kind === 'plan_amount') {
      const n = parseAmount(t);
      if (n == null) return false;
      await this.payPlan(a.entryId!, { amount: n, currency: currencyIn(t) }, a.msgId);
      return true;
    }
    const id = a.txId!;
    const patch: Partial<TxInput> = {};
    if (a.kind === 'amount') { const n = parseAmount(t); if (n == null) return false; patch.amount = n; }
    if (a.kind === 'date') { const d = parseWhen(t, new Date()); if (!d) return false; patch.occurredAt = d; }
    if (a.kind === 'note') patch.note = t;
    if (a.kind === 'merchant') {
      patch.merchant = t;
      const [rule, tx] = await Promise.all([this.cats.ruleFor(t), this.ledger.get(id)]);
      if (rule && !tx?.categoryId) patch.categoryId = rule.categoryId;
    }
    await this.ledger.update(id, patch);
    await this.showTx(id, { msgId: a.msgId });
    const tx = await this.ledger.get(id);
    if (tx?.status === 'confirmed') this.embedTx(tx);
    return true;
  }

  /** Returns what was created (fed back to the agent). */
  async addItems(p: Parsed, source: string) {
    const items = await this.intent.resolve(p.items);
    if (!items.length) throw new Error('sin items');
    const out: object[] = [];
    for (const it of items) {
      const type = it.type ?? (p.intent === 'add_income' ? 'income' : 'expense');
      if (it.amount == null) { await this.send(`¿Cuánto fue${it.merchant ? ` en ${esc(it.merchant)}` : ''}?`); out.push({ merchant: it.merchant, error: 'falta monto, ya se lo pregunté' }); continue; }
      const tx = await this.ledger.create({
        type, status: 'pending', occurredAt: it.occurredAt, amount: it.amount, currency: it.currency ?? 'VES',
        ...(type === 'income' ? { toAccountId: it.accountId ?? undefined } : { fromAccountId: it.accountId ?? undefined }),
        categoryId: it.categoryId ?? undefined, merchant: it.merchant ?? undefined, note: it.note ?? undefined,
        debtId: it.debtId ?? undefined, planEntryId: it.planEntryId ?? undefined, excluded: it.excluded, source, confidence: p.confidence,
      });
      const twin = await this.bankTwin(tx);
      const auto = !twin && p.confidence > 0.9 && it.hasRule && it.accountId != null && (it.categoryId != null || type === 'income');
      if (auto) await this.ledger.confirm(tx.id);
      await this.showTx(tx.id);
      if (auto) await this.afterConfirm(tx.id);
      if (twin) await this.send(`🔎 ¿Es el mismo que ya llegó de BDV: ${money(twin.amount, 'VES')} ${dayLabel(twin.at, new Date())} a las ${hhmm(twin.at)}?`,
        new InlineKeyboard().text('🔗 Sí, es ese', cb('t', 'dup', tx.id, twin.id)).text('No, es otro', cb('t', 'ndup', tx.id)));
      const debt = it.debtId ? await this.debts.get(it.debtId) : null;
      const plan = it.planEntryId ? await this.plan.entry(it.planEntryId) : null;
      out.push({
        ...(plan && { plan: { name: plan.name, planned: plan.planned, paid: +plan.spent.toFixed(2), currency: plan.currency, status: plan.status } }),
        id: tx.id, type, status: auto ? 'confirmed' : 'pending', amount: it.amount, currency: it.currency, account: it.account, category: it.categoryPath,
        ...(debt && { debt: { id: debt.id, name: debt.name, remaining: `${+debt.remaining.toFixed(2)} ${debt.currency}` } }),
      });
    }
    return out;
  }

  /** The bank-made (bdv sync) tx this hand-logged BDV movement probably duplicates, if any. */
  private async bankTwin(tx: Transaction) {
    const inflow = tx.type === 'income';
    const bdv = await this.db.account.findUnique({ where: { code: 'bdv' } });
    if (!bdv || tx.currency !== 'VES' || (inflow ? tx.toAccountId : tx.fromAccountId) !== bdv.id) return undefined;
    const rows = await this.db.transaction.findMany({
      where: {
        source: 'bdv', status: { not: 'void' }, type: inflow ? 'income' : 'expense', [inflow ? 'toAccountId' : 'fromAccountId']: bdv.id,
        NOT: { note: { startsWith: 'Movimientos menores' } }, // grouped small rows are never one hand-logged movement
        occurredAt: { gte: new Date(+tx.occurredAt - 36 * 3_600_000), lte: new Date(+tx.occurredAt + 36 * 3_600_000) },
      },
    });
    return bankTwin(Number(tx.amount), tx.occurredAt, rows.map((r) => ({ id: r.id, amount: Number(r.amount), at: r.occurredAt })));
  }

  /** Own-account move; different currencies = an exchange (amount out, toAmount in), priced by what landed. */
  async addTransfer(a: any, source: string) {
    const accs = await this.ledger.balances();
    const codes = accs.map((x) => x.code);
    const find = (v: unknown) => accs.find((x) => x.code === normAccount(v, codes, null));
    const from = find(a.from), to = find(a.to);
    if (!from || !to || from.accountId === to.accountId) throw new Error(`cuentas inválidas: from/to deben ser dos de ${codes.join(', ')}`);
    const amount = parseAmount(a.amount), cross = from.currency !== to.currency;
    const toAmount = cross ? parseAmount(a.to_amount) : null;
    if (amount == null) throw new Error(`falta amount (${from.currency} que salieron de ${from.code}): pregúntalo`);
    if (cross && toAmount == null) throw new Error(`falta to_amount (${to.currency} que llegaron a ${to.code}): pregúntalo`);
    const tx = await this.ledger.create({
      type: 'transfer', status: 'confirmed', occurredAt: parseLocalDate(a.occurred_at, new Date()), amount, currency: from.currency,
      fromAccountId: from.accountId, toAccountId: to.accountId, ...(toAmount != null && { toAmount }),
      note: typeof a.note === 'string' && a.note.trim() ? a.note.trim() : undefined, source,
    });
    await this.showTx(tx.id);
    return { id: tx.id, from: from.code, to: to.code, amount, toAmount };
  }

  async addDebt(a: any) {
    const name = typeof a.name === 'string' ? a.name.trim() : '', amount = parseAmount(a.amount), currency = normCurrency(a.currency);
    if (!name || amount == null || !currency) throw new Error('faltan name, amount o currency (VES|USD|USDT): pregúntalo');
    const d = await this.debts.create({ name, amount, currency, note: typeof a.note === 'string' && a.note.trim() ? a.note.trim() : undefined });
    await this.send(`💳 Deuda anotada: <b>${esc(name)}</b> · ${money(amount, currency)}`);
    return { id: d.id, name, amount, currency };
  }

  private async resolveTarget(id: number | null) {
    return id ?? (await this.ledger.recent(1))[0]?.id ?? null;
  }

  private async editTx(p: Parsed) {
    const id = await this.resolveTarget(p.targetTxId);
    if (!id) return this.send('No encontré qué cambiar 🤔');
    const q = p.patch ?? {};
    if (!Object.keys(q).length) return this.showTx(id, { mode: 'edit', prefix: '¿Qué le cambio?' });
    const tx = await this.ledger.get(id);
    if (!tx) return this.send('No encontré ese movimiento 🤔');
    const patch: Partial<TxInput> = {};
    if (q.amount != null) patch.amount = q.amount;
    if (q.currency) patch.currency = q.currency;
    if (q.merchant) patch.merchant = q.merchant;
    if (q.note) patch.note = q.note;
    if (q.debtId && (await this.debts.get(q.debtId))) patch.debtId = q.debtId;
    if (q.excluded !== undefined) patch.excluded = q.excluded;
    if (q.occurredAt) patch.occurredAt = q.occurredAt;
    let moved = false;
    if (q.account) {
      const acc = await this.ledger.accountByCode(q.account).catch(() => null);
      const bag = acc && tx.type === 'transfer' ? await this.db.bag.findUnique({ where: { p2pTransactionId: id } }) : null;
      if (bag) { // P2P SELL to the wrong bank: move tx + bag together
        moved = await this.bags.move(bag.id, acc!.id);
      } else if (acc) {
        // transfer: replace the bank side, never the Binance side
        const toSide = tx.type === 'income' || (tx.type === 'transfer' && tx.fromAccount?.code === 'binance');
        if (toSide) patch.toAccountId = acc.id; else patch.fromAccountId = acc.id;
        if (!q.currency && tx.currency !== acc.currency && !(tx.type === 'transfer' && toSide)) patch.currency = acc.currency; // amount is the from side
      }
    }
    if (q.category) {
      const c = await this.cats.byPath(q.category);
      if (c) patch.categoryId = c.id;
    }
    if (!Object.keys(patch).length && moved) return this.showTx(id, { prefix: '✏️ Listo, lo moví de banco:' });
    if (!Object.keys(patch).length) return this.showTx(id, { mode: 'edit', prefix: 'No entendí el cambio, ¿cuál campo?' });
    await this.ledger.update(id, patch);
    await this.showTx(id, { prefix: '✏️ Listo, lo cambié:' });
    const v = await this.ledger.get(id);
    if (v?.status === 'confirmed') this.embedTx(v);
  }

  async undo(id: number | null) {
    const tx = await this.ledger.undoLast(id ?? undefined);
    if (!tx) return this.send('No hay nada que deshacer 🙂');
    return this.showTx(tx.id, { prefix: '↩️ Deshecho:' });
  }

  private async remove(id: number | null) {
    const target = id; // never guess on delete
    if (!target) return this.send('¿Cuál borro? 🤔 Míralo en /ultimos y dale 🗑️.');
    await this.ledger.void(target);
    return this.showTx(target, { prefix: '🗑️ Anulado (con /deshacer lo recuperas):' });
  }

  /** confirm=true (photos) asks before reconciling; typed "mercantil tiene 8400" reconciles directly. */
  async setBalance(b: Parsed['balance'], confirm: boolean) {
    if (!b) return this.send('¿Cuánto tiene y en qué cuenta? 🙂');
    const accs = await this.ledger.balances();
    const acc = accs.find((a) => a.code === b.account);
    if (!acc) {
      const k = new InlineKeyboard();
      accs.filter((a) => a.kind === 'ledger').forEach((a) => k.text(a.name, cb('r', a.accountId, b.amount)));
      return this.send(`¿De qué cuenta son esos ${b.amount.toLocaleString('es-VE')}?`, k);
    }
    if (!confirm) return this.reconcile(acc.accountId, b.amount);
    return this.send(`🏦 Veo ${money(b.amount, acc.currency)} en <b>${esc(acc.name)}</b> (yo tenía ~${money(Math.round(acc.balance * 100) / 100, acc.currency)}). ¿Concilio?`,
      new InlineKeyboard().text('✅ Sí, conciliar', cb('r', acc.accountId, b.amount)).text('No', cb('r', 'no')));
  }

  async reconcile(accountId: number, actual: number, promptId?: number) {
    const { diff, tx } = await this.ledger.reconcile(accountId, actual);
    if (promptId) await this.db.pendingPrompt.update({ where: { id: promptId }, data: { answeredAt: new Date() } });
    const acc = (await this.ledger.balances()).find((a) => a.accountId === accountId);
    const cur = acc?.currency ?? 'VES';
    if (Math.abs(diff) < 0.01) return this.send(`✅ ${esc(acc?.name ?? '')} cuadra perfecto.`);
    if (tx) return this.showTx(tx.id, { mode: 'cat', prefix: `Faltan ${money(-diff, cur)} en ${esc(acc?.name ?? '')}: lo dejé como gasto. ¿En qué fue?` });
    return this.send(`👌 Ajusté ${esc(acc?.name ?? '')}: hay ${money(diff, cur)} más de lo que tenía anotado.`);
  }

  private async answerPrompt(p: Parsed, source: string) {
    const pending = await this.db.pendingPrompt.findFirst({
      where: { sentAt: { gte: new Date(Date.now() - 24 * 3600e3) }, answeredAt: null, cancelledAt: null },
      orderBy: { sentAt: 'desc' },
    });
    const done = () => pending && this.db.pendingPrompt.update({ where: { id: pending.id }, data: { answeredAt: new Date() } });
    const amount = p.balance?.amount ?? p.items[0]?.amount ?? null;
    if (pending?.kind === 'reconcile' && pending.refId && amount != null) return this.reconcile(pending.refId, amount, pending.id);
    if (pending?.kind === 'card_delta' && pending.refId && p.items[0]?.merchant) {
      const [it] = await this.intent.resolve(p.items.slice(0, 1));
      await this.ledger.update(pending.refId, { merchant: it.merchant!, ...(it.categoryId ? { categoryId: it.categoryId } : {}) });
      if (it.categoryId) await this.ledger.confirm(pending.refId);
      await done();
      await this.showTx(pending.refId);
      if (it.categoryId) await this.afterConfirm(pending.refId);
      return;
    }
    if (pending?.kind === 'plan_due' && pending.refId && amount != null) {
      return this.payPlan(pending.refId, { amount, currency: p.items[0]?.currency ?? null }, undefined, source);
    }
    if (pending?.kind === 'ask_account' && pending.refId) {
      const code = normAccount(p.items[0]?.account ?? p.balance?.account ?? '', ['mercantil', 'bdv'], 'VES');
      if (code) { await done(); return this.setTxBank(pending.refId, code); }
    }
    if (p.items.some((i) => i.amount != null)) {
      await done();
      return this.addItems({ ...p, intent: 'add_expense' }, source);
    }
    throw new Error('esto no responde al prompt pendiente; usa otra acción o pregúntale');
  }

  /** ask_account: the P2P tx whose payMethodName didn't map to a bank. Fill whichever side is the bank. */
  async setTxBank(txId: number, code: string) {
    const [tx, acc] = await Promise.all([this.ledger.get(txId), this.ledger.accountByCode(code)]);
    if (!tx) return;
    const patch: Partial<TxInput> = !tx.toAccountId ? { toAccountId: acc.id } : !tx.fromAccountId ? { fromAccountId: acc.id }
      : tx.fromAccount?.code.startsWith('binance') ? { toAccountId: acc.id } : { fromAccountId: acc.id };
    await this.ledger.update(txId, patch);
    const updated = await this.ledger.confirm(txId);
    // P2P SELL (USDT -> VES bank): now that the bank is known, open its bag
    if (patch.toAccountId && acc.currency === 'VES' && tx.toAmount && Number(tx.amount) > 0) {
      await this.bags.open(updated, acc.id, Number(tx.toAmount), Number(tx.toAmount) / Number(tx.amount));
    }
    return this.send(`👌 Anotado en ${esc(acc.name)}.`);
  }

  private async photo(fileId: string) {
    await this.bot!.api.sendChatAction(this.chatId, 'typing').catch(() => {});
    const p = await this.intent.photo((await this.download(fileId)).toString('base64'), 'image/jpeg');
    if (p.kind === 'receipt' && p.items.length) return this.addItems(p, 'manual_photo');
    if (p.kind === 'balance' && p.balance) return this.setBalance(p.balance, true);
    return this.send('📷 No vi una factura ni un saldo en esa foto 🤔');
  }

  // ── plan del mes ────────────────────────────────────────────────────────
  private async planView() {
    const m = await this.plan.month(monthKey(new Date()));
    const k = new InlineKeyboard();
    // one-tap "ya pagué" for the unpaid bills that are due soonest
    const open = m.entries.filter((v) => v.kind === 'bill' && (v.status === 'pending' || v.status === 'partial'))
      .sort((a, b) => (a.dueFrom ?? '9999').localeCompare(b.dueFrom ?? '9999')).slice(0, 6);
    open.forEach((v, i) => { k.text(`✅ ${v.name}`.slice(0, 30), cb('pl', 'ok', v.id, 'g')); if (i % 2) k.row(); });
    return this.send(planText(m), open.length ? k : undefined);
  }

  /** Buttons of a single "¿ya pagaste?": pay the plan, type another amount, snooze, skip. */
  async planKeyboard(v: EntryView) {
    const acc = v.accountId ? await this.db.account.findUnique({ where: { id: v.accountId } }) : null;
    const exact = !acc || sameMoney(acc.currency, v.currency);
    const left = v.status === 'partial' ? v.planned - v.spent : v.planned;
    return new InlineKeyboard()
      .text(exact ? `✅ Pagué ${amt(left, v.currency)}` : '✅ Ya pagué', cb('pl', 'ok', v.id)).text('💵 Otro monto', cb('pl', 'amt', v.id)).row()
      .text('⏰ Mañana', cb('pl', 'tm', v.id)).text('⏭️ Este mes no', cb('pl', 'sk', v.id));
  }

  /**
   * Records the payment of a plan line and shows planned vs paid. When the usual account is in another currency
   * and no amount was given, asks for it (with today's-rate estimate). Returns a summary for the agent.
   */
  async payPlan(entryId: number, o: { amount?: number; currency?: string | null; accountId?: number; occurredAt?: Date }, msgId?: number, source = 'plan') {
    const before = await this.plan.entry(entryId);
    const r = await this.plan.pay(entryId, { ...o, source });
    await this.db.pendingPrompt.updateMany({ where: { kind: 'plan_due', refId: entryId, answeredAt: null }, data: { answeredAt: new Date() } });
    if ('need' in r && r.need) {
      this.awaiting = { kind: 'plan_amount', entryId, msgId, at: Date.now() };
      const est = r.need.estimate ? ` (a la tasa de hoy serían ~${money(Math.round(r.need.estimate * 100) / 100, r.need.currency)})` : '';
      await this.send(`💵 ¿Cuánto pagaste por <b>${esc(before.name)}</b> en ${r.need.currency === 'VES' ? 'Bs' : r.need.currency}?${est}`);
      return { asked: `monto en ${r.need.currency}` };
    }
    const v = await this.plan.entry(entryId);
    if (msgId) await this.edit(msgId, paidText(v));
    await this.showTx(r.tx!.id, msgId ? {} : { prefix: paidText(v) });
    if (r.tx!.status === 'confirmed') await this.afterConfirm(r.tx!.id);
    return { id: r.tx!.id, plan: v.name, planned: v.planned, paid: +v.spent.toFixed(2), diff: +v.diff.toFixed(2), currency: v.currency, status: v.status, txStatus: r.tx!.status };
  }

  private async onPlanButton(act: string, id: number, arg: string | undefined, msgId?: number) {
    const answered = () => this.db.pendingPrompt.updateMany({ where: { kind: 'plan_due', refId: id, answeredAt: null }, data: { answeredAt: new Date() } });
    switch (act) {
      case 'ok': return this.payPlan(id, {}, arg === 'g' ? undefined : msgId); // 'g' = from a list: keep that message's other buttons
      case 'amt': {
        const v = await this.plan.entry(id);
        this.awaiting = { kind: 'plan_amount', entryId: id, msgId, at: Date.now() };
        return this.send(`💵 ¿Cuánto pagaste por <b>${esc(v.name)}</b>? (ej. «${v.currency === 'VES' ? '12.500' : Math.round(v.planned + 5)}» o «11.500 bs»)`);
      }
      case 'tm': {
        await this.plan.snooze(id);
        await answered();
        const v = await this.plan.entry(id);
        return msgId && this.edit(msgId, `⏰ Te recuerdo <b>${esc(v.name)}</b> mañana.`);
      }
      case 'tma': { // grouped reminder: id = one of its prompts
        const p = await this.db.pendingPrompt.findUnique({ where: { id } });
        const group = p?.telegramMessageId ? await this.db.pendingPrompt.findMany({ where: { telegramMessageId: p.telegramMessageId, kind: 'plan_due' } }) : p ? [p] : [];
        for (const g of group) {
          const v = g.refId ? await this.plan.entry(g.refId).catch(() => null) : null;
          if (v && (v.status === 'pending' || v.status === 'partial')) await this.plan.snooze(v.id);
        }
        await this.db.pendingPrompt.updateMany({ where: { id: { in: group.map((g) => g.id) } }, data: { answeredAt: new Date() } });
        return msgId && this.edit(msgId, '⏰ Te recuerdo mañana los que falten.');
      }
      case 'sk': {
        await this.plan.updateEntry(id, { skipped: true });
        await answered();
        const v = await this.plan.entry(id);
        return msgId && this.edit(msgId, `⏭️ <b>${esc(v.name)}</b>: este mes no. No te lo recuerdo más.`);
      }
    }
  }

  /** Agent's plan_set: upsert a plan line by name. */
  private async setPlanItem(a: any) {
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    if (!name) throw new Error('falta name');
    const accs = await this.ledger.balances();
    const code = a.account ? normAccount(a.account, accs.map((x) => x.code), normCurrency(a.currency)) : null;
    const cat = a.category ? await this.cats.byPath(String(a.category)) : null;
    const day = (v: unknown) => (v === null ? null : v === undefined ? undefined : Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 31 ? Number(v) : undefined);
    const patch = {
      ...(parseAmount(a.amount) != null && { amount: parseAmount(a.amount)! }),
      ...(normCurrency(a.currency) && { currency: normCurrency(a.currency)! }),
      ...((a.kind === 'bill' || a.kind === 'envelope') && { kind: a.kind as 'bill' | 'envelope' }),
      ...(day(a.due_day) !== undefined && { dueDay: day(a.due_day)! }),
      ...(day(a.due_day_end) !== undefined && { dueDayEnd: day(a.due_day_end)! }),
      ...(Number.isInteger(Number(a.remind_days)) && a.remind_days != null && { remindDays: Math.min(15, Math.max(0, Number(a.remind_days))) }),
      ...(cat && { categoryId: cat.id }),
      ...(code && { accountId: accs.find((x) => x.code === code)!.accountId }),
      ...(typeof a.emoji === 'string' && a.emoji.trim() && { emoji: a.emoji.trim() }),
    };
    const found = await this.plan.findItem(name);
    if (!found && patch.amount == null) throw new Error('línea nueva: falta amount (pregúntalo)');
    const item = found ? await this.plan.updateItem(found.id, patch) : await this.plan.createItem({ name, currency: 'USD', ...patch } as any);
    const when = item.dueDay ? (item.dueDayEnd && item.dueDayEnd !== item.dueDay ? ` · del ${item.dueDay} al ${item.dueDayEnd}` : ` · el ${item.dueDay}`) : '';
    await this.send(`📅 ${found ? 'Actualicé' : 'Agregué al plan'}: <b>${esc(item.name)}</b> · ${amt(Number(item.amount), item.currency)}${when}${item.kind === 'envelope' ? ' (presupuesto)' : ''}`);
    return { id: item.id, name: item.name, amount: Number(item.amount), currency: item.currency, dueDay: item.dueDay, dueDayEnd: item.dueDayEnd, kind: item.kind, created: !found };
  }

  // ── commands ────────────────────────────────────────────────────────────
  private async saldo() {
    const accs = await this.ledger.balances();
    const now = Date.now();
    const lines = accs.map((a) => {
      const usdPart = a.currency !== 'USD' && a.balanceUsd != null ? ` (≈ ${usd(a.balanceUsd)})` : '';
      const tag = a.kind === 'synced' ? (a.lastSyncedAt ? `sincronizado ${hhmm(a.lastSyncedAt)}` : 'sin leer aún · usa /sync') : a.lastReconciledAt ? `estimado · conciliado hace ${Math.max(0, Math.round((now - a.lastReconciledAt.getTime()) / 864e5))} d` : 'estimado';
      return `<b>${esc(a.name)}</b>: ${money(Math.round(a.balance * 100) / 100, a.currency)}${usdPart}\n   <i>${tag}</i>`;
    });
    const total = (await this.insights.overview()).netWorthUsd; // includes every Binance wallet when snapshotted
    return this.send(`🏦 <b>Saldos</b>\n${lines.join('\n')}\n\nTotal ≈ <b>${usd(total)}</b>`);
  }

  async summaryText(from: Date, to: Date, label: string) {
    const rows = await this.insights.spendSummary({ from, to, groupBy: 'category' });
    if (!rows.length) return `Nada registrado ${label} 🙌`;
    const total = rows.reduce((s, r) => s + r.total, 0);
    const lines = rows.sort((a, b) => b.total - a.total).slice(0, 8).map((r) => `• ${esc(r.label)}: ${usd(r.total)} (${r.count})`);
    return `🧾 <b>Gastos ${label}: ${usd(total)}</b>\n${lines.join('\n')}`;
  }
  private async summary(from: Date, label: string) {
    return this.send(await this.summaryText(from, new Date(), label));
  }

  private async ultimos() {
    const txs = await this.ledger.recent(10);
    if (!txs.length) return this.send('Todavía no hay movimientos 🙂');
    const now = new Date();
    const k = new InlineKeyboard();
    const lines = txs.map((t) => {
      k.text(`✏️ #${t.id}`, cb('t', 'o', t.id)).text(`🗑️ #${t.id}`, cb('t', 'x', t.id)).row();
      const day = dayLabel(t.occurredAt, now).replace(/^de (esta mañana|hoy)$/, 'hoy').replace(/^del? /, '');
      return `#${t.id} ${day} ${hhmm(t.occurredAt)} · ${esc(t.merchant ?? t.category?.name ?? t.type)} · ${money(Number(t.amount), t.currency)}${t.status === 'pending' ? ' 📝' : ''}`;
    });
    return this.send(`🕒 <b>Últimos</b>\n${lines.join('\n')}`, k);
  }

  private async pendientes() {
    const [total, { items }] = await Promise.all([
      this.db.transaction.count({ where: { status: 'pending' } }),
      this.insights.listTransactions({ status: 'pending', limit: 5 }),
    ]);
    if (!total) return this.send('Nada pendiente 🎉');
    await this.send(`📝 Tienes <b>${total}</b> por revisar.${total > 5 ? ' Te muestro los 5 más recientes.' : ''}`,
      new InlineKeyboard().text('✅ Confirmar todos', 'p:ok').text('🗑️ Descartar todos', 'p:void'));
    for (const t of items) await this.showTx(t.id);
  }

  /** Bulk "empezar de 0": resolve every pending tx, cancel queued nudges, close open bags. */
  private async bulkPending(act: 'ok' | 'void', sure: boolean, msgId?: number) {
    const n = await this.db.transaction.count({ where: { status: 'pending' } });
    const ready = await this.db.transaction.count({ where: { status: 'pending', ...HAS_ACCOUNT } });
    if (!sure) {
      const what = act === 'ok'
        ? `confirmar los ${ready} que tienen cuenta${n > ready ? ` (los ${n - ready} sin cuenta quedan pendientes)` : ''}`
        : `descartar los ${n} (no cuentan en reportes)`;
      const k = new InlineKeyboard().text('Sí, hazlo', `p:${act}:y`).text('No', 'p:no');
      return msgId ? this.edit(msgId, `¿Seguro? Voy a ${what}, cancelar los recordatorios y cerrar las bolsas abiertas.`, k) : undefined;
    }
    // ponytail: bulk skips transaction_versions/bag re-allocation — bags are closed below anyway
    await this.db.$transaction([
      act === 'ok'
        ? this.db.transaction.updateMany({ where: { status: 'pending', ...HAS_ACCOUNT }, data: { status: 'confirmed' } })
        : this.db.transaction.updateMany({ where: { status: 'pending' }, data: { status: 'void' } }),
      this.db.pendingPrompt.updateMany({ where: { answeredAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } }),
      this.db.bag.updateMany({ where: { closedAt: null }, data: { closedAt: new Date() } }),
    ]);
    const left = act === 'ok' && n > ready ? `\n🏦 ${n - ready} sin cuenta siguen en /pendientes: elige de dónde salieron.` : '';
    const done = `${act === 'ok' ? `✅ Confirmé ${ready}` : `🗑️ Descarté ${n}`} movimientos. Empiezas de 0 🎉${left}\nSi quieres, usa /conciliar para poner el saldo real de tus bancos hoy.`;
    return msgId ? this.edit(msgId, done) : this.send(done);
  }

  private async conciliar() {
    const accs = (await this.ledger.balances()).filter((a) => a.kind === 'ledger');
    const k = new InlineKeyboard();
    accs.forEach((a, i) => { k.text(a.name, cb('r', a.accountId)); if (i % 2) k.row(); });
    return this.send('¿Qué cuenta quieres cuadrar?', k);
  }

  /** What Binance data we actually have — proof the sync reads your P2P. */
  private async syncStatus() {
    const [p2pCount, payCount, last, snap, all] = await Promise.all([
      this.db.rawEvent.count({ where: { source: 'p2p' } }),
      this.db.rawEvent.count({ where: { source: 'pay' } }),
      this.db.rawEvent.findMany({ where: { source: 'p2p' }, orderBy: { occurredAt: 'desc' }, take: 3 }),
      this.db.walletSnapshot.findFirst({ where: { wallet: 'funding' }, orderBy: { takenAt: 'desc' } }),
      this.db.walletSnapshot.findFirst({ where: { wallet: 'all' }, orderBy: { takenAt: 'desc' } }),
    ]);
    const [queued, sentToday, lastSent] = await Promise.all([
      this.db.pendingPrompt.count({ where: { sentAt: null, answeredAt: null, cancelledAt: null } }),
      this.db.pendingPrompt.count({ where: { sentAt: { gte: startOfDay(new Date()) } } }),
      this.db.pendingPrompt.findFirst({ where: { sentAt: { not: null } }, orderBy: { sentAt: 'desc' } }),
    ]);
    const wallets = Object.entries((all?.balances ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]);
    const total = wallets.reduce((n, [, v]) => n + Number(v), 0);
    const lines = last.map((e) => {
      const o = e.payload as any;
      return `• ${dayLabel(e.occurredAt, new Date())} ${hhmm(e.occurredAt)} ${o.tradeType === 'SELL' ? 'Vendí' : 'Compré'} ${money(Number(o.amount), o.asset)} → ${money(Number(o.totalPrice), o.fiat)} @ ${Number(o.unitPrice)} · ${esc(o.payMethodName ?? '¿banco?')} · ${esc(o.orderStatus)}`;
    });
    const usdt = snap ? Number((snap.balances as any)?.USDT ?? 0) : null;
    return this.send([
      `✅ Binance: <b>${p2pCount}</b> órdenes P2P y <b>${payCount}</b> pagos guardados.`,
      ...(lines.length ? ['', 'Últimos P2P:', ...lines] : ['Aún no veo órdenes P2P (¿key sin permiso de lectura o sin /backfill?).']),
      '', snap ? `Funding (USDT): ${money(usdt!, 'USDT')} · leído ${hhmm(snap.takenAt)}` : 'Funding: sin lectura todavía.',
      ...(wallets.length ? ['', `<b>Total Binance ≈ ${money(total, 'USDT')}</b>`, ...wallets.map(([w, v]) => `• ${esc(w)}: ${money(Number(v), 'USDT')}`)] : []),
      '', `🔔 Avisos: ${queued} en cola · ${sentToday} enviados hoy${lastSent?.sentAt ? ` · último ${esc(lastSent.kind)} ${hhmm(lastSent.sentAt)}` : ''}`,
    ].join('\n'));
  }

  private async panel() {
    if (!this.publicUrl) return this.send('Falta configurar PUBLIC_URL 🤔');
    const token = await this.auth.createMagicToken();
    const link = `${this.publicUrl}/api/auth/magic?token=${encodeURIComponent(token)}`;
    // Telegram rejects http/localhost URLs in buttons (local dev) → plain text link
    if (!this.publicUrl.startsWith('https://')) return this.send(`📊 Tu panel (enlace válido 10 min):\n${esc(link)}`);
    return this.send('📊 Tu panel:', new InlineKeyboard()
      .webApp('📊 Abrir panel', this.publicUrl).row()
      .url('🌐 Abrir en el navegador (10 min)', link));
  }

  async setting<T>(key: string, fallback: T): Promise<T> {
    const s = await this.db.setting.findUnique({ where: { key } });
    return (s?.value as T) ?? fallback;
  }

  private async ajustesText() {
    const daily = await this.setting('daily_summary', true);
    return [
      '⚙️ <b>Ajustes</b>',
      `Recordatorios: ${process.env.NUDGE_TIMES ?? '13:30,20:30'} · máx ${process.env.NUDGE_DAILY_CAP ?? 4}/día`,
      `Silencio: ${process.env.QUIET_HOURS ?? '22:00-08:00'}`,
      `Resumen diario 21:00: ${daily ? 'sí' : 'no'}`,
      '<i>Lo demás se cambia en el .env del servidor.</i>',
    ].join('\n');
  }
  private async ajustes() {
    const daily = await this.setting('daily_summary', true);
    return this.send(await this.ajustesText(), new InlineKeyboard().text(daily ? '🔕 Quitar resumen diario' : '🔔 Activar resumen diario', cb('s', 'daily')));
  }
  private async toggleSetting(key: string, msgId?: number) {
    if (key !== 'daily') return;
    const v = !(await this.setting('daily_summary', true));
    await this.db.setting.upsert({ where: { key: 'daily_summary' }, create: { key: 'daily_summary', value: v }, update: { value: v } });
    if (msgId) await this.edit(msgId, await this.ajustesText(), new InlineKeyboard().text(v ? '🔕 Quitar resumen diario' : '🔔 Activar resumen diario', cb('s', 'daily')));
  }
}

/** Rows that may be confirmed. */
const HAS_ACCOUNT = { NOT: MISSING_ACCOUNT_WHERE };

/** Agent/ask answer -> Telegram HTML; table (or chart as rows) as a monospace block. */
function answerHtml(r: AskAnswer) {
  let html = esc(r.answer);
  const rows = r.table ? [r.table.columns, ...r.table.rows.slice(0, 20)].map((row) => row.map(String)) : r.chart ? r.chart.data.map((d) => [d.label, String(d.value)]) : null;
  if (rows?.length) {
    const w = rows[0].map((_, i) => Math.min(18, Math.max(...rows.map((row) => (row[i] ?? '').length))));
    html += `\n\n<pre>${esc(rows.map((row) => row.map((c, i) => c.slice(0, 18).padEnd(w[i])).join('  ')).join('\n'))}</pre>`;
  }
  return html;
}
