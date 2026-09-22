// Phase 0 spike: node --env-file=../.env dist/binance/spike.js
import 'reflect-metadata';
import { BinanceClient } from './binance.client';

async function main() {
  const api = new BinanceClient();
  if (!api.enabled) throw new Error('set BINANCE_KEY / BINANCE_SECRET in .env');
  const end = Date.now(), start = end - 30 * 86_400_000;

  const orders = [...await api.p2pOrders('SELL', start, end), ...await api.p2pOrders('BUY', start, end)]
    .sort((a, b) => b.createTime - a.createTime);
  console.log(`\n== P2P last 30d (${orders.length}) ==`);
  console.log('payMethodName values:', [...new Set(orders.map((o) => o.payMethodName))]);
  console.table(orders.slice(0, 15).map((o) => ({
    at: new Date(o.createTime).toISOString(), side: o.tradeType, status: o.orderStatus,
    amount: `${o.amount} ${o.asset}`, total: `${o.totalPrice} ${o.fiat}`, rate: o.unitPrice, pay: o.payMethodName, fee: o.commission,
  })));

  const pay = await api.payTransactions(end - 90 * 86_400_000, end);
  console.log(`\n== Pay last 90d (${pay.length}) ==`);
  console.table(pay.slice(0, 15).map((t) => ({
    at: new Date(t.transactionTime).toISOString(), type: t.orderType, amount: `${t.amount} ${t.currency}`, wallet: t.walletType,
    payer: `${t.payerInfo?.name ?? ''} (${t.payerInfo?.type ?? ''})`, receiver: `${t.receiverInfo?.name ?? ''} (${t.receiverInfo?.type ?? ''})`,
  })));

  console.log('\n== Funding ==');
  console.table(await api.fundingAssets());
  console.log('\n== Spot (non-zero) ==');
  console.table(await api.spotBalances());
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
