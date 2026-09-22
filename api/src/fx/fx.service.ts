import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../db/prisma.service';

export const TZ = 'America/Caracas';
/** Calendar day in Caracas as a UTC-midnight Date (what a @db.Date column stores). */
export const caracasDay = (d: Date) => new Date(ymd(d) + 'T00:00:00Z');

export const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });

type Source = 'bcv' | 'p2p_avg' | 'market';

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

@Injectable()
export class FxService implements OnApplicationBootstrap {
  private log = new Logger(FxService.name);
  constructor(private db: PrismaService) {}

  /** VES per USD, latest on or before `date`. Without source: see best(). */
  async rate(date: Date, source?: Source): Promise<number | null> {
    if (!source) return (await this.best(date))?.rate ?? null;
    const r = await this.db.fxRate.findFirst({
      where: { source, date: { lte: caracasDay(date) } },
      orderBy: { date: 'desc' },
    });
    return r ? Number(r.vesPerUsd) : null;
  }

  /** Freshest rate on or before `date`; same day ties: my p2p_avg > market > bcv (VES inflates, a stale own rate is wrong). */
  async best(date: Date): Promise<{ rate: number; source: Source } | null> {
    const [r] = await this.db.$queryRaw<{ vesPerUsd: unknown; source: Source }[]>`
      SELECT "vesPerUsd", source FROM fx_rates WHERE date <= ${caracasDay(date)}::date
      ORDER BY date DESC, array_position(ARRAY['p2p_avg','market','bcv'], source) LIMIT 1`;
    return r ? { rate: Number(r.vesPerUsd), source: r.source } : null;
  }

  async upsert(date: Date, source: string, vesPerUsd: number): Promise<void> {
    const d = caracasDay(date);
    await this.db.fxRate.upsert({
      where: { date_source: { date: d, source } },
      create: { date: d, source, vesPerUsd },
      update: { vesPerUsd },
    });
  }

  onApplicationBootstrap() {
    void this.rate(new Date(), 'bcv').then((r) => { if (!r) return this.syncBcv(); }).catch(() => {});
    void this.syncMarket();
  }

  /** Market USDT/VES: median of top Binance P2P ads (public endpoint, not geo-blocked like /sapi), fallback dolarapi paralelo. */
  @Cron('0 */15 * * * *', { timeZone: TZ })
  async syncMarket(): Promise<void> {
    const p2p = async () => {
      const prices: number[] = [];
      for (const tradeType of ['BUY', 'SELL']) {
        const r = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
          body: JSON.stringify({ asset: 'USDT', fiat: 'VES', tradeType, page: 1, rows: 10, payTypes: [] }),
        });
        const j = (await r.json()) as any;
        prices.push(...(j?.data ?? []).map((a: any) => Number(a?.adv?.price)).filter((x: number) => x > 0));
      }
      return median(prices);
    };
    const paralelo = async () =>
      Number(((await (await fetch('https://ve.dolarapi.com/v1/dolares/paralelo', { signal: AbortSignal.timeout(15000) })).json()) as any)?.promedio);
    for (const t of [p2p, paralelo]) {
      const v = await t().catch((e) => (this.log.debug(`market: ${e}`), null));
      if (v && v > 0) return this.upsert(new Date(), 'market', v);
    }
    this.log.warn('market rate unavailable from all sources');
  }

  @Cron('0 30 9,17 * * *', { timeZone: TZ })
  async syncBcv(): Promise<void> {
    try {
      const v = await this.fetchBcv();
      if (v) await this.upsert(new Date(), 'bcv', v);
      else this.log.warn('BCV rate unavailable from all sources');
    } catch (e) {
      this.log.warn(`BCV sync failed: ${e}`);
    }
  }

  private async fetchBcv(): Promise<number | null> {
    const get = async (url: string) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`${url} ${r.status}`);
      return r;
    };
    const tries: (() => Promise<unknown>)[] = [
      async () => {
        const html = await (await get('https://www.bcv.org.ve/')).text();
        return html.match(/id="dolar"[\s\S]*?<strong>\s*([\d.,]+)\s*<\/strong>/)?.[1]?.replace(/\./g, '').replace(',', '.');
      },
      async () => ((await (await get('https://ve.dolarapi.com/v1/dolares/oficial')).json()) as any)?.promedio,
      async () => ((await (await get('https://pydolarve.org/api/v2/dollar?page=bcv')).json()) as any)?.monitors?.usd?.price,
    ];
    for (const t of tries) {
      const v = Number(await t().catch((e) => (this.log.debug(String(e)), null)));
      if (v > 0) return v;
    }
    return null;
  }
}
