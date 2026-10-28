import ccxt from 'ccxt';
import type { Exchange } from 'ccxt';
import type { Config, Secrets } from './config.ts';
import type { Candle, MarketInfo, Quote, Ticker24h } from './types.ts';
import { tfToMs, withRetry } from './util.ts';

export interface MarketData {
  init(): Promise<void>;
  market(symbol: string): MarketInfo | null;
  symbols(): string[];
  /** Trunca la cantidad a la precisión que admite el exchange; 0 si queda por debajo del mínimo. */
  roundAmount(symbol: string, amount: number): number;
  /** Solo velas ya cerradas, de la más antigua a la más reciente. */
  candles(symbol: string, timeframe: string, limit: number, since?: number): Promise<Candle[]>;
  quotes(symbols: string[]): Promise<Map<string, Quote>>;
  tickers(): Promise<Ticker24h[]>;
}

const isNetworkError = (e: unknown) => e instanceof ccxt.NetworkError;

export function createExchange(cfg: Config, secrets: Secrets, withKeys: boolean): Exchange {
  const Cls = (ccxt as unknown as Record<string, new (o: object) => Exchange>)[cfg.exchange.id];
  if (!Cls) throw new Error(`Exchange no soportado por ccxt: ${cfg.exchange.id}`);
  const ex = new Cls({
    enableRateLimit: true,
    timeout: 20_000,
    options: { defaultType: 'spot', adjustForTimeDifference: true },
    ...(withKeys ? { apiKey: secrets.apiKey, secret: secrets.apiSecret, password: secrets.apiPassword } : {}),
  });
  if (cfg.exchange.sandbox) ex.setSandboxMode(true);
  return ex;
}

export class CcxtMarket implements MarketData {
  private ex: Exchange;

  constructor(ex: Exchange) {
    this.ex = ex;
  }

  async init(): Promise<void> {
    await withRetry(() => this.ex.loadMarkets(), { retryable: isNetworkError });
  }

  market(symbol: string): MarketInfo | null {
    const m = this.ex.markets?.[symbol];
    if (!m) return null;
    return {
      symbol,
      base: m.base,
      quote: m.quote,
      active: m.active !== false && m.spot === true,
      minAmount: m.limits?.amount?.min ?? 0,
      minCost: m.limits?.cost?.min ?? 0,
    };
  }

  symbols(): string[] {
    return Object.keys(this.ex.markets ?? {});
  }

  roundAmount(symbol: string, amount: number): number {
    try {
      return Number(this.ex.amountToPrecision(symbol, amount));
    } catch {
      return 0;
    }
  }

  async candles(symbol: string, timeframe: string, limit: number, since?: number): Promise<Candle[]> {
    const tfMs = tfToMs(timeframe);
    const raw = await withRetry(() => this.ex.fetchOHLCV(symbol, timeframe, since, limit + 1), { retryable: isNetworkError });
    const now = Date.now();
    return raw
      .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
      .filter((c) => c.ts + tfMs <= now && Number.isFinite(c.close))
      .sort((a, b) => a.ts - b.ts);
  }

  async quotes(symbols: string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    if (symbols.length === 0) return out;
    const tickers = await withRetry(() => this.ex.fetchTickers(symbols), { retryable: isNetworkError });
    for (const s of symbols) {
      const t = tickers[s];
      const last = Number(t?.last ?? t?.close);
      if (!t || !Number.isFinite(last) || last <= 0) continue;
      const bid = Number(t.bid);
      const ask = Number(t.ask);
      out.set(s, { last, bid: bid > 0 ? bid : last, ask: ask > 0 ? ask : last });
    }
    return out;
  }

  async tickers(): Promise<Ticker24h[]> {
    const all = await withRetry(() => this.ex.fetchTickers(), { retryable: isNetworkError });
    const out: Ticker24h[] = [];
    for (const [symbol, t] of Object.entries(all)) {
      const last = Number(t.last ?? t.close);
      const bid = Number(t.bid);
      const ask = Number(t.ask);
      if (!(last > 0)) continue;
      out.push({
        symbol,
        last,
        bid: bid > 0 ? bid : last,
        ask: ask > 0 ? ask : last,
        changePct: Number(t.percentage ?? 0),
        quoteVolume: Number(t.quoteVolume ?? 0),
      });
    }
    return out;
  }
}
