// Strategy Engine (ARCHITECTURE.md §4.1 y §8, paso 23). Arma la entrada de la estrategia con las features, la posición
// que ve la cartera y su propio estado (stop vigente y máximo desde la entrada), llama a evaluate y convierte la decisión
// en una intención para Risk: una entrada dimensionada por riesgo, con el stop pasado de float a Decimal al alza y al paso
// de precio (el stop de una venta se redondea hacia el mercado, exchange-execution §7), o una salida reduce_only de toda la
// posición. No envía nada, no conoce Risk ni Execution y no hace E/S.
// Una intención por símbolo cada vez: mientras la anterior no se resuelve (rechazo o orden terminal), ese símbolo no se
// evalúa. Así no salen dos ventas de la misma posición.
// Stops de protección (ARCHITECTURE.md §8, punto 8): con posición abierta, protectiveStop propone el stop como intención de
// sistema, y una sustitución cuando el stop sube. No bloquean el símbolo: el stop espera en el exchange mientras tanto.
// Polvo (paso 28): un resto por debajo del mínimo del mercado no se puede vender y la estrategia no lo ve como posición,
// pero conserva su stop mientras quede cantidad: si el precio sube y vuelve a ser vendible, sigue protegido. Una entrada
// nueva sobre ese resto lo lleva con el stop de la entrada nueva.
import type { FeatureVector } from '../features/types.ts';
import type { Instrument, MarketView } from '../kernel/market-data.ts';
import type { OrderIntent } from '../kernel/orders.ts';
import type { RegimeView } from '../kernel/regime.ts';
import type { PortfolioView, PositionSnapshot } from '../kernel/portfolio.ts';
import type { Ids } from '../kernel/random.ts';
import type { UtcMillis } from '../shared/time.ts';
import { Decimal, type Price } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { Bucket } from '../shared/trading.ts';
import type { PositionView, Strategy, StrategyDecision } from './types.ts';

export class StrategyStateError extends Error {
  override readonly name = 'StrategyStateError';
}

export interface StrategyEngineDeps<P> {
  readonly strategy: Strategy<P>;
  readonly params: P;
  readonly bucket: Bucket;
  readonly market: MarketView;
  readonly portfolio: PortfolioView;
  readonly ids: Ids;
}

export interface StrategyStep {
  readonly symbol: SymbolId;
  readonly decision: StrategyDecision | null; // null: no se evaluó
  readonly note: string | null; // por qué no se evaluó o por qué la decisión no da intención
  readonly intent: OrderIntent | null;
}

interface PositionState {
  readonly stopPrice: number;
  readonly highestPrice: number;
}

const STOP_SCALE = 18;

/** Stop de análisis a precio: al alza y al paso de precio. Un stop que no es un número positivo no se convierte. */
export function stopToPrice(stop: number, instrument: Instrument | null): Price | null {
  if (!Number.isFinite(stop) || stop <= 0) return null;
  const raw = Decimal.fromAnalysis(stop, STOP_SCALE, 'UP');
  return instrument === null ? raw : raw.roundToStep(instrument.priceStep, 'UP');
}

export class StrategyEngine<P> {
  readonly #deps: StrategyEngineDeps<P>;
  readonly #pending = new Set<SymbolId>();
  readonly #entryStops = new Map<SymbolId, number>(); // stop de una entrada que aún no tiene posición
  readonly #positions = new Map<SymbolId, PositionState>();

  constructor(deps: StrategyEngineDeps<P>) {
    const { strategy } = deps;
    if (strategy.id === '' || strategy.version === '') throw new RangeError('estrategia sin id o sin versión');
    if (!Number.isSafeInteger(strategy.warmupBars) || strategy.warmupBars < 1) throw new RangeError(`${strategy.id}: warmupBars inválido`);
    this.#deps = deps;
  }

  /** Hay una intención sin resolver para `symbol`. */
  isPending(symbol: SymbolId): boolean {
    return this.#pending.has(symbol);
  }

