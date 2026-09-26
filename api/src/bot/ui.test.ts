import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followupText } from './nudges.service';
import type { EntryView, MonthView } from '../ledger/plan.service';
import { debtsText, cb, dayLabel, inQuiet, money, monthTurnText, paidText, parseWhen, planDueText, planLine, planText, startOfDay, startOfMonth, startOfWeek, txCard } from './ui';

const now = new Date('2026-09-22T14:00:00Z'); // martes 10:00 Caracas

test('fechas en Caracas', () => {
  assert.equal(startOfDay(now).toISOString(), '2026-09-22T04:00:00.000Z');
  assert.equal(startOfDay(new Date('2026-09-23T02:00:00Z')).toISOString(), '2026-09-22T04:00:00.000Z'); // 22:00 local del 22
  assert.equal(startOfWeek(now).toISOString(), '2026-09-21T04:00:00.000Z'); // lunes
  assert.equal(startOfMonth(now).toISOString(), '2026-09-01T04:00:00.000Z');
  assert.equal(dayLabel(new Date('2026-09-22T12:00:00Z'), now), 'de esta mañana');
  assert.equal(dayLabel(new Date('2026-09-21T20:00:00Z'), now), 'de ayer');
  assert.equal(dayLabel(new Date('2026-09-19T20:00:00Z'), now), 'del sábado');
});

test('horas de silencio (cruza medianoche)', () => {
  assert.equal(inQuiet(new Date('2026-09-23T03:00:00Z')), true); // 23:00
  assert.equal(inQuiet(new Date('2026-09-22T11:30:00Z')), true); // 07:30
  assert.equal(inQuiet(new Date('2026-09-22T12:00:00Z')), false); // 08:00
  assert.equal(inQuiet(now, '13:00-14:00'), false);
});

test('parseWhen', () => {
  assert.equal(parseWhen('ayer 8pm', now)?.toISOString(), '2026-09-22T00:00:00.000Z');
  assert.equal(parseWhen('hoy 13:30', now)?.toISOString(), '2026-09-22T17:30:00.000Z');
  assert.equal(parseWhen('20/09 19:00', now)?.toISOString(), '2026-09-20T23:00:00.000Z');
  assert.equal(parseWhen('ayer', now)?.toISOString(), '2026-09-21T16:00:00.000Z');
  assert.equal(parseWhen('cuando sea', now), null);
});

test('money + tarjeta de tx', () => {
  assert.equal(money(1200, 'VES'), '1.200 Bs');
  assert.equal(money(6, 'USD'), '$6,00');
  assert.equal(money(23.4, 'USDT'), '23,40 USDT');
  const card = txCard({
    id: 1, type: 'expense', status: 'pending', amount: '350', currency: 'VES', amountUsd: '6', fxRate: '58.3', fxSource: 'bag',
    merchant: 'Panadería <La Nieves>', note: null, occurredAt: new Date('2026-09-22T12:30:00Z'),
    category: { name: 'Panadería', emoji: '🥖' }, fromAccount: { name: 'Mercantil' },
  }, 'Comida › Panadería', now);
  assert.equal(card, '🥖 <b>Panadería &lt;La Nieves&gt;</b> · 350 Bs (≈ $6,00 · tasa 58,30 de tu cambio)\nCuenta: Mercantil   Categoría: Comida › Panadería\n🕒 hoy 08:30\n📝 Borrador');
});

test('tarjeta de transferencia con cambio', () => {
  const card = txCard({
    id: 2, type: 'transfer', status: 'confirmed', amount: '24000', currency: 'VES', amountUsd: '120', fxRate: '200', fxSource: 'p2p',
    merchant: null, note: 'Cambio personal', occurredAt: new Date('2026-09-22T12:30:00Z'),
    fromAccount: { name: 'BDV' }, toAccount: { name: 'Zelle', currency: 'USD' }, toAmount: '120',
  }, null, now);
  assert.equal(card, '🔁 <b>Transferencia</b> · 24.000 Bs (≈ $120,00 · tasa 200,00 del cambio)\nBDV → Zelle (llegaron $120,00)\n🕒 hoy 08:30\n📝 Cambio personal\n✅ Registrado');
});

