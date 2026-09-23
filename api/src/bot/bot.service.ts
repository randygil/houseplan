import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { AskService } from '../ai/ask.service';
import { EmbeddingsService } from '../ai/embeddings.service';
import { caracasIso, normAccount, Parsed, parseAmount } from '../ai/intent';
import { IntentService } from '../ai/intent.service';
import { TranscribeService } from '../ai/transcribe.service';
import { BinanceService } from '../binance/binance.service';
import { PrismaService } from '../db/prisma.service';
import { AuthService } from '../http/auth.service';
import { InsightsService } from '../insights/insights.service';
import { CategoriesService } from '../ledger/categories.service';
import { BagsService } from '../ledger/bags.service';
import { LedgerService, TxInput, TxView } from '../ledger/ledger.service';
import { cb, dayLabel, esc, hhmm, money, needsJustification, parseWhen, startOfDay, startOfMonth, startOfWeek, txCard, usd } from './ui';

type Field = 'amount' | 'merchant' | 'note' | 'date';
export type Awaiting = { kind: Field | 'justification' | 'balance'; txId?: number; accountId?: number; promptId?: number; msgId?: number; at: number };
type Mode = 'view' | 'edit' | 'acc' | 'cat';

const COMMANDS = [
  ['saldo', 'Saldos de tus cuentas'], ['hoy', 'Gastos de hoy'], ['semana', 'Gastos de la semana'], ['mes', 'Gastos del mes'],
  ['ultimos', 'Últimos movimientos'], ['deshacer', 'Deshacer el último cambio'], ['pendientes', 'Borradores por confirmar'],
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
  private justifyOver = Number(process.env.JUSTIFY_OVER_USD ?? 20);
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
    private asker: AskService,
    private emb: EmbeddingsService,
    private transcriber: TranscribeService,
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
    bot.command('saldo', () => safe(() => this.saldo()));
    bot.command('hoy', () => safe(() => this.summary(startOfDay(new Date()), 'hoy')));
    bot.command('semana', () => safe(() => this.summary(startOfWeek(new Date()), 'esta semana')));
    bot.command('mes', () => safe(() => this.summary(startOfMonth(new Date()), 'este mes')));
    bot.command('ultimos', () => safe(() => this.ultimos()));
    bot.command('deshacer', () => safe(() => this.undo(null)));
    bot.command('pendientes', () => safe(() => this.pendientes()));
    bot.command('conciliar', () => safe(() => this.conciliar()));
    bot.command('panel', () => safe(() => this.panel()));
    bot.command('sync', () => safe(async () => { await this.send('🔄 Sincronizando…'); await this.binance.syncNow(); await this.syncStatus(); }));
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
      tx.fromAccount?.name ?? tx.toAccount?.name, tx.note, tx.justification, caracasIso(tx.occurredAt).replace('T', ' '),
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
      return back();
    }
    if (mode === 'edit')
      return k.text('💵 Monto', cb('t', 'f', tx.id, 'amount')).text('🏪 Comercio', cb('t', 'f', tx.id, 'merchant')).text('📅 Fecha', cb('t', 'f', tx.id, 'date')).row()
        .text('📝 Nota', cb('t', 'f', tx.id, 'note')).text('🏦 Cuenta', cb('t', 'acs', tx.id)).text('🏷️ Categoría', cb('t', 'cts', tx.id)).row()
        .text('🗑️ Anular', cb('t', 'no', tx.id)).text('↩️ Volver', cb('t', 'v', tx.id));
    if (tx.status === 'confirmed') return k.text('↩️ Deshacer', cb('t', 'un', tx.id)).text('✏️ Editar', cb('t', 'ed', tx.id));
    return k.text('✅ Ok', cb('t', 'ok', tx.id)).text('✏️ Editar', cb('t', 'ed', tx.id)).row()
      .text('🏦 Cuenta', cb('t', 'acs', tx.id)).text('🏷️ Categoría', cb('t', 'cts', tx.id)).text('❌ Cancelar', cb('t', 'no', tx.id));
  }

  private async onTxButton(act: string, id: number, arg: string | undefined, msgId?: number) {
    const n = Number(arg);
    switch (act) {
      case 'ok': await this.ledger.confirm(id); await this.showTx(id, { msgId }); return this.afterConfirm(id);
      case 'no': await this.ledger.void(id); return this.showTx(id, { msgId });
      case 'ed': return this.showTx(id, { msgId, mode: 'edit' });
      case 'v': return this.showTx(id, { msgId, mode: 'view' });
      case 'acs': return this.showTx(id, { msgId, mode: 'acc' });
      case 'cts': return this.showTx(id, { msgId, mode: 'cat' });
      case 'cp': return this.showTx(id, { msgId, mode: 'cat', parent: n });
      case 'o': return this.showTx(id, { mode: 'edit' }); // from /ultimos: open card as a new message
      case 'x': await this.ledger.void(id); return this.send(`🗑️ Anulado #${id}`);
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
      case 'js':
        this.awaiting = null;
        return msgId && this.edit(msgId, '👌 Sin justificación.');
    }
  }

  /** After a tx is confirmed: embed + maybe ask why (PLAN: > JUSTIFY_OVER_USD or category Otros). */
  async afterConfirm(id: number) {
    const tx = await this.ledger.get(id);
    if (!tx) return;
    this.embedTx(tx, (await this.cats.list()).find((c) => c.id === tx.categoryId)?.path);
    if (!needsJustification(tx, this.justifyOver)) return;
    const m = await this.send('💬 ¿Para qué fue? Así después entiendes en qué se fue la plata.', new InlineKeyboard().text('Omitir', cb('t', 'js', id)));
    this.awaiting = { kind: 'justification', txId: id, msgId: m.message_id, at: Date.now() };
  }

  // ── free text pipeline ──────────────────────────────────────────────────
  async handleText(text: string, source: string) {
    await this.turn('user', text);
    const a = this.awaiting;
    this.awaiting = null;
    if (a && Date.now() - a.at < 15 * 60e3 && (await this.fill(a, text))) return;
    await this.bot!.api.sendChatAction(this.chatId, 'typing').catch(() => {});
    let p: Parsed;
    try { p = await this.intent.parse(text); }
    catch (e) {
      this.log.error(`parse: ${(e as Error).message}`);
      return this.send('Uy, no pude procesar eso ahorita 😅 Intenta de nuevo en un momento.');
    }
    switch (p.intent) {
      case 'add_expense': case 'add_income': return this.addItems(p, source);
      case 'edit': return this.editTx(p);
      case 'undo': return this.undo(p.targetTxId);
      case 'delete': return this.remove(p.targetTxId);
      case 'set_balance': return this.setBalance(p.balance, false);
      case 'answer_prompt': return this.answerPrompt(p, source);
      case 'ask': return this.ask(text);
      default: return this.send(esc(p.reply ?? 'Aquí estoy 🙂 Cuéntame un gasto o pregúntame algo.'));
    }
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
    const id = a.txId!;
    if (a.kind === 'justification') {
      if (t.length > 200) return false; // looks like a new message, not an answer
      await this.ledger.update(id, { justification: t });
      if (a.msgId) await this.edit(a.msgId, `💬 ${esc(t)}`);
      const tx = await this.ledger.get(id);
      if (tx) this.embedTx(tx);
      return true;
    }
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

  async addItems(p: Parsed, source: string) {
    const type = p.intent === 'add_income' ? 'income' : 'expense';
    const items = await this.intent.resolve(p.items);
    if (!items.length) return this.send('¿Cuánto fue y en qué? 🙂');
    for (const it of items) {
      if (it.amount == null) { await this.send(`¿Cuánto fue${it.merchant ? ` en ${esc(it.merchant)}` : ''}?`); continue; }
      const tx = await this.ledger.create({
        type, status: 'pending', occurredAt: it.occurredAt, amount: it.amount, currency: it.currency ?? 'VES',
        ...(type === 'income' ? { toAccountId: it.accountId ?? undefined } : { fromAccountId: it.accountId ?? undefined }),
        categoryId: it.categoryId ?? undefined, merchant: it.merchant ?? undefined, note: it.note ?? undefined,
        source, confidence: p.confidence,
      });
      const auto = p.confidence > 0.9 && it.hasRule && it.accountId != null && (it.categoryId != null || type === 'income');
      if (auto) await this.ledger.confirm(tx.id);
      await this.showTx(tx.id);
      if (auto) await this.afterConfirm(tx.id);
    }
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
    if (q.occurredAt) patch.occurredAt = q.occurredAt;
    if (q.account) {
      const acc = await this.ledger.accountByCode(q.account).catch(() => null);
      if (acc) {
        if (tx.type === 'income') patch.toAccountId = acc.id; else patch.fromAccountId = acc.id;
        if (!q.currency && tx.currency !== acc.currency) patch.currency = acc.currency;
      }
    }
    if (q.category) {
      const c = await this.cats.byPath(q.category);
      if (c) patch.categoryId = c.id;
    }
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
    if (tx) return this.showTx(tx.id, { mode: 'cat', prefix: `Faltan ${money(-diff, cur)} en ${esc(acc?.name ?? '')}: lo dejé como gasto por justificar. ¿En qué fue?` });
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
    if (pending?.kind === 'ask_account' && pending.refId) {
      const code = normAccount(p.items[0]?.account ?? p.balance?.account ?? '', ['mercantil', 'bdv'], 'VES');
      if (code) { await done(); return this.setTxBank(pending.refId, code); }
    }
    if (p.items.some((i) => i.amount != null)) {
      await done();
      return this.addItems({ ...p, intent: 'add_expense' }, source);
    }
    return this.send(esc(p.reply ?? 'Usa los botones de arriba o cuéntame qué gastaste 🙂'));
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

  private async ask(q: string) {
    await this.bot!.api.sendChatAction(this.chatId, 'typing').catch(() => {});
    const r = await this.asker.ask(q);
    let html = esc(r.answer);
    const rows = r.table ? [r.table.columns, ...r.table.rows.slice(0, 20)].map((row) => row.map(String)) : r.chart ? r.chart.data.map((d) => [d.label, String(d.value)]) : null;
    if (rows?.length) {
      const w = rows[0].map((_, i) => Math.min(18, Math.max(...rows.map((row) => (row[i] ?? '').length))));
      html += `\n\n<pre>${esc(rows.map((row) => row.map((c, i) => c.slice(0, 18).padEnd(w[i])).join('  ')).join('\n'))}</pre>`;
    }
    return this.send(html);
  }

  private async photo(fileId: string) {
    await this.bot!.api.sendChatAction(this.chatId, 'typing').catch(() => {});
    const p = await this.intent.photo((await this.download(fileId)).toString('base64'), 'image/jpeg');
    if (p.kind === 'receipt' && p.items.length) return this.addItems(p, 'manual_photo');
    if (p.kind === 'balance' && p.balance) return this.setBalance(p.balance, true);
    return this.send('📷 No vi una factura ni un saldo en esa foto 🤔');
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
    if (!sure) {
      const what = act === 'ok' ? `confirmar los ${n} como están` : `descartar los ${n} (no cuentan en reportes)`;
      const k = new InlineKeyboard().text('Sí, hazlo', `p:${act}:y`).text('No', 'p:no');
      return msgId ? this.edit(msgId, `¿Seguro? Voy a ${what}, cancelar los recordatorios y cerrar las bolsas abiertas.`, k) : undefined;
    }
    // ponytail: bulk skips transaction_versions/bag re-allocation — bags are closed below anyway
    await this.db.$transaction([
      this.db.transaction.updateMany({ where: { status: 'pending' }, data: act === 'ok' ? { status: 'confirmed', justified: true } : { status: 'void' } }),
      this.db.pendingPrompt.updateMany({ where: { answeredAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } }),
      this.db.bag.updateMany({ where: { closedAt: null }, data: { closedAt: new Date() } }),
    ]);
    const done = `${act === 'ok' ? '✅ Confirmé' : '🗑️ Descarté'} ${n} movimientos. Empiezas de 0 🎉\nSi quieres, usa /conciliar para poner el saldo real de tus bancos hoy.`;
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
      `Pido justificación sobre ${usd(this.justifyOver)} o categoría Otros`,
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
