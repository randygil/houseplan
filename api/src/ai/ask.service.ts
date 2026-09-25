import { Injectable } from '@nestjs/common';
import { InsightsService } from '../insights/insights.service';
import { CategoriesService } from '../ledger/categories.service';
import { LedgerService, TxView } from '../ledger/ledger.service';
import { runAgent } from './agent';
import { EmbeddingsService } from './embeddings.service';
import { caracasIso } from './intent';
import { LlmService, Msg } from './llm.service';

export type AskAnswer = {
  answer: string;
  table?: { columns: string[]; rows: (string | number)[][] };
  chart?: { type: 'bar' | 'line'; data: { label: string; value: number }[] };
};

export const READ_TOOLS = ['spend_summary', 'list_transactions', 'compare_periods', 'bag_status', 'balances', 'semantic_search'];
export const TOOLS = `Consultas (devuelven datos para ti; fechas ISO, rango [from, to) ; totales en USD salvo currency):
- spend_summary {from, to, group_by: "category"|"account"|"merchant"|"day", currency?: "USD"|"VES"}
- list_transactions {from?, to?, category?, account?, merchant?, text?, min?, max?, type?, status?, limit?}
- compare_periods {a_from, a_to, b_from, b_to, group_by: "category"|"account"|"merchant"}
- bag_status {bag_id?, open_only?}   (bolsas = cada cambio P2P de USDT a Bs y en qué se fue)
- balances {}
- semantic_search {query, k?}   (búsqueda difusa por texto: "el almuerzo con María")`;

const HINT =
  '{"calls":[{"tool":string,"args":{}}]}  para pedir datos,  o  {"reply":string,"table"?:{"columns":[...],"rows":[[...]]},"chart"?:{"type":"bar"|"line","data":[{"label":string,"value":number}]}}  para responder';

const slim = (t: TxView) => ({
  id: t.id, date: caracasIso(t.occurredAt), type: t.type, status: t.status, amount: Number(t.amount), currency: t.currency,
  usd: t.amountUsd == null ? null : Number(t.amountUsd), merchant: t.merchant, category: t.category?.name ?? null,
  account: t.fromAccount?.code ?? t.toAccount?.code ?? null, note: t.note,
});

@Injectable()
export class AskService {
  constructor(
    private llm: LlmService,
    private insights: InsightsService,
    private ledger: LedgerService,
    private cats: CategoriesService,
    private emb: EmbeddingsService,
  ) {}

  async ask(question: string): Promise<AskAnswer> {
    const [accounts, cats] = await Promise.all([this.ledger.balances(), this.cats.list()]);
    const msgs: Msg[] = [{
      role: 'user',
      content: `Eres el asistente de finanzas personales de Randy (Venezuela). Ahora: ${caracasIso(new Date())} America/Caracas (UTC-4); la semana empieza el lunes.
Cuentas: ${accounts.map((a) => `${a.code} (${a.currency})`).join(', ')}. Categorías: ${cats.map((c) => c.path).join(' | ')}.
${TOOLS}
Pide los datos con "calls" (puedes pedir varias a la vez). Las cifras salen SOLO de las herramientas, nunca inventes. Cuando tengas lo necesario responde con "reply" en español, corto y cálido, con montos como "$12,30" o "1.200 Bs". Añade "table" o "chart" sólo si ayudan.
Pregunta: ${JSON.stringify(question)}`,
    }];
    const tools = Object.fromEntries(READ_TOOLS.map((t) => [t, (a: any) => this.tool(t, a)]));
    return shape(await runAgent((m) => this.llm.json(m, HINT, this.llm.smart, 2000), msgs, tools, { maxSteps: 4, looks: READ_TOOLS }));
  }

  async tool(tool: string, a: any): Promise<unknown> {
    // model sends local "YYYY-MM-DD[THH:mm]" without zone: that's Caracas, not the server's UTC
    const d = (s: unknown) => { if (!s) return undefined; const v = String(s); return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v.length === 10 ? `${v}T00:00` : v}-04:00`); };
    const range = (from: unknown, to: unknown) => ({ from: d(from) ?? new Date(0), to: d(to) ?? new Date() });
    switch (tool) {
      case 'spend_summary':
        return this.insights.spendSummary({ ...range(a.from, a.to), groupBy: a.group_by ?? 'category', currency: a.currency });
      case 'list_transactions': {
        const categoryId = a.category ? (await this.cats.byPath(String(a.category)))?.id : undefined;
        const accountId = a.account ? (await this.ledger.accountByCode(String(a.account)).catch(() => null))?.id : undefined;
        const { items } = await this.insights.listTransactions({
          from: d(a.from), to: d(a.to), categoryId, accountId, merchant: a.merchant, text: a.text,
          min: a.min, max: a.max, type: a.type, status: a.status, limit: Math.min(Number(a.limit) || 30, 50),
        });
        return items.map(slim);
      }
      case 'compare_periods':
        return this.insights.comparePeriods(range(a.a_from, a.a_to), range(a.b_from, a.b_to), a.group_by ?? 'category');
      case 'bag_status':
        return (await this.insights.bagStatus({ bagId: a.bag_id, openOnly: a.open_only })).map((b) => ({
          id: b.bag.id, account: b.account, openedAt: caracasIso(b.bag.openedAt), amountVes: Number(b.bag.amountVes),
          rate: Number(b.bag.rate), spent: b.spent, remaining: b.remaining, txs: b.txs.map(slim),
        }));
      case 'balances':
        return (await this.ledger.balances()).map(({ code, currency, balance, balanceUsd, lastReconciledAt }) => ({ code, currency, balance, balanceUsd, lastReconciledAt }));
      case 'semantic_search':
        return this.emb.search(String(a.query ?? ''), Math.min(Number(a.k) || 5, 10));
      default:
        throw new Error(`herramienta desconocida: ${tool}`);
    }
  }
}

export function shape(r: any): AskAnswer {
  const out: AskAnswer = { answer: typeof r?.reply === 'string' && r.reply.trim() ? r.reply.trim() : 'No encontré datos para responder eso.' };
  const t = r?.table;
  if (t && Array.isArray(t.columns) && Array.isArray(t.rows)) out.table = { columns: t.columns.map(String), rows: t.rows.filter(Array.isArray) };
  const c = r?.chart;
  if (c && Array.isArray(c.data))
    out.chart = { type: c.type === 'line' ? 'line' : 'bar', data: c.data.map((p: any) => ({ label: String(p?.label ?? ''), value: Number(p?.value) || 0 })) };
  return out;
}