test('callback_data ≤ 64 bytes', () => {
  assert.equal(cb('t', 'ok', 123), 't:ok:123');
  assert.throws(() => cb('n', 'm', 1, 'x'.repeat(70)));
});

test('texto de seguimiento de bolsas: tono según asignaciones y agrupado', () => {
  const bag = (id: number, rem: number, n: number, name = 'Mercantil') => ({ id, amountVes: 11660, remainingVes: rem, openedAt: new Date('2026-09-22T13:14:00Z'), account: { name }, _count: { allocations: n } });
  assert.equal(followupText([bag(1, 11660, 0)], now), 'Del cambio de esta mañana quedan ~11.660 Bs en Mercantil sin movimientos registrados. ¿Gastaste algo?');
  assert.equal(followupText([bag(1, 8460, 2)], now), 'Del cambio de esta mañana registraste 2 gastos (3.200 Bs). Quedan ~8.460 Bs en Mercantil. ¿Algo más?');
  assert.match(followupText([bag(1, 100, 0), bag(2, 200, 1, 'BDV')], now), /^Tienes 2 cambios.*\n• Mercantil: ~100 Bs.*\n• BDV: ~200 Bs \(cambio de esta mañana, 1 gastos\)/);
});

test('debtsText: abiertas con lo que queda, total por moneda, saldadas aparte', () => {
  const t = debtsText([
    { name: 'Préstamo de Chachin', currency: 'USD', amount: 1670, paid: 0, remaining: 1670 },
    { name: 'Cashea', currency: 'USD', amount: 611, paid: 100, remaining: 511 },
    { name: 'Tarjeta', currency: 'VES', amount: 4000, paid: 4000, remaining: 0 },
  ]);
  assert.match(t, /Préstamo de Chachin<\/b> · queda \$1\.670,00\n/);
  assert.match(t, /Cashea<\/b> · queda \$511,00 de \$611,00/);
  assert.match(t, /Total: <b>\$2\.181,00<\/b>/);
  assert.match(t, /Saldadas: Tarjeta/);
  assert.match(debtsText([]), /No tienes deudas/);
});

const ev = (p: Partial<EntryView>): EntryView => ({
  id: 1, itemId: 1, month: '2026-10', name: 'Alquiler', emoji: '🔑', kind: 'bill', categoryId: null, accountId: null, note: null,
  currency: 'USDT', planned: 300, plannedUsd: 300, spent: 0, spentUsd: 0, diff: -300, diffUsd: -300, status: 'pending',
  dueFrom: '2026-10-01', dueTo: '2026-10-05', dueLabel: 'toca del 01/10 al 05/10 (en 5 días)', remindDays: 1, overridden: false, skipped: false,
  remindedOn: null, snoozeUntil: null, forecastUsd: 300, expectedUsd: 0, avgUsd: null, itemAmount: 300, txs: [], ...p,
});
const month = (entries: EntryView[], t: Partial<MonthView['totals']> = {}): MonthView => ({
  month: '2026-10', label: 'octubre de 2026', days: 31, elapsed: 10, today: '2026-10-10', isCurrent: true, rate: 200,
  totals: { plannedUsd: 977, spentUsd: 400, forecastUsd: 990, leftUsd: 577, unplannedUsd: 20, unplannedForecastUsd: 60, allSpentUsd: 420, allForecastUsd: 1050, bills: 2, billsPaid: 1, ...t },
  unplanned: [{ label: '🎉 Ocio', total: 20, count: 2 }], entries,
});

