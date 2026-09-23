import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PrismaService } from '../db/prisma.service';
import { FxService } from '../fx/fx.service';
import { BagsService } from './bags.service';
import { CategoriesService } from './categories.service';
import { LedgerService } from './ledger.service';

process.env.DATABASE_URL ??= 'postgres://plata:plata@localhost:5433/plata';
const db = new PrismaService();
const fx = new FxService(db);
const bags = new BagsService(db, undefined as any);
const ledger = new LedgerService(db, fx, new CategoriesService(db), bags);
(bags as any).ledger = ledger;

const T0 = new Date('2001-01-01T12:00:00Z'); // far past: isolates fx_rates rows
const h = (n: number) => new Date(+T0 + n * 3600_000);
let acct: { id: number }, usdt: { id: number }, acct2: { id: number };

before(async () => {
  acct = await db.account.create({ data: { code: `test_ves_${Date.now()}`, name: 't', currency: 'VES', kind: 'ledger', openingAt: h(-24) } });
  acct2 = await db.account.create({ data: { code: `test_ves2_${Date.now()}`, name: 't2', currency: 'VES', kind: 'ledger', openingAt: h(-24) } });
  usdt = await db.account.create({ data: { code: `test_usdt_${Date.now()}`, name: 't', currency: 'USDT', kind: 'ledger', openingAt: h(-24) } });
});

after(async () => {
  const ids = [acct.id, acct2.id, usdt.id];
  const txs = await db.transaction.findMany({ where: { OR: [{ fromAccountId: { in: ids } }, { toAccountId: { in: ids } }] } });
  const txIds = txs.map((t) => t.id);
  await db.bagAllocation.deleteMany({ where: { transactionId: { in: txIds } } });
  await db.transactionVersion.deleteMany({ where: { transactionId: { in: txIds } } });
  await db.bag.deleteMany({ where: { accountId: { in: ids } } });
  await db.transaction.deleteMany({ where: { id: { in: txIds } } });
  await db.account.deleteMany({ where: { id: { in: ids } } });
  await db.fxRate.deleteMany({ where: { date: new Date('2001-01-01') } });
  await db.$disconnect();
});

const remaining = async () =>
  (await db.bag.findMany({ where: { accountId: acct.id }, orderBy: { openedAt: 'asc' } })).map((b) => [Number(b.remainingVes), !!b.closedAt]);

test('FIFO allocation, release on void/edit, undo', async () => {
  for (const [at, usd, rate] of [[h(0), 20, 50], [h(1), 10, 100]] as const) {
    const p2p = await ledger.create({ type: 'transfer', occurredAt: at, amount: usd, currency: 'USDT', toAmount: usd * rate, fromAccountId: usdt.id, toAccountId: acct.id, source: 'test' });
    await bags.open(p2p, acct.id, usd * rate, rate);
  }
  await fx.upsert(h(0), 'p2p_avg', 2000 / 30); // binance sync owns p2p_avg in prod
  const exp = (amount: number) => ledger.create({ type: 'expense', occurredAt: h(2), amount, currency: 'VES', fromAccountId: acct.id, source: 'manual_text' });

  const a = await exp(1500);
  assert.equal(Number(a.amountUsd), 25); // 1000/50 + 500/100
  assert.equal(a.fxSource, 'bag');
  assert.deepEqual(await remaining(), [[0, true], [500, false]]);

  const b = await exp(800); // 500 from bag2, 300 uncovered at p2p_avg (2000 VES / 30 USD)
  assert.ok(Math.abs(Number(b.amountUsd) - (5 + 300 / (2000 / 30))) < 1e-6);
  assert.deepEqual(await remaining(), [[0, true], [0, true]]);

  await ledger.void(a.id);
  assert.deepEqual(await remaining(), [[1000, false], [500, false]]);

  await ledger.update(b.id, { amount: 200 }); // released then re-allocated FIFO from bag1
  assert.deepEqual(await remaining(), [[800, false], [1000, false]]);

  const undone = await ledger.undoLast(b.id);
  assert.equal(Number(undone!.amount), 800);
  assert.deepEqual(await remaining(), [[200, false], [1000, false]]);

  const voided = await ledger.undoLast(b.id); // 'create' version => void
  assert.equal(voided!.status, 'void');
  assert.deepEqual(await remaining(), [[1000, false], [1000, false]]);
  assert.equal(await ledger.undoLast(b.id), null);

  const bal = (await ledger.balances()).find((x) => x.accountId === acct.id)!;
  assert.equal(bal.balance, 2000);
});

test('move: P2P landed in the other bank -> tx, bag and allocations follow', async () => {
  const bal = async (id: number) => (await ledger.balances()).find((x) => x.accountId === id)!.balance;
  const p2p = await ledger.create({ type: 'transfer', occurredAt: h(10), amount: 10, currency: 'USDT', toAmount: 1000, fromAccountId: usdt.id, toAccountId: acct2.id, source: 'test' });
  const bag = await bags.open(p2p, acct2.id, 1000, 100);
  const e = await ledger.create({ type: 'expense', occurredAt: h(11), amount: 300, currency: 'VES', fromAccountId: acct2.id, source: 'manual_text' });
  assert.equal(e.bagId, bag.id);
  const [b1, b2] = [await bal(acct.id), await bal(acct2.id)];

  assert.equal(await bags.move(bag.id, acct.id), true);
  const moved = await db.bag.findUniqueOrThrow({ where: { id: bag.id } });
  assert.equal(moved.accountId, acct.id);
  assert.equal(Number(moved.remainingVes), 1000); // the other bank's expense no longer drains it
  assert.equal((await ledger.get(p2p.id))!.toAccountId, acct.id);
  assert.equal(Number((await ledger.get(p2p.id))!.amountUsd), 10);
  assert.equal(await bal(acct.id), b1 + 1000);
  assert.equal(await bal(acct2.id), b2 - 1000);
  assert.equal(await bags.move(bag.id, acct.id), false); // no-op
});
