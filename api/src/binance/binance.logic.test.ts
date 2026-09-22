import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caracasAt, followupTimes, fundingDelta, inQuiet, payWalletMoves } from './binance.logic';
import type { PayTx } from './binance.client';

test('fundingDelta: unexplained drop is a card candidate', () => {
  assert.deepEqual(fundingDelta({ USDT: 100 }, { USDT: 76.6 }, [], 1), [{ asset: 'USDT', drop: 23.4 }]);
});

test('fundingDelta: known movements explain the drop', () => {
  const moves = [
    { key: 'p2p:1', asset: 'USDT', amount: -50, final: true },
    { key: 'pay:1', asset: 'USDT', amount: -10, final: true },
    { key: 'tr:1', asset: 'USDT', amount: 5, final: true },
  ];
  assert.deepEqual(fundingDelta({ USDT: 100 }, { USDT: 45 }, moves, 1), []);
  // same movements, plus a 20 USDT card spend
  assert.deepEqual(fundingDelta({ USDT: 100 }, { USDT: 25 }, moves, 1), [{ asset: 'USDT', drop: 20 }]);
});

test('fundingDelta: an inflow does not hide a spend', () => {
  const dep = [{ key: 'dep:1', asset: 'USDT', amount: 100, final: true }];
  assert.deepEqual(fundingDelta({ USDT: 10 }, { USDT: 90 }, dep, 1), [{ asset: 'USDT', drop: 20 }]);
});

test('fundingDelta: pending outflows explain but never create drops', () => {
  const esc = [{ key: 'p2p:2', asset: 'USDT', amount: -200, final: false }];
  assert.deepEqual(fundingDelta({ USDT: 300 }, { USDT: 100 }, esc, 1), []); // escrow left the wallet
  assert.deepEqual(fundingDelta({ USDT: 300 }, { USDT: 300 }, esc, 1), []); // escrow stayed as locked
});

test('fundingDelta: threshold, gains and non-stablecoins ignored', () => {
  assert.deepEqual(fundingDelta({ USDT: 100 }, { USDT: 99.5 }, [], 1), []);
  assert.deepEqual(fundingDelta({ USDT: 100 }, { USDT: 150 }, [], 1), []);
  assert.deepEqual(fundingDelta({ BNB: 5 }, { BNB: 1 }, [], 1), []);
  assert.deepEqual(fundingDelta({ USDC: 5 }, {}, [], 1), [{ asset: 'USDC', drop: 5 }]);
});

test('payWalletMoves: splits by walletAssetCost (object or array), sign from amount', () => {
  const t = { orderType: 'PAY', transactionId: 'x', transactionTime: 0, amount: '-1.2', currency: 'USDT',
    fundsDetail: [{ currency: 'USDT', amount: '1.2', walletAssetCost: { '1': '0.7', '2': '0.5' } }] } as PayTx;
  assert.deepEqual(payWalletMoves(t, 1), [{ asset: 'USDT', amount: -0.7 }]);
  const arr = { ...t, fundsDetail: [{ currency: 'USDT', amount: '1.2', walletAssetCost: [{ '1': '0.7' }, { '2': '0.5' }] }] } as PayTx;
  assert.deepEqual(payWalletMoves(arr, 2), [{ asset: 'USDT', amount: -0.5 }]);
  const plain = { ...t, fundsDetail: undefined, walletType: 1, amount: '3' } as PayTx;
  assert.deepEqual(payWalletMoves(plain, 1), [{ asset: 'USDT', amount: 3 }]);
  assert.deepEqual(payWalletMoves(plain, 2), []);
});

test('Caracas time helpers (UTC-4)', () => {
  const now = new Date('2026-09-22T13:00:00Z'); // 09:00 Caracas
  assert.equal(caracasAt(now, '13:30').toISOString(), '2026-09-22T17:30:00.000Z');
  assert.equal(caracasAt(now, '09:00', 1).toISOString(), '2026-09-23T13:00:00.000Z');
  // 23:30 Caracas is still the 22nd there, though already the 23rd in UTC
  assert.equal(caracasAt(new Date('2026-09-23T03:30:00Z'), '09:00', 1).toISOString(), '2026-09-23T13:00:00.000Z');
  assert.ok(inQuiet('23:00', '22:00-08:00') && inQuiet('07:59', '22:00-08:00') && !inQuiet('08:00', '22:00-08:00'));
});

test('followupTimes: remaining today, skipping quiet hours', () => {
  const morning = new Date('2026-09-22T13:00:00Z'); // 09:00 Caracas
  assert.deepEqual(followupTimes(morning, '13:30,20:30,23:00', '22:00-08:00').map((d) => d.toISOString()),
    ['2026-09-22T17:30:00.000Z', '2026-09-23T00:30:00.000Z']);
  assert.deepEqual(followupTimes(new Date('2026-09-22T19:00:00Z'), '13:30,20:30', '22:00-08:00').length, 1);
});