  /** La intención de `symbol` se resolvió: Risk o Execution la rechazaron, o su orden llegó a un estado terminal. */
  onIntentResolved(symbol: SymbolId): void {
    this.#pending.delete(symbol);
    if (!this.#holdsAny(symbol)) this.#entryStops.delete(symbol);
  }

  /**
   * Intención de stop de protección para `symbol`, o null: sin posición, sin stop conocido o si el que espera en el exchange
   * (`current`) ya está a esa altura o más arriba (el stop solo sube). Con `current` null es el primero; si no, una sustitución.
   * Un stop que no se puede colocar, porque el precio ya lo ha cruzado o porque su importe no llega al mínimo del mercado,
   * da en su lugar una salida urgente a mercado, `reduce_only`, que bloquea el símbolo como una salida de la estrategia
   * (trading-risk §2.4; paso 28): así la posición no se queda sin protección ni el stop se reintenta sin fin.
   */
  protectiveStop(symbol: SymbolId, current: Price | null, now: UtcMillis): OrderIntent | null {
    const held = this.#held(symbol);
    const stop = this.#positions.get(symbol)?.stopPrice ?? this.#entryStops.get(symbol) ?? null;
    if (held === null || stop === null || this.#pending.has(symbol)) return null;
    const instrument = this.#deps.market.instrument(symbol);
    const trigger = stopToPrice(stop, instrument);
    if (trigger === null || (current !== null && !trigger.gt(current))) return null;
    const { strategy, bucket, ids } = this.#deps;
    const bid = this.#deps.market.quote(symbol)?.bid ?? null;
    const crossed = bid !== null && !bid.gt(trigger);
    const belowMinimum = instrument !== null && held.quantity.times(trigger).lt(instrument.minNotional);
    if (crossed || belowMinimum) {
      this.#pending.add(symbol);
      return Object.freeze({
        intentId: ids.next(),
        origin: 'system',
        strategyId: strategy.id,
        strategyVersion: strategy.version,
        bucket,
        symbol,
        side: 'sell',
        kind: 'exit',
        reduceOnly: true,
        sizing: Object.freeze({ mode: 'all' }),
        stopPrice: null,
        reason: crossed
          ? `el precio ya cruzó el stop ${trigger.toString()}: salida urgente a mercado`
          : `el stop ${trigger.toString()} no llega al mínimo del mercado: salida urgente a mercado`,
        signalTime: now,
      });
    }
    return Object.freeze({
      intentId: ids.next(),
      origin: 'system',
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      bucket,
      symbol,
      side: 'sell',
      kind: current === null ? 'protective_stop' : 'stop_update',
      reduceOnly: true,
      sizing: Object.freeze({ mode: 'all' }),
      stopPrice: trigger,
      reason: current === null ? 'stop de protección de la posición' : `el stop sube de ${current.toString()} a ${trigger.toString()}`,
      signalTime: now,
    });
  }

  /** FeaturesComputed: evalúa la estrategia sobre la última vela cerrada del símbolo, con su régimen a esa misma vela. */
  onFeatures(vector: FeatureVector, regime: RegimeView | null): StrategyStep {
    const { strategy, params, market } = this.#deps;
    const { symbol } = vector;
    if (vector.featureSetId !== strategy.featureSet.id || vector.featureSetVersion !== strategy.featureSet.version) {
      throw new StrategyStateError(
        `${strategy.id}: features de ${vector.featureSetId}@${String(vector.featureSetVersion)}, ` +
          `la estrategia usa ${strategy.featureSet.id}@${String(strategy.featureSet.version)}`,
      );
    }
    if (regime !== null && (regime.scope !== symbol || regime.asOf !== vector.asOf)) {
      throw new StrategyStateError(`${strategy.id}: régimen de ${regime.scope} al ${String(regime.asOf)} para ${symbol} al ${String(vector.asOf)}`);
    }
    if (this.#pending.has(symbol)) return Object.freeze({ symbol, decision: null, note: 'intención anterior sin resolver', intent: null });

    const held = this.#held(symbol);
    const position = this.#positionView(symbol, held);
    const decision = strategy.evaluate({ asOf: vector.asOf, symbol, features: vector, regime, position, params });
    switch (decision.action) {
      case 'enter': {
        if (held !== null) return Object.freeze({ symbol, decision, note: 'entrada con la posición ya abierta: se ignora', intent: null });
        const intent = this.#intent(vector, decision.reason, 'entry', stopToPrice(decision.stopPrice, market.instrument(symbol)));
        this.#positions.delete(symbol); // un resto en polvo de la posición anterior pasa al stop de esta entrada
        this.#entryStops.set(symbol, decision.stopPrice);
        this.#pending.add(symbol);
        return Object.freeze({ symbol, decision, note: null, intent });
      }
      case 'exit': {
        if (held === null) return Object.freeze({ symbol, decision, note: 'salida sin posición: se ignora', intent: null });
        this.#pending.add(symbol);
        return Object.freeze({ symbol, decision, note: null, intent: this.#intent(vector, decision.reason, 'exit', null) });
      }
      case 'hold': {
        const state = this.#positions.get(symbol);
        const raised = decision.stopPrice;
        if (state !== undefined && raised !== undefined && Number.isFinite(raised) && raised > state.stopPrice) {
          this.#positions.set(symbol, Object.freeze({ ...state, stopPrice: raised })); // el stop solo sube
        }
        return Object.freeze({ symbol, decision, note: null, intent: null });
      }
    }
    throw new StrategyStateError(`${strategy.id}: decisión desconocida ${JSON.stringify(decision)}`);
  }

  /** Posición abierta y vendible de `symbol`, o null. El polvo no cuenta como posición. */
  #held(symbol: SymbolId): PositionSnapshot | null {
    const position = this.#deps.portfolio.snapshot().positions.find((p) => p.symbol === symbol);
    return position !== undefined && position.quantity.isPositive() && position.dust.isZero() ? position : null;
  }

  /** Queda algo de `symbol` en cartera, aunque sea polvo: mientras tanto su stop no se olvida. */
  #holdsAny(symbol: SymbolId): boolean {
    return this.#deps.portfolio.snapshot().positions.some((p) => p.symbol === symbol && p.quantity.isPositive());
  }

  #positionView(symbol: SymbolId, held: PositionSnapshot | null): PositionView | null {
    if (held === null) {
      if (!this.#holdsAny(symbol)) this.#positions.delete(symbol);
      return null;
    }
    const bid = this.#deps.market.quote(symbol)?.bid.toAnalysis() ?? null;
    let state = this.#positions.get(symbol);
    if (state === undefined) {
      const stop = this.#entryStops.get(symbol);
      if (stop === undefined) throw new StrategyStateError(`${symbol}: posición abierta sin el stop de su entrada`);
      state = { stopPrice: stop, highestPrice: held.averageEntry.toAnalysis() };
      this.#entryStops.delete(symbol);
    }
    if (bid !== null && bid > state.highestPrice) state = { ...state, highestPrice: bid };
    this.#positions.set(symbol, Object.freeze(state));
    return Object.freeze({
      quantity: held.quantity.toAnalysis(),
      entryPrice: held.averageEntry.toAnalysis(),
      stopPrice: state.stopPrice,
      highestPrice: state.highestPrice,
    });
  }

  #intent(vector: FeatureVector, reason: string, kind: 'entry' | 'exit', stopPrice: Price | null): OrderIntent {
    const { strategy, bucket, ids } = this.#deps;
    const entry = kind === 'entry';
    return Object.freeze({
      intentId: ids.next(),
      origin: 'strategy',
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      bucket,
      symbol: vector.symbol,
      side: entry ? 'buy' : 'sell',
      kind,
      reduceOnly: !entry,
      sizing: entry ? Object.freeze({ mode: 'risk' }) : Object.freeze({ mode: 'all' }),
      stopPrice,
      reason,
      signalTime: vector.asOf,
    });
  }
}
