import { caracasDay } from '../binance/binance.logic';

/** A row of BDVenlínea's "Consulta de movimientos" table, exactly as the scraper read it. */
export type RawRow = { fecha: string; referencia: string; descripcion: string; tipo: string; monto: string; saldo: string };
export type Row = { at: Date; ref: string; desc: string; amount: number; saldo: number; fee: boolean };
/** A ledger tx on the BDV account that a bank row could be. */
/** `exact`: amount comes from an API (Binance P2P), so it never takes part in the "similar amount" pass. */
export type Candidate = { id: number; at: Date; amount: number; inflow: boolean; exact?: boolean };
export type Link = { id: number; fuzzy: boolean };

const MATCH_WINDOW = 2 * 86_400_000;
/** Second pass: same Caracas day, same direction, amount within this fraction (rounded or tipped by hand). */
const FUZZY = 0.05;

/** "1.234,56 Bs." / "-169,91 Bs." -> number */
export const bs = (s: string) => {
  const n = Number(s.replace(/[^\d,-]/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`monto inválido: ${s}`);
  return n;
};

/** "28-09-2026 17:41" (Caracas, UTC-4 all year) -> Date */
export const bdvDate = (s: string) => {
  const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/);
  if (!m) throw new Error(`fecha inválida: ${s}`);
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-04:00`);
};

export const parseRow = (r: RawRow): Row => {
  const amount = Math.abs(bs(r.monto)) * (/CREDITO/i.test(r.tipo) ? 1 : -1);
  const desc = r.descripcion.replace(/\s+/g, ' ').trim();
  // Pago móvil / failed-P2P commissions: tiny, one per operation, not worth a line each.
  return { at: bdvDate(r.fecha), ref: r.referencia.trim(), desc, amount, saldo: bs(r.saldo), fee: /COMISION/i.test(desc) };
};

/**
 * One-to-one, two passes. Exact: same amount and direction within ±2 days, closest in time wins.
 * Fuzzy (rows the exact pass left): a hand-logged tx the same day whose amount is within 5%, closest amount wins.
 * Returns ref -> tx.
 */
export function match(rows: Row[], cands: Candidate[]): Map<string, Link> {
  const used = new Set<number>();
  const out = new Map<string, Link>();
  const pass = (fuzzy: boolean, ok: (r: Row, c: Candidate) => boolean, dist: (r: Row, c: Candidate) => number) => {
    for (const r of rows) {
      if (r.fee || out.has(r.ref)) continue;
      const best = cands.filter((c) => !used.has(c.id) && c.inflow === r.amount > 0 && ok(r, c)).sort((a, b) => dist(r, a) - dist(r, b))[0];
      if (best) { used.add(best.id); out.set(r.ref, { id: best.id, fuzzy }); }
    }
  };
  pass(false, (r, c) => Math.abs(c.amount - Math.abs(r.amount)) < 0.01 && Math.abs(+c.at - +r.at) <= MATCH_WINDOW, (r, c) => Math.abs(+c.at - +r.at));
  pass(true, (r, c) => !c.exact && +caracasDay(c.at) === +caracasDay(r.at) && Math.abs(c.amount - Math.abs(r.amount)) <= FUZZY * Math.abs(r.amount),
    (r, c) => Math.abs(c.amount - Math.abs(r.amount)));
  return out;
}

/**
 * Rows no earlier run has handled. With `from`, rows an earlier run skipped as history (and that are
 * newer than `from`) count as unhandled again; anything already processed never does (idempotent).
 */
export const unseen = (rows: Row[], events: { externalId: string; occurredAt: Date; payload: unknown }[], from?: Date) => {
  const done = new Set(events
    .filter((e) => !(from && e.occurredAt > from && (e.payload as { skipped?: boolean } | null)?.skipped === true))
    .map((e) => e.externalId));
  return rows.filter((r) => !done.has(r.ref));
};
