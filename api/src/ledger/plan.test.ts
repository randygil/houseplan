import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addMonths, convert, currencyIn, daysIn, dueLabel, dueWindow, entryStatus, forecast, merchantMatches, monthLabel, monthRange,
  paceForecast, reminderFor,
} from './plan.service';

test('meses en Caracas', () => {
  assert.equal(daysIn('2026-02'), 28);
  assert.equal(daysIn('2028-02'), 29);
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(monthRange('2026-09').from.toISOString(), '2026-09-01T04:00:00.000Z');
  assert.equal(monthRange('2026-09').to.toISOString(), '2026-10-01T04:00:00.000Z');
  assert.equal(monthLabel('2026-09'), 'septiembre de 2026');
});

test('dueWindow: ventana recortada al largo del mes', () => {
  assert.deepEqual(dueWindow('2026-10', 1, 5), { dueFrom: '2026-10-01', dueTo: '2026-10-05' });
  assert.deepEqual(dueWindow('2026-02', 30, null), { dueFrom: '2026-02-28', dueTo: '2026-02-28' });
  assert.deepEqual(dueWindow('2026-10', 15, 10), { dueFrom: '2026-10-15', dueTo: '2026-10-15' }); // end before start = single day
  assert.deepEqual(dueWindow('2026-10', null, null), { dueFrom: null, dueTo: null });
});

test('entryStatus: pago al 90% (tasas), presupuesto pasado = over', () => {
  assert.equal(entryStatus('bill', 300, 0, false), 'pending');
  assert.equal(entryStatus('bill', 300, 150, false), 'partial');
  assert.equal(entryStatus('bill', 15, 14, false), 'paid'); // Bs a la tasa del día: casi 15
  assert.equal(entryStatus('bill', 15, 18.2, false), 'paid');
  assert.equal(entryStatus('envelope', 200, 120, false), 'partial');
  assert.equal(entryStatus('envelope', 200, 230, false), 'over');
  assert.equal(entryStatus('bill', 300, 0, true), 'skipped');
});

test('forecast', () => {
  // envelope: plan until a week of data, then the pace
  assert.equal(forecast('envelope', 'partial', 200, 50, 3, 30), 200);
  assert.equal(forecast('envelope', 'partial', 200, 100, 10, 30), 300);
  assert.equal(forecast('envelope', 'partial', 200, 40, 20, 30), 60);
  // bill: plan until paid, then what was paid
  assert.equal(forecast('bill', 'pending', 55, 0, 10, 30), 55);
  assert.equal(forecast('bill', 'paid', 15, 18.2, 10, 30), 18.2);
  assert.equal(forecast('bill', 'partial', 300, 100, 10, 30), 300);
  // past month / skipped: what really went out
  assert.equal(forecast('bill', 'pending', 55, 0, 30, 30), 0);
  assert.equal(forecast('bill', 'skipped', 80, 0, 5, 30), 0);
  assert.equal(paceForecast(30, 10, 30), 90);
  assert.equal(paceForecast(30, 3, 30), 30);
});

const base = { kind: 'bill', status: 'pending' as const, dueFrom: '2026-10-01', dueTo: '2026-10-05', remindDays: 1, remindedOn: null, snoozeUntil: null, month: '2026-10' };
test('reminderFor: antes, al abrir, último día y atrasos', () => {
  assert.equal(reminderFor(base, '2026-09-30'), 'before');
  assert.equal(reminderFor(base, '2026-10-01'), 'start');
  assert.equal(reminderFor(base, '2026-10-03'), null);
  assert.equal(reminderFor(base, '2026-10-05'), 'last');
  assert.equal(reminderFor(base, '2026-10-06'), 'overdue');
  assert.equal(reminderFor(base, '2026-10-07'), null);
  assert.equal(reminderFor(base, '2026-10-08'), 'overdue');
  assert.equal(reminderFor(base, '2026-10-12'), 'overdue');
  assert.equal(reminderFor(base, '2026-10-20'), null);
  assert.equal(reminderFor({ ...base, remindedOn: '2026-10-01' }, '2026-10-01'), null); // once a day
  assert.equal(reminderFor({ ...base, status: 'paid' }, '2026-10-01'), null);
  assert.equal(reminderFor({ ...base, status: 'partial' }, '2026-10-05'), 'last');
  assert.equal(reminderFor({ ...base, kind: 'envelope' }, '2026-10-01'), null);
  assert.equal(reminderFor({ ...base, remindDays: 0 }, '2026-09-30'), null);
});

test('reminderFor: "mañana" y pagos sin fecha', () => {
  assert.equal(reminderFor({ ...base, snoozeUntil: '2026-10-03' }, '2026-10-02'), null);
  assert.equal(reminderFor({ ...base, snoozeUntil: '2026-10-03' }, '2026-10-03'), 'snooze');
  const undated = { ...base, dueFrom: null, dueTo: null };
  assert.equal(reminderFor(undated, '2026-10-28'), 'undated');
  assert.equal(reminderFor(undated, '2026-10-27'), null);
});

test('dueLabel', () => {
  assert.equal(dueLabel('2026-10-01', '2026-10-05', '2026-09-26'), 'toca del 01/10 al 05/10 (en 5 días)');
  assert.equal(dueLabel('2026-10-15', '2026-10-15', '2026-10-14'), 'vence mañana');
  assert.equal(dueLabel('2026-10-15', '2026-10-15', '2026-10-12'), 'vence el 15/10 (en 3 días)');
  assert.equal(dueLabel('2026-10-15', '2026-10-15', '2026-10-15'), 'vence hoy');
  assert.equal(dueLabel('2026-10-01', '2026-10-05', '2026-10-03'), 'tienes hasta el 05/10 (quedan 2 días)');
  assert.equal(dueLabel('2026-10-01', '2026-10-05', '2026-10-04'), 'tienes hasta el 05/10 (mañana)');
  assert.equal(dueLabel('2026-10-01', '2026-10-05', '2026-10-06'), 'venció hace 1 día');
  assert.equal(dueLabel(null, null, '2026-10-06'), 'sin fecha');
});

test('currencyIn / convert / merchantMatches', () => {
  assert.equal(currencyIn('11.500 bs'), 'VES');
  assert.equal(currencyIn('pagué 4 mil bolos'), 'VES');
  assert.equal(currencyIn('310 usdt'), 'USDT');
  assert.equal(currencyIn('$20'), 'USD');
  assert.equal(currencyIn('20 dólares'), 'USD');
  assert.equal(currencyIn('310'), null);
  assert.equal(convert(15, 'USDT', 'VES', 200), 3000);
  assert.equal(convert(3000, 'VES', 'USD', 200), 15);
  assert.equal(convert(15, 'USDT', 'USD', null), 15);
  assert.equal(convert(15, 'USDT', 'VES', null), null);
  assert.equal(merchantMatches('Pago Starlink', 'Starlink'), true);
  assert.equal(merchantMatches('MOVISTAR', 'Movistar'), true);
  assert.equal(merchantMatches('Google One', 'Google One'), true);
  assert.equal(merchantMatches('Internetshop', 'Internet'), false); // whole words only
  assert.equal(merchantMatches(null, 'Luz'), false);
});
