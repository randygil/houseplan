// Pure helpers (no I/O) so they can be unit-tested.
import type { PayTx } from './binance.client';

export const STABLES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'DAI', 'TUSD'];

/** A known balance change of the funding wallet. Non-final ones (e.g. P2P SELL still in escrow, withdrawal
 *  processing) may explain a drop but are not consumed, so the drop can show up now or when they complete. */
export type Movement = { key: string; asset: string; amount: number; final: boolean };

/** Unexplained stablecoin drops between two funding snapshots, as positive amounts ≥ minDrop. */
export function fundingDelta(
  prev: Record<string, number>, cur: Record<string, number>, moves: Movement[], minDrop: number,
): { asset: string; drop: number }[] {
  const out: { asset: string; drop: number }[] = [];
  for (const asset of STABLES) {
    const delta = (cur[asset] ?? 0) - (prev[asset] ?? 0);
    const known = moves.filter((m) => m.asset === asset);
    const final = known.filter((m) => m.final).reduce((s, m) => s + m.amount, 0);
    // pending outflows may explain a drop, but never create one
    const pendingOut = known.filter((m) => !m.final && m.amount < 0).reduce((s, m) => s + m.amount, 0);
    const unexplained = Math.min(0, delta - final - pendingOut);
    const drop = Math.round(-unexplained * 1e8) / 1e8;
    if (drop >= minDrop) out.push({ asset, drop });
  }
  return out;
}

/** Signed per-asset amounts a Pay transaction moved in the given wallet (1 = funding, 2 = spot). */
export function payWalletMoves(t: PayTx, wallet: 1 | 2): { asset: string; amount: number }[] {
  const sign = Math.sign(Number(t.amount)) || 0;
  const withCost = (t.fundsDetail ?? []).filter((f) => f.walletAssetCost);
  if (withCost.length) {
    return withCost
      .map((f) => {
        const cost: Record<string, string> = Array.isArray(f.walletAssetCost) ? Object.assign({}, ...f.walletAssetCost) : f.walletAssetCost!;
        return { asset: f.currency, amount: sign * Number(cost[String(wallet)] ?? 0) };
      })
      .filter((m) => m.amount !== 0);
  }
  const wallets = t.walletTypes ?? (t.walletType ? [t.walletType] : [1]);
  return wallets.length === 1 && wallets[0] === wallet ? [{ asset: t.currency, amount: Number(t.amount) }] : [];
}

export const isRefund = (t: PayTx) => /_RF$|REFUND/.test(t.orderType);
/** Only an explicit MERCHANT counts as a shop; USER / unknown => ask. */
export const isMerchant = (p?: { type?: string }) => p?.type === 'MERCHANT';

// ---- time (America/Caracas is fixed UTC-4, no DST) ----
const OFFSET = -4 * 3_600_000;
const hm = (s: string) => { const [h, m] = s.trim().split(':').map(Number); return h * 60 + (m || 0); };

/** Caracas wall-clock `HH:MM` on the Caracas day of `now` (+ dayShift), as a UTC Date. */
export function caracasAt(now: Date, time: string, dayShift = 0): Date {
  const c = new Date(now.getTime() + OFFSET);
  return new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate() + dayShift) + hm(time) * 60_000 - OFFSET);
}

/** UTC midnight of the Caracas calendar day (what a @db.Date column wants). */
export function caracasDay(d: Date): Date {
  const c = new Date(d.getTime() + OFFSET);
  return new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate()));
}

export function inQuiet(time: string, quiet: string): boolean {
  if (!quiet.includes('-')) return false;
  const [s, e] = quiet.split('-').map(hm);
  const t = hm(time);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

/** Remaining nudge times today (after now), skipping ones inside quiet hours. */
export function followupTimes(now: Date, nudgeTimes: string, quiet: string): Date[] {
  return nudgeTimes.split(',').filter((t) => t.trim() && !inQuiet(t, quiet))
    .map((t) => caracasAt(now, t)).filter((d) => d > now);
}
