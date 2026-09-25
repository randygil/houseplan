import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { CategoriesService } from '../ledger/categories.service';
import { DebtsService } from '../ledger/debts.service';
import { LedgerService } from '../ledger/ledger.service';
import { runAgent, Tools } from './agent';
import { AskService, READ_TOOLS, TOOLS } from './ask.service';
import { AGENT_HINT, buildAgentPrompt, Item, normalizeIntent, Parsed, txLine } from './intent';
import { LlmService } from './llm.service';

export type ResolvedItem = Item & { accountId: number | null; categoryId: number | null; categoryPath: string | null; hasRule: boolean };

@Injectable()
export class IntentService {
  constructor(
    private llm: LlmService,
    private db: PrismaService,
    private ledger: LedgerService,
    private cats: CategoriesService,
    private asker: AskService,
    private debts: DebtsService,
  ) {}

  /** Agent turn: context + read tools (AskService) + the bot's action tools. Simple orders cost one model call. */
  async agent(text: string, actions: Tools) {
    const now = new Date();
    const [accounts, categories, turns, recent, pending, debts] = await Promise.all([
      this.ledger.balances(),
      this.cats.list(),
      this.db.chatTurn.findMany({ orderBy: { id: 'desc' }, take: 9 }), // includes the current user turn
      this.ledger.recent(8),
      this.db.pendingPrompt.findFirst({
        where: { sentAt: { gte: new Date(now.getTime() - 24 * 3600e3) }, answeredAt: null, cancelledAt: null },
        orderBy: { sentAt: 'desc' },
      }),
      this.debts.list(),
    ]);
    const prompt = buildAgentPrompt({
      now, accounts, categories: categories.map((c) => c.path),
      turns: turns.reverse().slice(0, -1), recent: recent.map(txLine),
      debts: debts.filter((d) => d.remaining > 0).map((d) => `- #${d.id} ${d.name}: ${+d.remaining.toFixed(2)} de ${d.amount} ${d.currency}`),
      pending: pending ? `${pending.kind} ${JSON.stringify(pending.payload)}` : null,
    }, TOOLS);
    const tools: Tools = { ...Object.fromEntries(READ_TOOLS.map((t) => [t, (a: any) => this.asker.tool(t, a)])), ...actions };
    return runAgent((m) => this.llm.json(m, AGENT_HINT, this.llm.smart, 2000),
      [{ role: 'user', content: `${prompt}\n\nMensaje de Randy: ${JSON.stringify(text)}` }], tools, { looks: READ_TOOLS });
  }

  /** Classification: merchant rule first (deterministic), LLM's category second. Rule also fills a missing account. */
  async resolve(items: Item[]): Promise<ResolvedItem[]> {
    const [accounts, cats, debts] = await Promise.all([this.ledger.balances(), this.cats.list(), this.debts.list()]);
    return Promise.all(items.map(async (it) => {
      const debtId = debts.some((d) => d.id === it.debtId) ? it.debtId : null;
      const rule = it.merchant ? await this.cats.ruleFor(it.merchant) : null;
      const byPath = async (p: string | null) => (p ? this.cats.byPath(p) : null);
      // a debt payment without a (valid) category lands in "Deudas"
      const cat = rule ? cats.find((c) => c.id === rule.categoryId) : (await byPath(it.category)) ?? (debtId ? await byPath('Deudas') : null);
      let acc = accounts.find((a) => a.code === it.account);
      if (!acc && rule?.accountId) acc = accounts.find((a) => a.accountId === rule.accountId);
      return {
        ...it, debtId, currency: it.currency ?? acc?.currency ?? null,
        accountId: acc?.accountId ?? null, categoryId: cat?.id ?? null,
        categoryPath: cat ? cats.find((c) => c.id === cat.id)?.path ?? cat.name : null, hasRule: !!rule,
      };
    }));
  }

  /** Receipt -> expense items; bank screenshot -> balance. */
  async photo(b64: string, mime: string): Promise<Parsed & { kind: 'receipt' | 'balance' | 'other' }> {
    const now = new Date();
    const [accounts, categories] = await Promise.all([this.ledger.balances(), this.cats.list()]);
    const raw = await this.llm.image(
      `Foto enviada a una app de gastos personales en Venezuela. Si es una factura/recibo: kind="receipt" y un item con el total (amount, currency VES|USD, merchant, category de esta lista: ${categories.map((c) => c.path).join(' | ')}, occurred_at "YYYY-MM-DDTHH:mm" si aparece). Si es una captura de la app de un banco con el saldo disponible: kind="balance" y balance {account: uno de ${accounts.map((a) => a.code).join(', ')} según el banco, amount}. Si no, kind="other". Los montos venezolanos usan punto de miles y coma decimal.`,
      b64, mime,
      '{"kind":"receipt|balance|other","items":[{"amount":number,"currency":string,"merchant":string,"category":string,"occurred_at":string|null}],"balance":{"account":string,"amount":number}|null,"confidence":0..1}',
    );
    const kind = raw?.kind === 'receipt' || raw?.kind === 'balance' ? raw.kind : 'other';
    const p = normalizeIntent({ ...raw, intent: kind === 'receipt' ? 'add_expense' : kind === 'balance' ? 'set_balance' : 'smalltalk' }, { now, accounts });
    return { ...p, kind };
  }
}
