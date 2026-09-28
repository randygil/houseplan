import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bdvDate, bs, match, parseRow, unseen } from './bdv.logic';

test('bs / bdvDate parse what the table shows', () => {
  assert.equal(bs('-56.637,00 Bs.'), -56637);
  assert.equal(bs('43.668,21 Bs.'), 43668.21);
  assert.equal(bdvDate('28-09-2026 17:41').toISOString(), '2026-09-28T21:41:00.000Z');
  assert.throws(() => bdvDate('2026-09-28'));
});

test('parseRow: sign from Débito/Crédito, commissions flagged', () => {
  const r = parseRow({ fecha: '28-09-2026 17:41', referencia: ' 0027291539439 ', descripcion: 'COMISION PAGOMOVILBDV     ', tipo: 'DEBITO', monto: '-169,91 Bs.', saldo: '43.668,21 Bs.' });
  assert.deepEqual({ ...r, at: undefined }, { at: undefined, ref: '0027291539439', desc: 'COMISION PAGOMOVILBDV', amount: -169.91, saldo: 43668.21, fee: true });
  assert.equal(parseRow({ fecha: '28-09-2026 17:28', referencia: '1', descripcion: 'TRASPASO OTRAS CTAS BDV EN LINEA', tipo: 'CREDITO', monto: '90.000,00 Bs.', saldo: '0' }).amount, 90000);
});

test('match: same amount + direction, closest in time, one-to-one, fees never match', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 28, h));
  const row = (ref: string, amount: number, h: number, fee = false) => ({ ref, amount, at: at(h), desc: '', saldo: 0, fee });
  const cands = [
    { id: 1, at: at(10), amount: 500, inflow: false },
    { id: 2, at: at(15), amount: 500, inflow: false },
    { id: 3, at: at(12), amount: 90000, inflow: true },
    { id: 4, at: at(12), amount: 14, inflow: false },
  ];
  const m = match([row('a', -500, 14), row('b', -500, 9), row('c', -500, 12), row('d', 90000, 13), row('e', -90000, 13), row('f', -14, 12, true)], cands);
  assert.deepEqual([...m].map(([r, l]) => [r, l.id]), [['a', 2], ['b', 1], ['d', 3]]);
  // outside ±2 days: no match
  assert.equal(match([row('x', -500, 10 + 72)], cands).size, 0);
});

test('match: similar amount the same day links as fuzzy, closest amount wins, never API amounts', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 28, h)); // 28-09, 00:00-19:59 Caracas
  const row = (ref: string, amount: number, h: number) => ({ ref, amount, at: at(h), desc: '', saldo: 0, fee: false });
  const cands = [
    { id: 1, at: at(20), amount: 16500, inflow: false },           // 16:00 Caracas, same day
    { id: 2, at: at(20), amount: 16000, inflow: false },
    { id: 3, at: at(20), amount: 90000, inflow: true, exact: true }, // P2P: exact only
    { id: 4, at: at(28), amount: 5000, inflow: false },             // 29-09 Caracas: other day
  ];
  const m = match([row('a', -16547.76, 21), row('b', -16100, 21), row('c', 89000, 21), row('d', -5000, 23), row('e', -30000, 21)], cands);
  assert.deepEqual([...m], [['d', { id: 4, fuzzy: false }], ['a', { id: 1, fuzzy: true }], ['b', { id: 2, fuzzy: true }]]);
});

test('unseen: skipped history comes back only with from, processed rows never do', () => {
  const at = new Date('2026-09-28T14:37:00Z'), from = new Date('2026-09-28T04:00:00Z');
  const row = (ref: string) => ({ ref, at, amount: -1, desc: '', saldo: 0, fee: false });
  const rows = [row('skipped'), row('done'), row('new')];
  const events = [{ externalId: 'skipped', occurredAt: at, payload: { skipped: true } }, { externalId: 'done', occurredAt: at, payload: { txId: 7 } }];
  assert.deepEqual(unseen(rows, events).map((r) => r.ref), ['new']);
  assert.deepEqual(unseen(rows, events, from).map((r) => r.ref), ['skipped', 'new']);
  assert.deepEqual(unseen(rows, events, new Date('2026-09-29T00:00:00Z')).map((r) => r.ref), ['new']);
});