test('plan: líneas de pago y presupuesto', () => {
  assert.equal(planLine(ev({})), '◻️ Alquiler — $300 · toca del 01/10 al 05/10 (en 5 días)');
  assert.equal(planLine(ev({ dueLabel: 'vence hoy' })), '⏰ Alquiler — $300 · vence hoy');
  assert.equal(planLine(ev({ dueLabel: 'venció hace 2 días' })), '⚠️ Alquiler — $300 · venció hace 2 días');
  assert.equal(planLine(ev({ name: 'Luz', planned: 15, spent: 18.2, diff: 3.2, status: 'paid' })), '✅ Luz — $15 → pagaste $18,20 (+$3,20)');
  assert.equal(planLine(ev({ status: 'paid', spent: 300, diff: 0 })), '✅ Alquiler — $300 → pagaste $300');
  assert.equal(planLine(ev({ status: 'skipped' })), '⏭️ Alquiler — este mes no');
  assert.equal(planLine(ev({ kind: 'envelope', name: 'Mercado', emoji: '🛒', planned: 200, plannedUsd: 200, spent: 120, spentUsd: 120, status: 'partial' })), '🛒 Mercado — $120 de $200 (60%)');
  assert.equal(planLine(ev({ kind: 'envelope', name: 'Gatos', emoji: '🐱', planned: 60, plannedUsd: 60, spent: 75, spentUsd: 75, diff: 15, status: 'over' })), '🐱 Gatos — $75 de $60 (125%) 🔴 +$15');
});

test('plan: /plan, recordatorio y "ya pagué"', () => {
  const txt = planText(month([ev({ status: 'paid', spent: 300, diff: 0 }), ev({ id: 2, name: 'Starlink', planned: 55, dueLabel: 'vence hoy' })]));
  assert.match(txt, /Plan de octubre de 2026/);
  assert.match(txt, /pronóstico \$1\.050,00/);
  assert.match(txt, /Vas \$73,00 por encima del plan/);
  assert.ok(txt.indexOf('Starlink') < txt.indexOf('Alquiler'), 'unpaid first');
  assert.match(txt, /Fuera del plan: <b>\$20,00<\/b> \(🎉 Ocio \$20,00\)/);
  assert.match(planText(month([])), /No tienes plan/);
  assert.equal(planDueText([ev({})]), '📅 <b>Alquiler</b> · $300\nToca del 01/10 al 05/10 (en 5 días). ¿Ya lo pagaste?');
  assert.match(planDueText([ev({ dueFrom: null, dueTo: null, dueLabel: 'sin fecha' })]), /No lo has registrado este mes/);
  assert.match(planDueText([ev({}), ev({ id: 2, name: 'Luz' })]), /Pagos del plan<\/b> sin registrar:\n◻️ Alquiler.*\n◻️ Luz/);
  assert.equal(paidText(ev({ name: 'Luz', planned: 15, spent: 18.2, diff: 3.2, status: 'paid' })), '✅ <b>Luz</b>: planificado $15, pagaste $18,20 (+$3,20 más de lo planificado).');
  assert.equal(paidText(ev({ spent: 300, diff: 0, status: 'paid' })), '✅ <b>Alquiler</b>: planificado $300, pagaste $300 (justo lo planificado 👌).');
  assert.match(paidText(ev({ spent: 100, diff: -200, status: 'partial' })), /^🟡 .*Faltan \$200\.$/);
});

test('plan: cambio de mes', () => {
  const prev = month([ev({ kind: 'envelope', name: 'Mercado', diffUsd: 40 }), ev({ name: 'Gatos', diffUsd: 15 })], { plannedUsd: 977, allSpentUsd: 1012, unplannedUsd: 80 });
  const t = monthTurnText({ ...prev, label: 'septiembre de 2026' }, month([ev({})]));
  assert.match(t, /Cerraste septiembre de 2026<\/b>: planificaste \$977,00 y gastaste \$1\.012,00 \(\+\$35,00\)/);
  assert.match(t, /Lo que más se pasó: Mercado \+\$40,00, Gatos \+\$15,00/);
  assert.match(t, /Primeros: Alquiler \(01\/10\)/);
});
