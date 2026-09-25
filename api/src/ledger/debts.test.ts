import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paidIn } from './debts.service';

test('paidIn converts payments to the debt currency', () => {
  assert.equal(paidIn('USD', { amount: 50, currency: 'USD', amountUsd: 50 }, 200), 50);
  assert.equal(paidIn('USD', { amount: 20, currency: 'USDT', amountUsd: 20 }, 200), 20);
  assert.equal(paidIn('USD', { amount: 4000, currency: 'VES', amountUsd: 19.5 }, 200), 19.5); // priced at the payment's rate
  assert.equal(paidIn('VES', { amount: 4000, currency: 'VES', amountUsd: 20 }, 200), 4000);
  assert.equal(paidIn('VES', { amount: 10, currency: 'USD', amountUsd: 10 }, 200), 2000);
  assert.equal(paidIn('USD', { amount: 4000, currency: 'VES', amountUsd: null }, 200), 0);
});
