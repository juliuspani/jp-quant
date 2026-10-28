// Régimen de mercado (ARCHITECTURE.md §4.4; paso 26, ADR 0029): etiquetas point-in-time calculadas solo con precios de
// velas cerradas, sin datos macro. Cada etiqueta de la vela t usa las velas hasta t incluida y nada posterior; la prueba
// anti look-ahead lo comprueba truncando y alterando el futuro (test/src/analytics/regime.test.ts).
//
// Clasificador `regimen-precio@1`, con ventana fija como las features (ADR 0025), para que dé lo mismo en backtest y en
// real empiece donde empiece la historia:
// - Volatilidad: desviación típica de los últimos 30 log-retornos, situada entre sus 365 últimos valores (incluido el
//   actual): por debajo del percentil 25, BAJA; hasta el 75, NORMAL; hasta el 95, ALTA; desde ahí, EXTREMA.
// - Tendencia: cierre frente a la SMA de 200 y pendiente de esa SMA en 20 velas. Cierre sobre la SMA y SMA subiendo,
//   ALCISTA; cierre bajo la SMA y SMA bajando, BAJISTA; en otro caso, LATERAL.
// Las velas se cuentan en el timeframe de los datos. Sin historia suficiente, null. Una vela que falta se excluye y no
// vacía la ventana; cada etiqueta da null si a sus velas les faltan más de gapTolerance de su fórmula (ADR 0036).
import { gapTolerance, missingCandles } from '../features/gaps.ts';
import type { CandleWindow } from '../features/types.ts';
import type { Candle } from '../kernel/market-data.ts';
import type { RegimeView, TrendRegime, VolatilityRegime } from '../kernel/regime.ts';
import type { SymbolId } from '../shared/symbol.ts';
import { closeTimeOf, timeframeMs, toUtcIso, type Timeframe, type UtcMillis } from '../shared/time.ts';
import { AnalyticsError } from './performance.ts';

/** Velas que faltan entre la k-ésima vela observada contando desde la última y la última (ADR 0036). */
export type MissingIn = (k: number) => number;

export interface RegimeClassifier {
  readonly id: string;
  readonly warmupBars: number; // velas con las que ya da las dos etiquetas
  classify(window: CandleWindow, missingIn: MissingIn): Pick<RegimeView, 'volatility' | 'trend'>; // umbrales solo con lo que trae la ventana
}

export interface PriceRegimeParams {
  readonly volatilityWindow: number; // log-retornos de cada medida de volatilidad
  readonly volatilityHistory: number; // medidas con las que se calculan los percentiles
  readonly smaPeriod: number;
  readonly slopeBars: number;
}

export const PRICE_REGIME_V1: PriceRegimeParams = Object.freeze({ volatilityWindow: 30, volatilityHistory: 365, smaPeriod: 200, slopeBars: 20 });

function volatilityLabel(quantile: number): VolatilityRegime {
  if (quantile < 0.25) return 'BAJA';
  if (quantile < 0.75) return 'NORMAL';
  if (quantile < 0.95) return 'ALTA';
  return 'EXTREMA';
}

