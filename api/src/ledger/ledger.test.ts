import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingAccount } from './ledger.service';

test('missingAccount: gasto sin origen, ingreso sin destino, transferencia sin ningún lado', () => {
  assert.equal(missingAccount({ type: 'expense', fromAccountId: null }), true);
  assert.equal(missingAccount({ type: 'fee' }), true);
  assert.equal(missingAccount({ type: 'expense', fromAccountId: 3 }), false);
  assert.equal(missingAccount({ type: 'income', fromAccountId: 3 }), true);
  assert.equal(missingAccount({ type: 'income', toAccountId: 3 }), false);
  assert.equal(missingAccount({ type: 'transfer', fromAccountId: 2 }), false); // Pay "es mío": only the Binance side is known
  assert.equal(missingAccount({ type: 'transfer' }), true);
});
