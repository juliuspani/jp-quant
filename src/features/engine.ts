// Feature Engine (ARCHITECTURE.md §4.1 y §16.4, ADR 0025). Recibe velas cerradas en orden de received_time y calcula
// un FeatureVector por vela. Es el mismo cálculo en backtest y en real: cada feature lee solo sus últimas warmupBars
// velas observadas. No hace E/S, no publica eventos y no conoce órdenes: devuelve números.
//
// Timestamp: el cálculo ocurre en el received_time de la vela que lo dispara (computedAt) y solo usa velas con
// received_time ≤ computedAt, porque llegan en ese orden y el motor rechaza las que no.
//
// Datos que faltan (ADR 0036): una vela que falta se excluye, nunca se rellena (quant-research §3), y no vacía la
// ventana. Una feature da null si a sus warmupBars velas les faltan más de gapTolerance(window). Un resultado no finito
// también da null.
// Fail closed: una vela que incumple el contrato (desordenada, repetida, recibida antes de cerrar o con valores
// imposibles) lanza FeatureInputError. Filtrarlas es del normalizador de marketdata/, no de este motor.
import type { Candle } from '../kernel/market-data.ts';
import type { SymbolId } from '../shared/symbol.ts';
import { closeTimeOf, timeframeMs, toUtcIso, type UtcMillis } from '../shared/time.ts';
import { gapTolerance, missingCandles } from './gaps.ts';
import type { CandleWindow, FeatureSet, FeatureVector } from './types.ts';

export class FeatureInputError extends Error {
  override readonly name = 'FeatureInputError';
}

interface Bar {
  readonly openTime: UtcMillis;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

function checkSet(set: FeatureSet): number {
  if (set.features.length === 0) throw new RangeError(`${set.id}: conjunto de features vacío`);
  timeframeMs(set.timeframe);
  const ids = new Set<string>();
  let capacity = 0;
  for (const f of set.features) {
    if (ids.has(f.id)) throw new RangeError(`${set.id}: feature repetida ${f.id}`);
    ids.add(f.id);
    if (!Number.isSafeInteger(f.window) || f.window < 1) throw new RangeError(`${f.id}: ventana inválida ${String(f.window)}`);
    if (!Number.isSafeInteger(f.warmupBars) || f.warmupBars < f.window) {
      throw new RangeError(`${f.id}: warmupBars ${String(f.warmupBars)} menor que la ventana ${String(f.window)}`);
    }
    if (f.formula.trim() === '' || f.missingData.trim() === '') throw new RangeError(`${f.id}: sin fórmula o sin política de datos que faltan`);
    capacity = Math.max(capacity, f.warmupBars);
  }
  return capacity;
}

function toBar(candle: Candle): Bar {
  const bar = {
    openTime: candle.openTime,
    open: candle.open.toAnalysis(),
    high: candle.high.toAnalysis(),
    low: candle.low.toAnalysis(),
    close: candle.close.toAnalysis(),
    volume: candle.volume.toAnalysis(),
  };
  const prices = [bar.open, bar.high, bar.low, bar.close];
  const valid =
    prices.every((p) => Number.isFinite(p) && p > 0) &&
    Number.isFinite(bar.volume) &&
    bar.volume >= 0 &&
    bar.high >= Math.max(bar.open, bar.close, bar.low) &&
    bar.low <= Math.min(bar.open, bar.close);
  if (!valid) throw new FeatureInputError(`${candle.symbol} ${toUtcIso(candle.openTime)}: valores imposibles en la vela`);
  return bar;
}

function windowOf(symbol: SymbolId, set: FeatureSet, bars: readonly Bar[], asOf: UtcMillis): CandleWindow {
  return Object.freeze({
    symbol,
    timeframe: set.timeframe,
    asOf,
    open: Object.freeze(bars.map((b) => b.open)),
    high: Object.freeze(bars.map((b) => b.high)),
    low: Object.freeze(bars.map((b) => b.low)),
    close: Object.freeze(bars.map((b) => b.close)),
    volume: Object.freeze(bars.map((b) => b.volume)),
  });
}

export class FeatureEngine {
  readonly #set: FeatureSet;
  readonly #capacity: number;
  readonly #step: number;
  readonly #bars = new Map<SymbolId, Bar[]>();
  #lastReceived: UtcMillis | null = null;

  constructor(set: FeatureSet) {
    this.#capacity = checkSet(set);
    this.#set = set;
    this.#step = timeframeMs(set.timeframe);
  }

  /** Procesa una vela cerrada recibida en `receivedTime` y devuelve las features de su símbolo en ese instante. */
  onCandleClosed(candle: Candle, receivedTime: UtcMillis): FeatureVector {
    const where = `${candle.symbol} ${toUtcIso(candle.openTime)}`;
    if (candle.timeframe !== this.#set.timeframe) {
      throw new FeatureInputError(`${where}: timeframe ${candle.timeframe}, el conjunto es de ${this.#set.timeframe}`);
    }
    if (candle.closeTime !== closeTimeOf(candle.openTime, candle.timeframe)) throw new FeatureInputError(`${where}: cierre incoherente con la apertura`);
    toUtcIso(receivedTime);
    if (receivedTime < candle.closeTime) throw new FeatureInputError(`${where}: recibida antes de cerrar, sería look-ahead`);
    if (this.#lastReceived !== null && receivedTime < this.#lastReceived) {
      throw new FeatureInputError(`${where}: received_time anterior al de la vela previa; el motor exige orden de llegada`);
    }
    const bar = toBar(candle);
    const bars = this.#bars.get(candle.symbol) ?? [];
    const previous = bars.at(-1);
    if (previous !== undefined && candle.openTime <= previous.openTime) throw new FeatureInputError(`${where}: vela repetida o desordenada`);
    bars.push(bar); // tras un hueco, la ventana sigue: la vela que falta se excluye (ADR 0036)
    if (bars.length > this.#capacity) bars.shift();
    this.#bars.set(candle.symbol, bars);
    this.#lastReceived = receivedTime;

    const values: Record<string, number | null> = {};
    for (const f of this.#set.features) {
      const used = bars.slice(-f.warmupBars);
      const first = used[0];
      if (used.length < f.warmupBars || first === undefined || missingCandles(first.openTime, bar.openTime, used.length, this.#step) > gapTolerance(f.window)) {
        values[f.id] = null;
        continue;
      }
      const value = f.compute(windowOf(candle.symbol, this.#set, used, candle.closeTime));
      values[f.id] = value !== null && Number.isFinite(value) ? value : null;
    }
    return Object.freeze({
      symbol: candle.symbol,
      timeframe: this.#set.timeframe,
      asOf: candle.closeTime,
      computedAt: receivedTime,
      featureSetId: this.#set.id,
      featureSetVersion: this.#set.version,
      values: Object.freeze(values),
    });
  }
}
