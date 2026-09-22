import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followupText } from './nudges.service';
import { cb, dayLabel, inQuiet, money, needsJustification, parseWhen, startOfDay, startOfMonth, startOfWeek, txCard } from './ui';

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
    merchant: 'Panadería <La Nieves>', note: null, justification: null, occurredAt: new Date('2026-09-22T12:30:00Z'),
    category: { name: 'Panadería', emoji: '🥖' }, fromAccount: { name: 'Mercantil' },
  }, 'Comida › Panadería', now);
  assert.equal(card, '🥖 <b>Panadería &lt;La Nieves&gt;</b> · 350 Bs (≈ $6,00 · tasa 58,30 de tu cambio)\nCuenta: Mercantil   Categoría: Comida › Panadería\n🕒 hoy 08:30\n📝 Borrador');
});

test('justificación: > umbral USD o categoría Otros', () => {
  assert.equal(needsJustification({ type: 'expense', amountUsd: 25, justification: null }, 20), true);
  assert.equal(needsJustification({ type: 'expense', amountUsd: 5, justification: null, category: { name: 'Otros' } }, 20), true);
  assert.equal(needsJustification({ type: 'expense', amountUsd: 25, justification: 'regalo' }, 20), false);
  assert.equal(needsJustification({ type: 'income', amountUsd: 500, justification: null }, 20), false);
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
