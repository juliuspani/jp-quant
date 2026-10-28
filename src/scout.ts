import type { Config, ScoutConfig } from './config.ts';
import { log } from './log.ts';
import type { MarketData } from './market.ts';
import type { Store } from './store.ts';
import type { Candle, Position, Ticker24h } from './types.ts';
import { errMsg } from './util.ts';

// No son "monedas pequeñas volátiles": estables, oro tokenizado y versiones envueltas de otras monedas.
const NOT_TRADABLE = new Set([
  'USDT', 'USDC', 'BUSD', 'TUSD', 'DAI', 'FDUSD', 'USDP', 'USDD', 'PYUSD', 'USDE', 'USD1', 'RLUSD', 'XUSD', 'BFUSD',
  'EUR', 'EURI', 'AEUR', 'EURC', 'GBP', 'TRY', 'BRL', 'PAXG', 'XAUT', 'WBTC', 'WBETH', 'BNSOL', 'STETH', 'WETH',
]);

// Demasiado grandes para este módulo; las cubre (o podría cubrir) la estrategia núcleo.
const MAJORS = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'TRX', 'LTC', 'BCH', 'LINK', 'AVAX', 'DOT', 'TON', 'XLM']);

// Tokens apalancados de exchange: se degradan con el tiempo y no deben tocarse.
const LEVERAGED = /(UP|DOWN|BULL|BEAR|\d[LS])$/;

export interface ScoutCandidate {
  symbol: string;
  price: number;
  changePct: number;
  quoteVolume: number;
  relVolume: number;
  score: number;
}

export interface Confirmation {
  relVolume: number;
  breakout: boolean;
}

const LOOKBACK = 24;

/**
 * Confirma sobre velas de 1 h que la subida viene con ruptura y volumen:
 * la última vela cerrada es alcista, supera el máximo de las 24 anteriores
 * y su volumen multiplica la media de esas 24.
 */
export function confirmBreakout(candles: Candle[]): Confirmation | null {
  // Con menos de 48 h de historia el par es demasiado nuevo para evaluarlo.
  if (candles.length < LOOKBACK * 2) return null;
  const last = candles.at(-1)!;
  const prev = candles.slice(-1 - LOOKBACK, -1);
  const avgVol = prev.reduce((s, c) => s + c.volume, 0) / prev.length;
  if (!(avgVol > 0)) return null;
  const priorHigh = Math.max(...prev.map((c) => c.high));
  return { relVolume: last.volume / avgVol, breakout: last.close > last.open && last.close > priorHigh };
}

export interface ScoutAction {
  sellFraction?: number;
  reason?: string;
  stopPrice?: number;
  meta?: Record<string, unknown>;
}

/**
 * Gestión de una posición del explorador en cada tick (el stop duro lo vigila
 * el motor): recogida parcial de beneficios, después stop dinámico, y salida
 * por tiempo si la moneda no despega.
 */
export function manageScoutPosition(pos: Position, bid: number, now: number, cfg: ScoutConfig): ScoutAction {
  const tookProfit = pos.meta.tp1 === true;
  if (!tookProfit) {
    if (bid >= pos.entryPrice * (1 + cfg.takeProfitPct / 100)) {
      return {
        sellFraction: cfg.takeProfitFraction,
        reason: `toma parcial de beneficios (+${cfg.takeProfitPct}%)`,
        // El resto queda protegido justo por encima del precio de entrada para cubrir comisiones.
        stopPrice: Math.max(pos.stopPrice, pos.entryPrice * 1.004),
        meta: { tp1: true },
      };
    }
    if (now - pos.entryTs > cfg.maxHoldHours * 3_600_000) return { sellFraction: 1, reason: 'tiempo máximo en posición' };
    return {};
  }
  const trail = Math.max(pos.highestPrice, bid) * (1 - cfg.trailPct / 100);
  return trail > pos.stopPrice ? { stopPrice: trail } : {};
}

export class Scout {
  private cfg: ScoutConfig;
  private quote: string;
  private coreBases: Set<string>;
  private market: MarketData;
  private store: Store;

  constructor(cfg: Config, market: MarketData, store: Store) {
    this.cfg = cfg.scout;
    this.quote = cfg.quote;
    this.coreBases = new Set(cfg.core.symbols.map((s) => s.split('/')[0]!));
    this.market = market;
    this.store = store;
  }

  eligible(t: Ticker24h, held: Set<string>, now: number): boolean {
    const m = this.market.market(t.symbol);
    if (!m || !m.active || m.quote !== this.quote || t.symbol.includes(':')) return false;
    if (NOT_TRADABLE.has(m.base) || MAJORS.has(m.base) || this.coreBases.has(m.base) || LEVERAGED.test(m.base)) return false;
    if (this.cfg.exclude.includes(m.base) || this.cfg.exclude.includes(t.symbol)) return false;
    if (held.has(t.symbol)) return false;
    if (now < this.store.get(`scout.cooldown.${t.symbol}`, 0)) return false;
    if (t.quoteVolume < this.cfg.minQuoteVolume || t.quoteVolume > this.cfg.maxQuoteVolume) return false;
    if (t.changePct < this.cfg.minChange24hPct || t.changePct > this.cfg.maxChange24hPct) return false;
    const spreadPct = ((t.ask - t.bid) / t.ask) * 100;
    return spreadPct >= 0 && spreadPct <= this.cfg.maxSpreadPct;
  }

  /** Devuelve los candidatos confirmados, del mejor al peor. */
  async scan(now: number, held: Set<string>): Promise<ScoutCandidate[]> {
    const tickers = await this.market.tickers();
    const shortlist = tickers
      .filter((t) => this.eligible(t, held, now))
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 8);

    const out: ScoutCandidate[] = [];
    for (const t of shortlist) {
      try {
        const candles = await this.market.candles(t.symbol, '1h', LOOKBACK * 2 + 12);
        const c = confirmBreakout(candles);
        if (!c || !c.breakout || c.relVolume < this.cfg.relVolumeMin) continue;
        // Si el precio ya se ha caído de la ruptura, la señal ha caducado.
        if (t.ask < candles.at(-1)!.close * 0.98) continue;
        out.push({
          symbol: t.symbol,
          price: t.ask,
          changePct: t.changePct,
          quoteVolume: t.quoteVolume,
          relVolume: c.relVolume,
          score: c.relVolume * Math.log10(Math.max(t.quoteVolume, 10)),
        });
      } catch (e) {
        log('warn', 'scout', `No se pudo evaluar ${t.symbol}: ${errMsg(e)}`);
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  startCooldown(symbol: string, now: number): void {
    this.store.set(`scout.cooldown.${symbol}`, now + this.cfg.symbolCooldownHours * 3_600_000);
  }
}