function volatilityOf(close: readonly number[], p: PriceRegimeParams, missingIn: MissingIn): VolatilityRegime | null {
  const n = p.volatilityWindow;
  const needed = n + p.volatilityHistory;
  if (close.length < needed || missingIn(needed) > gapTolerance(n)) return null;
  const c = close.slice(-needed);
  // Sumas acumuladas de los log-retornos y de sus cuadrados: cada medida es una ventana de n.
  const s1 = [0];
  const s2 = [0];
  for (let i = 1; i < c.length; i++) {
    const r = Math.log((c[i] ?? Number.NaN) / (c[i - 1] ?? Number.NaN));
    s1.push((s1.at(-1) ?? 0) + r);
    s2.push((s2.at(-1) ?? 0) + r * r);
  }
  const vols: number[] = [];
  for (let end = n; end < s1.length; end++) {
    const sum = (s1[end] ?? 0) - (s1[end - n] ?? 0);
    const sumSq = (s2[end] ?? 0) - (s2[end - n] ?? 0);
    vols.push(Math.sqrt(Math.max(0, (sumSq - (sum * sum) / n) / (n - 1))));
  }
  const current = vols.at(-1) ?? Number.NaN;
  if (!Number.isFinite(current)) return null;
  const below = vols.filter((v) => v < current).length;
  return volatilityLabel(below / (vols.length - 1));
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function trendOf(close: readonly number[], p: PriceRegimeParams, missingIn: MissingIn): TrendRegime | null {
  const needed = p.smaPeriod + p.slopeBars;
  if (close.length < needed || missingIn(needed) > gapTolerance(p.smaPeriod)) return null;
  const last = close.at(-1) ?? Number.NaN;
  const now = mean(close.slice(-p.smaPeriod));
  const before = mean(close.slice(-p.smaPeriod - p.slopeBars, -p.slopeBars));
  if (last > now && now > before) return 'ALCISTA';
  if (last < now && now < before) return 'BAJISTA';
  return 'LATERAL';
}

export function priceRegime(params: PriceRegimeParams = PRICE_REGIME_V1, id = 'regimen-precio@1'): RegimeClassifier {
  for (const [name, value] of Object.entries(params)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${id}: ${name} inválido (${String(value)})`);
  }
  if (params.volatilityWindow < 2 || params.volatilityHistory < 2) throw new RangeError(`${id}: hacen falta al menos 2 retornos y 2 medidas`);
  return Object.freeze({
    id,
    warmupBars: Math.max(params.volatilityWindow + params.volatilityHistory, params.smaPeriod + params.slopeBars),
    classify: (window: CandleWindow, missingIn: MissingIn) => ({
      volatility: volatilityOf(window.close, params, missingIn),
      trend: trendOf(window.close, params, missingIn),
    }),
  });
}

interface Bars {
  lastOpen: UtcMillis;
  readonly openTime: number[];
  readonly open: number[];
  readonly high: number[];
  readonly low: number[];
  readonly close: number[];
  readonly volume: number[];
}

/**
 * Régimen en línea, por símbolo: guarda las últimas warmupBars velas observadas y clasifica al cierre de cada una. Es el
 * mismo cálculo en backtest, en real y en el desglose de la investigación. Fail closed con una vela desordenada,
 * repetida, de otro timeframe o con un cierre no positivo.
 */
export class RegimeTracker {
  readonly #classifier: RegimeClassifier;
  readonly #timeframe: Timeframe;
  readonly #step: number;
  readonly #bars = new Map<SymbolId, Bars>();

  constructor(classifier: RegimeClassifier, timeframe: Timeframe) {
    this.#classifier = classifier;
    this.#timeframe = timeframe;
    this.#step = timeframeMs(timeframe);
  }

  onCandleClosed(candle: Candle): RegimeView {
    if (candle.timeframe !== this.#timeframe) throw new AnalyticsError(`${candle.symbol}: vela de ${candle.timeframe}, el régimen es de ${this.#timeframe}`);
    const close = candle.close.toAnalysis();
    if (!(close > 0) || !Number.isFinite(close)) throw new AnalyticsError(`${candle.symbol} ${toUtcIso(candle.openTime)}: cierre no positivo`);
    let bars = this.#bars.get(candle.symbol);
    if (bars !== undefined && candle.openTime <= bars.lastOpen) {
      throw new AnalyticsError(`${candle.symbol} ${toUtcIso(candle.openTime)}: vela repetida o desordenada para el régimen`);
    }
    if (bars === undefined) {
      bars = { lastOpen: candle.openTime, openTime: [], open: [], high: [], low: [], close: [], volume: [] };
      this.#bars.set(candle.symbol, bars);
    }
    // Tras un hueco la ventana sigue: la vela que falta se excluye, sin rellenar (ADR 0036).
    bars.lastOpen = candle.openTime;
    bars.openTime.push(candle.openTime);
    bars.open.push(candle.open.toAnalysis());
    bars.high.push(candle.high.toAnalysis());
    bars.low.push(candle.low.toAnalysis());
    bars.close.push(close);
    bars.volume.push(candle.volume.toAnalysis());
    if (bars.close.length > this.#classifier.warmupBars) for (const series of [bars.openTime, bars.open, bars.high, bars.low, bars.close, bars.volume]) series.shift();
    const asOf = closeTimeOf(candle.openTime, this.#timeframe);
    const { openTime } = bars;
    const missingIn: MissingIn = (k) => {
      const first = openTime[openTime.length - k];
      return first === undefined ? Number.POSITIVE_INFINITY : missingCandles(first, candle.openTime, k, this.#step); // fail closed
    };
    const labels = this.#classifier.classify({
      symbol: candle.symbol, timeframe: this.#timeframe, asOf, open: bars.open, high: bars.high, low: bars.low, close: bars.close, volume: bars.volume,
    }, missingIn);
    return Object.freeze({ scope: candle.symbol, timeframe: this.#timeframe, asOf, ...labels, classifierId: this.#classifier.id });
  }
}

/** Etiquetas de una serie de velas cerradas de un símbolo, en orden: una por vela, cada una solo con su pasado. */
export function regimeSeries(candles: readonly Candle[], classifier: RegimeClassifier, timeframe: Timeframe): readonly RegimeView[] {
  const tracker = new RegimeTracker(classifier, timeframe);
  return Object.freeze(candles.map((c) => tracker.onCandleClosed(c)));
}

/** Régimen vigente en `t`: el de la última vela cerrada en t o antes; null si no hay ninguna. */
export function regimeAt(series: readonly RegimeView[], t: UtcMillis): RegimeView | null {
  let lo = 0;
  let hi = series.length - 1;
  let found: RegimeView | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const view = series[mid];
    if (view !== undefined && view.asOf <= t) {
      found = view;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
