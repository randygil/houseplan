import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIntentPrompt, normalizeIntent, parseAmount, parseLocalDate, txLine } from './intent';
import { unfence } from './llm.service';

const now = new Date('2026-09-22T14:00:00Z'); // 10:00 Caracas
const accounts = [
  { code: 'mercantil', name: 'Mercantil', currency: 'VES', balance: 8400 },
  { code: 'bdv', name: 'BDV', currency: 'VES', balance: 100 },
  { code: 'cash_usd', name: 'Efectivo $', currency: 'USD', balance: 40 },
  { code: 'cash_ves', name: 'Efectivo Bs', currency: 'VES', balance: 0 },
  { code: 'binance', name: 'Binance', currency: 'USDT', balance: 12 },
];

test('parseAmount: formatos venezolanos y jerga', () => {
  assert.equal(parseAmount('350'), 350);
  assert.equal(parseAmount('1.200'), 1200);
  assert.equal(parseAmount('1.200,50'), 1200.5);
  assert.equal(parseAmount('1,5'), 1.5);
  assert.equal(parseAmount('12.5'), 12.5);
  assert.equal(parseAmount('5 mil'), 5000);
  assert.equal(parseAmount('3 lucas'), 3000);
  assert.equal(parseAmount('$20'), 20);
  assert.equal(parseAmount(42), 42);
  assert.equal(parseAmount('nada'), null);
  assert.equal(parseAmount(-3), null);
});

test('parseLocalDate: hora local de Caracas, futuro/inválido -> now', () => {
  assert.equal(parseLocalDate('2026-09-22T08:30', now).toISOString(), '2026-09-22T12:30:00.000Z');
  assert.equal(parseLocalDate('2026-09-21T20:00:00Z', now).toISOString(), '2026-09-21T20:00:00.000Z');
  assert.equal(parseLocalDate(null, now), now);
  assert.equal(parseLocalDate('mañana', now), now);
  assert.equal(parseLocalDate('2026-12-01T10:00', now), now);
});

test('normalizeIntent: gasto multi-item, monedas y cuentas por alias', () => {
  const p = normalizeIntent({
    intent: 'add_expense', confidence: 1.3,
    items: [
      { amount: 350, currency: 'bs', account: 'Mercantil', merchant: 'panadería', category: 'Comida › Panadería', occurred_at: '2026-09-22T08:30' },
      { amount: '20', currency: 'verdes', account: 'efectivo', merchant: 'gasolina', category: null },
      { amount: '5 lucas', currency: null, account: 'pago móvil', merchant: 'farmacia', category: 'Salud' },
    ],
  }, { now, accounts });
  assert.equal(p.intent, 'add_expense');
  assert.equal(p.confidence, 1);
  assert.deepEqual(p.items.map((i) => [i.amount, i.currency, i.account]), [[350, 'VES', 'mercantil'], [20, 'USD', 'cash_usd'], [5000, null, null]]);
  assert.deepEqual(p.needs.sort(), ['account', 'category']);
  assert.equal(p.items[0].occurredAt.toISOString(), '2026-09-22T12:30:00.000Z');
  assert.equal(p.items[1].occurredAt, now);
});

test('normalizeIntent: moneda sale de la cuenta; edit con patch parcial; basura -> smalltalk', () => {
  const a = normalizeIntent({ intent: 'add_expense', items: [{ amount: 3, account: 'binance', category: 'Comida' }], confidence: 0.8 }, { now, accounts });
  assert.equal(a.items[0].currency, 'USDT');
  assert.deepEqual(a.needs, []);

  const e = normalizeIntent({ intent: 'edit', target_tx_id: '12', patch: { amount: 500, account: 'bdv', merchant: null } }, { now, accounts });
  assert.equal(e.targetTxId, 12);
  assert.deepEqual(e.patch, { amount: 500, account: 'bdv' }); // currency only if said; the bot derives it from the account

  const b = normalizeIntent({ intent: 'set_balance', balance: { account: 'mercantil', amount: '8.400' } }, { now, accounts });
  assert.deepEqual(b.balance, { account: 'mercantil', amount: 8400 });

  const s = normalizeIntent({ intent: 'hack', items: 'x', reply: 'hola' }, { now, accounts });
  assert.equal(s.intent, 'smalltalk');
  assert.deepEqual(s.items, []);
  assert.equal(s.reply, 'hola');
  assert.equal(s.confidence, 0.5);
});

test('buildIntentPrompt: contexto corto (hora local, cuentas, turnos, txs, pendiente)', () => {
  const recent = [txLine({ id: 7, type: 'expense', status: 'confirmed', occurredAt: new Date('2026-09-22T12:30:00Z'), amount: '350', currency: 'VES', merchant: 'panadería', category: { name: 'Panadería' }, fromAccount: { code: 'mercantil' } })];
  const s = buildIntentPrompt('no, eran 500', { now, accounts, categories: ['Comida', 'Comida › Panadería'], turns: [{ role: 'user', text: 'gasté 350 en pan' }], recent, pending: 'reconcile {"expected":9300}' });
  assert.match(s, /Ahora: 2026-09-22T10:00/);
  assert.match(s, /mercantil \(Mercantil, VES\): ~8400/);
  assert.match(s, /#7 2026-09-22T08:30 expense 350 VES · panadería · Panadería · mercantil · confirmed/);
  assert.match(s, /Yo: gasté 350 en pan/);
  assert.match(s, /reconcile \{"expected":9300\}/);
  assert.match(s, /"no, eran 500"$/);
});

test('unfence: quita cercos y prosa', () => {
  assert.equal(unfence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('Claro! {"a":[1]} listo'), '{"a":[1]}');
});
