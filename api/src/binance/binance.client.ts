import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

// Field names verified against developers.binance.com (2026-09). Numbers come back as strings.
export type P2POrder = {
  orderNumber: string; advNo?: string; tradeType: 'BUY' | 'SELL'; asset: string; fiat: string;
  amount: string; totalPrice: string; unitPrice: string; orderStatus: string; createTime: number;
  commission: string; takerCommission?: string; counterPartNickName: string; payMethodName: string;
};
export type PayParty = { name?: string; type?: string; binanceId?: string | number };
export type PayTx = {
  orderType: string; transactionId: string; transactionTime: number;
  amount: string; currency: string; // amount sign: + income, - expenditure
  walletType?: number; walletTypes?: number[]; // 1 funding, 2 spot, 3 fiat, 4/6 card, 5 earn
  fundsDetail?: { currency: string; amount: string; walletAssetCost?: Record<string, string> | Record<string, string>[] }[];
  payerInfo?: PayParty; receiverInfo?: PayParty;
};
export type WalletAsset = { asset: string; free: string; locked: string; freeze?: string; withdrawing?: string };
export type Transfer = { asset: string; amount: string; type: string; status: string; tranId: number; timestamp: number };
export type Deposit = { id: string; amount: string; coin: string; status: number; insertTime: number; completeTime?: number; walletType?: number };
export type Withdrawal = { id: string; amount: string; transactionFee: string; coin: string; status: number; applyTime: string; completeTime?: string; walletType?: number };

type Params = Record<string, string | number | undefined>;

export class BinanceError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) { super(message); }
}

const DAY = 86_400_000;
const WEIGHT_SOFT_LIMIT = 4800; // IP limit is 6000/min; pause until next minute above this

@Injectable()
export class BinanceClient {
  base = process.env.BINANCE_BASE || 'https://api.binance.com';
  key = process.env.BINANCE_KEY ?? '';
  secret = process.env.BINANCE_SECRET ?? '';
  fetch: typeof fetch = (...a) => globalThis.fetch(...a); // swapped in tests
  offset: number | null = null; // serverTime - localTime
  pauseUntil = 0;

  get enabled() { return !!(this.key && this.secret); }

  async syncTime() {
    const { serverTime } = await this.request<{ serverTime: number }>('GET', '/api/v3/time', '', false);
    this.offset = serverTime - Date.now();
  }

  async signed<T>(method: 'GET' | 'POST', path: string, params: Params = {}, retry = true): Promise<T> {
    if (!this.enabled) throw new Error('BINANCE_KEY/BINANCE_SECRET not set');
    if (this.offset === null) await this.syncTime();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    q.set('recvWindow', '10000');
    q.set('timestamp', String(Date.now() + this.offset!));
    q.set('signature', createHmac('sha256', this.secret).update(q.toString()).digest('hex'));
    try {
      return await this.request<T>(method, path, q.toString(), true);
    } catch (e) {
      if (retry && e instanceof BinanceError && e.code === -1021) { await this.syncTime(); return this.signed(method, path, params, false); }
      throw e;
    }
  }

  private async request<T>(method: string, path: string, query: string, auth: boolean): Promise<T> {
    const wait = this.pauseUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await this.fetch(`${this.base}${path}${query ? `?${query}` : ''}`, {
      method, headers: auth ? { 'X-MBX-APIKEY': this.key } : {},
    });
    const used = Number(res.headers.get('x-mbx-used-weight-1m'));
    if (used > WEIGHT_SOFT_LIMIT) this.pauseUntil = Math.ceil((Date.now() + 1) / 60_000) * 60_000;
    if (res.status === 429 || res.status === 418) this.pauseUntil = Date.now() + Number(res.headers.get('retry-after') || 60) * 1000;
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    if (!res.ok) throw new BinanceError(`Binance ${method} ${path} -> ${res.status} ${body?.code ?? ''} ${body?.msg ?? text}`.trim(), res.status, body?.code);
    // c2c/pay wrap as { code: "000000", success, data }
    if (body && typeof body === 'object' && 'success' in body && body.success === false)
      throw new BinanceError(`Binance ${path}: ${body.code} ${body.message}`, res.status, Number(body.code));
    return body as T;
  }

  // ---- endpoints ----

  /** ≤30-day window; pages of 100. */
  async p2pOrders(tradeType: 'BUY' | 'SELL', start: number, end: number): Promise<P2POrder[]> {
    const out: P2POrder[] = [];
    for (let page = 1; ; page++) {
      const r = await this.signed<{ data: P2POrder[] }>('GET', '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
        { tradeType, startTimestamp: start, endTimestamp: end, page, rows: 100 });
      out.push(...(r.data ?? []));
      if ((r.data ?? []).length < 100) return out;
    }
  }

  /** ≤90-day window; no pagination (limit ≤100), so split the window when it comes back full. */
  async payTransactions(start: number, end: number): Promise<PayTx[]> {
    const r = await this.signed<{ data: PayTx[] }>('GET', '/sapi/v1/pay/transactions', { startTime: start, endTime: end, limit: 100 });
    const data = r.data ?? [];
    if (data.length < 100 || end - start < 60_000) return data;
    const mid = Math.floor((start + end) / 2);
    const all = [...await this.payTransactions(start, mid), ...await this.payTransactions(mid + 1, end)];
    return [...new Map(all.map((t) => [t.transactionId, t])).values()];
  }

  fundingAssets() { return this.signed<WalletAsset[]>('POST', '/sapi/v1/asset/get-funding-asset'); }

  async spotBalances(): Promise<WalletAsset[]> {
    const r = await this.signed<{ balances: WalletAsset[] }>('GET', '/api/v3/account', { omitZeroBalances: 'true' });
    return r.balances.filter((b) => Number(b.free) + Number(b.locked) > 0);
  }

  /** Universal transfer history (type e.g. MAIN_FUNDING / FUNDING_MAIN), pages of 100. */
  async transfers(type: string, start: number, end: number): Promise<Transfer[]> {
    const out: Transfer[] = [];
    for (let current = 1; ; current++) {
      const r = await this.signed<{ total: number; rows?: Transfer[] }>('GET', '/sapi/v1/asset/transfer', { type, startTime: start, endTime: end, current, size: 100 });
      out.push(...(r.rows ?? []));
      if ((r.rows ?? []).length < 100) return out;
    }
  }

  /** Window < 90 days. */
  deposits(start: number, end: number) { return this.signed<Deposit[]>('GET', '/sapi/v1/capital/deposit/hisrec', { startTime: start, endTime: Math.min(end, start + 89 * DAY) }); }
  withdrawals(start: number, end: number) { return this.signed<Withdrawal[]>('GET', '/sapi/v1/capital/withdraw/history', { startTime: start, endTime: Math.min(end, start + 89 * DAY) }); }
}
