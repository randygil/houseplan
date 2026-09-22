import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BinanceClient, BinanceError } from './binance.client';

type Call = { url: URL; init: RequestInit };
function client(responses: ((u: URL) => { status?: number; body: unknown; headers?: Record<string, string> })[]) {
  const c = new BinanceClient();
  Object.assign(c, { key: 'k', secret: 's', base: 'https://x.test' });
  const calls: Call[] = [];
  c.fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const r = responses.shift()!(u);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { c, calls };
}

test('signs requests with HMAC-SHA256, recvWindow and server-time offset', async () => {
  const serverTime = Date.now() + 5000;
  const { c, calls } = client([() => ({ body: { serverTime } }), () => ({ body: [{ asset: 'USDT', free: '1', locked: '0' }] })]);
  const r = await c.fundingAssets();
  assert.equal(r[0].asset, 'USDT');
  const { url, init } = calls[1];
  assert.equal(init.method, 'POST');
  assert.equal((init.headers as Record<string, string>)['X-MBX-APIKEY'], 'k');
  assert.equal(url.searchParams.get('recvWindow'), '10000');
  assert.ok(Math.abs(Number(url.searchParams.get('timestamp')) - serverTime) < 2000);
  const sig = url.searchParams.get('signature')!;
  const unsigned = url.search.slice(1).replace(`&signature=${sig}`, '');
  assert.equal(sig, createHmac('sha256', 's').update(unsigned).digest('hex'));
});

test('resyncs time and retries once on -1021', async () => {
  const { c, calls } = client([
    () => ({ body: { serverTime: Date.now() } }),
    () => ({ status: 400, body: { code: -1021, msg: 'Timestamp outside recvWindow' } }),
    () => ({ body: { serverTime: Date.now() + 60_000 } }),
    () => ({ body: { balances: [{ asset: 'BTC', free: '0', locked: '0' }, { asset: 'USDT', free: '2', locked: '1' }] } }),
  ]);
  const b = await c.spotBalances();
  assert.deepEqual(b.map((x) => x.asset), ['USDT']);
  assert.equal(calls.length, 4);
  assert.ok(c.offset! > 50_000);
});

test('clear errors; c2c success=false; high weight pauses', async () => {
  const { c } = client([
    () => ({ body: { serverTime: Date.now() } }),
    () => ({ status: 401, body: { code: -2015, msg: 'Invalid API-key' } }),
    () => ({ body: { code: '000002', message: 'illegal parameter', success: false, data: null } }),
    () => ({ body: { code: '000000', success: true, data: [] }, headers: { 'x-mbx-used-weight-1m': '5900' } }),
  ]);
  await assert.rejects(c.fundingAssets(), (e: BinanceError) => e.code === -2015 && /Invalid API-key/.test(e.message));
  await assert.rejects(c.p2pOrders('SELL', 0, 1), /illegal parameter/);
  assert.deepEqual(await c.p2pOrders('SELL', 0, 1), []);
  assert.ok(c.pauseUntil > Date.now());
});

test('p2p pages until a short page; pay splits a full window', async () => {
  const full = (n: number, f: (i: number) => object) => Array.from({ length: n }, (_, i) => f(i));
  const { c, calls } = client([
    () => ({ body: { serverTime: Date.now() } }),
    () => ({ body: { success: true, data: full(100, (i) => ({ orderNumber: `a${i}` })) } }),
    () => ({ body: { success: true, data: full(3, (i) => ({ orderNumber: `b${i}` })) } }),
    () => ({ body: { success: true, data: full(100, (i) => ({ transactionId: `p${i}` })) } }),
    () => ({ body: { success: true, data: full(60, (i) => ({ transactionId: `p${i}` })) } }),
    () => ({ body: { success: true, data: full(50, (i) => ({ transactionId: `q${i}` })) } }),
  ]);
  assert.equal((await c.p2pOrders('BUY', 0, 1000)).length, 103);
  assert.equal(calls[2].url.searchParams.get('page'), '2');
  assert.equal((await c.payTransactions(0, 10 * 86_400_000)).length, 110);
});

test('disabled without keys', async () => {
  const c = new BinanceClient();
  Object.assign(c, { key: '', secret: '' });
  assert.equal(c.enabled, false);
  await assert.rejects(c.fundingAssets(), /BINANCE_KEY/);
});
