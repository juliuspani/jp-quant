// Venue simulado del backtest (ARCHITECTURE.md §14, ADR 0026): el mismo puerto ExecutionVenue que usarán ShadowVenue y
// LiveVenue, así que Execution no sabe con cuál habla. Es lo único del camino de la orden que cambia en el backtest,
// junto con el reloj y la fuente de datos.
//
// Cómo responde, como un exchange:
// - Nada es síncrono. Cada petición llega al venue tras la latencia de ida y su resultado vuelve tras la de vuelta,
//   como un temporizador del reloj (TimerFired en el replay). Quien compone enruta esos temporizadores a onTimer().
// - Al llegar, una orden a mercado se valida con las reglas del mercado (rechazos), recorre el libro real si lo hay y
//   está al día, o el sintético de la vela de ejecución (book-model.ts), y paga comisión y slippage en cada fill. Lo que
//   no cabe en la liquidez caduca (EXPIRED con la parte ejecutada), como una orden a mercado real.
// - Respeta expiresAt: una orden que llega tarde caduca sin ejecutarse.
// - Lleva su propia cuenta (caja y saldos): una orden sin saldo se rechaza por saldo insuficiente, que Execution trata
//   como una duda (exchange-execution §3.1).
// - Órdenes a mercado y stops de protección de venta a mercado. Un stop espera en el exchange con su saldo bloqueado;
//   al cerrar cada vela se comprueba con sellTrigger (intrabar.ts): hueco desde la apertura, toque desde el stop y,
//   si en la vela se tocan stop y objetivo, primero el stop. Límite y stop-limit, paso 36.
import type { Clock } from '../kernel/clock.ts';
import type {
  AccountSnapshot,
  CancelOrder,
  ExecutionVenue,
  Fill,
  SubmitOrder,
  VenueOrderUpdate,
  VenueRequestFailed,
} from '../kernel/execution.ts';
import type { BookSnapshot, Instrument } from '../kernel/market-data.ts';
import type { Ids } from '../kernel/random.ts';
import { Decimal, type Price, type Quantity } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import { addMs, closeTimeOf, floorToTimeframe, toUtcIso, type UtcMillis } from '../shared/time.ts';
import { checkDepthModel, syntheticBook, walkBook, type DepthModel } from './book-model.ts';
import type { VenueMarket } from './candle-tape.ts';
import type { ExecutionCosts } from './costs.ts';
import { checkInstrumentRules, instrumentFor, quantityStepFor, type InstrumentRules } from './instrument-model.ts';
import { sellTrigger, type Trigger } from './intrabar.ts';

export interface VenueLatency {
  readonly orderMs: number; // del sistema al venue
  readonly responseMs: number; // del venue al sistema
}

// Conservadoras para una API REST desde Europa (ADR 0026). Con velas de una hora apenas mueven el precio; lo que
// cambian es si una orden llega antes de su expiresAt.
export const DEFAULT_VENUE_LATENCY: VenueLatency = Object.freeze({ orderMs: 1000, responseMs: 1000 });
/** Un libro más antiguo no se usa: trading-risk §4.6. */
export const MAX_BOOK_AGE_MS = 60_000;
const FEE_SCALE = 8; // la comisión se redondea al alza a 8 decimales
const PRICE_SCALE = 18;
const MAX_LATENCY_MS = 60_000;

export interface VenueSinks {
  update(update: VenueOrderUpdate): void;
  failure(failure: VenueRequestFailed): void;
  snapshot(snapshot: AccountSnapshot): void;
}

export interface SimulatedVenueConfig {
  readonly clock: Clock;
  readonly ids: Ids; // temporizadores, órdenes y trades, con semilla
  readonly market: VenueMarket;
  readonly rules: InstrumentRules;
  readonly costs: ExecutionCosts; // ya multiplicados por el estrés
  readonly depth: DepthModel; // el impacto por nivel, sin multiplicar: el venue le aplica el estrés
  readonly latency: VenueLatency;
  readonly quoteCurrency: string;
  readonly startingCash: Decimal;
  readonly sinks: VenueSinks;
}

/** Cómo terminó cada orden en el venue, para el informe. */
export type VenueOutcome = 'filled' | 'partial' | 'no_liquidity' | 'expired_ttl' | 'rejected' | 'insufficient_funds';
export type LiquiditySource = 'book' | 'synthetic' | 'none';

export interface OutcomeRecord {
  readonly clientOrderId: string;
  readonly at: UtcMillis;
  readonly outcome: VenueOutcome;
  readonly liquidity: LiquiditySource;
  readonly detail: string;
  readonly reference: string | null; // precio de referencia de lo ejecutado (apertura, punto medio o disparo del stop); null sin fills
}

/** Supuestos del modelo de ejecución y su uso, para declararlos en el informe. */
export interface ExecutionModelReport {
  readonly bookData: boolean; // si alguna orden se ejecutó contra un libro real
  readonly declaration: string;
  readonly referencePrice: string;
  readonly costs: { readonly commission: string; readonly halfSpread: string; readonly minSlippage: string; readonly multiplier: string };
  readonly depth: { readonly participation: string; readonly levels: number; readonly impactPerLevel: string };
  readonly latency: { readonly orderMs: number; readonly responseMs: number };
  readonly rules: { readonly priceSignificantDigits: number; readonly quantityDecimals: number; readonly minNotional: string };
  readonly orders: Readonly<Record<VenueOutcome | 'total' | 'withBook' | 'synthetic', number>>;
}

interface VenueOrder {
  readonly order: SubmitOrder;
  readonly exchangeOrderId: string;
  readonly status: VenueOrderUpdate['status'];
  readonly filled: Quantity;
  readonly averagePrice: Price | null;
  readonly fills: readonly Fill[];
  readonly updatedAt: UtcMillis;
}

const ZERO = Decimal.parse('0');
const ONE = Decimal.parse('1');
const TWO = Decimal.parse('2');

function checkLatency(latency: VenueLatency): void {
  for (const [name, ms] of [['orderMs', latency.orderMs], ['responseMs', latency.responseMs]] as const) {
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_LATENCY_MS) {
      throw new RangeError(`latencia ${name} inválida: ${String(ms)} (entero de 0 a ${String(MAX_LATENCY_MS)} ms)`);
    }
  }
}

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), ZERO);
}

function sortedLevels(levels: BookSnapshot['asks'], better: (a: Price, b: Price) => boolean): boolean {
  let previous: Price | null = null;
  for (const level of levels) {
    if (!level.price.isPositive() || !level.quantity.isPositive()) return false;
    if (previous !== null && !better(previous, level.price)) return false;
    previous = level.price;
  }
  return true;
}

/** Libro utilizable en `at`: al día, con precios y cantidades positivos y cada lado ordenado del mejor al peor. */
export function usableBook(book: BookSnapshot | null, at: UtcMillis): BookSnapshot | null {
  if (book === null || book.receivedTime > at || addMs(book.receivedTime, MAX_BOOK_AGE_MS) < at) return null;
  const okAsks = sortedLevels(book.asks, (a, b) => a.lt(b));
  const okBids = sortedLevels(book.bids, (a, b) => a.gt(b));
  const bestAsk = book.asks[0];
  const bestBid = book.bids[0];
  const crossed = bestAsk !== undefined && bestBid !== undefined && !bestBid.price.lt(bestAsk.price);
  return okAsks && okBids && !crossed && (bestAsk !== undefined || bestBid !== undefined) ? book : null;
}

export class SimulatedVenue implements ExecutionVenue {
  readonly #cfg: SimulatedVenueConfig;
  readonly #depth: DepthModel; // con el estrés aplicado
  readonly #quantityStep: Quantity;
  readonly #pending = new Map<string, () => void>();
  readonly #orders = new Map<string, VenueOrder>();
  readonly #balances = new Map<string, Decimal>();
  readonly #fills: Fill[] = [];
  readonly #outcomes: OutcomeRecord[] = [];
  readonly #resting = new Map<string, { readonly order: SubmitOrder; readonly trigger: Price; readonly armedAt: UtcMillis }>();
  readonly #locked = new Map<string, Decimal>(); // saldo bloqueado por las órdenes que esperan, por moneda
  #watching = false;

  constructor(config: SimulatedVenueConfig) {
    checkInstrumentRules(config.rules);
    checkDepthModel(config.depth);
    checkLatency(config.latency);
    if (config.quoteCurrency === '' || config.startingCash.isNegative()) throw new RangeError('moneda de cotización vacía o caja negativa');
    this.#cfg = config;
    this.#depth = Object.freeze({ ...config.depth, impactPerLevel: config.depth.impactPerLevel.times(config.costs.multiplier) });
    this.#quantityStep = quantityStepFor(config.rules.quantityDecimals);
    this.#balances.set(config.quoteCurrency, config.startingCash);
  }

  submit(order: SubmitOrder): void {
    this.#later(this.#cfg.latency.orderMs, () => {
      this.#arrive(order);
    });
  }

  cancel(order: CancelOrder): void {
    this.#later(this.#cfg.latency.orderMs, () => {
      const known = this.#orders.get(order.clientOrderId);
      const resting = this.#resting.get(order.clientOrderId);
      if (known !== undefined && resting !== undefined) {
        // Un stop que espera se cancela y libera su saldo.
        this.#resting.delete(order.clientOrderId);
        this.#lock(resting.order, false);
        this.#respond([this.#update(this.#record(resting.order, 'canceled', [], known.exchangeOrderId), 'rest', [])]);
        return;
      }
      // Una orden a mercado ya terminó cuando llega la cancelación: se devuelve su estado final.
      if (known === undefined) this.#fail('cancel', order.clientOrderId, 'order_not_found', 'orden desconocida al cancelar');
      else this.#respond([this.#update(known, 'rest', known.fills)]);
    });
  }

  queryOrder(clientOrderId: string): void {
    this.#later(this.#cfg.latency.orderMs, () => {
      const known = this.#orders.get(clientOrderId);
      if (known === undefined) this.#fail('query', clientOrderId, 'order_not_found', 'orden desconocida');
      else this.#respond([this.#update(known, 'rest', known.fills)]);
    });
  }

  requestAccountSnapshot(fillsSince: UtcMillis | null): void {
    this.#later(this.#cfg.latency.orderMs, () => {
      const snapshot: AccountSnapshot = Object.freeze({
        balances: Object.freeze(this.balances()),
        orders: Object.freeze([...this.#orders.values()].map((o) => this.#update(o, 'reconciliation', []))),
        fills: Object.freeze(this.#fills.filter((f) => fillsSince === null || f.exchangeTime >= fillsSince)),
        exchangeTime: this.#cfg.clock.now(),
      });
      this.#later(this.#cfg.latency.responseMs, () => {
        this.#cfg.sinks.snapshot(snapshot);
      });
    });
  }

  /** Ejecuta un temporizador propio. Devuelve false si no es suyo. */
  onTimer(timerId: string): boolean {
    const action = this.#pending.get(timerId);
    if (action === undefined) return false;
    this.#pending.delete(timerId);
    action();
    return true;
  }

  /** Saldos por moneda, como los ve el exchange. */
  balances(): Record<string, Decimal> {
    return Object.fromEntries([...this.#balances.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  outcomes(): readonly OutcomeRecord[] {
    return Object.freeze([...this.#outcomes]);
  }

  /** Lo que el informe tiene que declarar: supuestos, costes y cuántas órdenes se simularon con cada fuente de liquidez. */
  report(): ExecutionModelReport {
    const { costs, latency, rules } = this.#cfg;
    const count = (predicate: (r: OutcomeRecord) => boolean): number => this.#outcomes.filter(predicate).length;
    const withBook = count((r) => r.liquidity === 'book');
    const synthetic = count((r) => r.liquidity === 'synthetic');
    const declaration =
      withBook > 0 && synthetic === 0
        ? 'Libro de órdenes real en todas las órdenes ejecutadas, más el slippage mínimo por fill.'
        : `Sin datos de libro de órdenes${withBook > 0 ? ' en parte de las órdenes' : ''}: modelo sintético conservador. ` +
          `Profundidad por lado del ${this.#depth.participation.toString()} del volumen de la vela de ejecución en ` +
          `${String(this.#depth.levels)} niveles, con un impacto de ${this.#depth.impactPerLevel.toString()} por nivel; ` +
          `medio spread de ${costs.halfSpread.toString()} y slippage mínimo de ${costs.minSlippage.toString()} en cada fill. ` +
          'Sin operaciones en el intervalo de llegada, la orden caduca sin ejecutarse.';
    const stops =
      ' Stops de protección: esperan en el exchange y se comprueban al cierre de cada vela; si la vela abre más allá del stop, ' +
      'se venden desde la apertura; si su mínimo lo toca, desde el precio del stop; con stop y objetivo en la misma vela, ' +
      'primero el stop. Encima se cobran medio spread, slippage y comisión.';
    return Object.freeze({
      bookData: withBook > 0,
      declaration: `${declaration}${stops}`,
      referencePrice:
        'Apertura de la vela que contiene la llegada de la orden (la siguiente a la de la decisión, quant-research §3); ' +
        'con libro, su punto medio.',
      costs: {
        commission: costs.commission.toString(),
        halfSpread: costs.halfSpread.toString(),
        minSlippage: costs.minSlippage.toString(),
        multiplier: costs.multiplier.toString(),
      },
      depth: { participation: this.#depth.participation.toString(), levels: this.#depth.levels, impactPerLevel: this.#depth.impactPerLevel.toString() },
      latency: { orderMs: latency.orderMs, responseMs: latency.responseMs },
      rules: { priceSignificantDigits: rules.priceSignificantDigits, quantityDecimals: rules.quantityDecimals, minNotional: rules.minNotional.toString() },
      orders: Object.freeze({
        total: this.#outcomes.length,
        withBook,
        synthetic,
        filled: count((r) => r.outcome === 'filled'),
        partial: count((r) => r.outcome === 'partial'),
        no_liquidity: count((r) => r.outcome === 'no_liquidity'),
        expired_ttl: count((r) => r.outcome === 'expired_ttl'),
        rejected: count((r) => r.outcome === 'rejected'),
        insufficient_funds: count((r) => r.outcome === 'insufficient_funds'),
      }),
    });
  }

  #later(ms: number, action: () => void): void {
    const timerId = this.#cfg.ids.next();
    if (this.#pending.has(timerId)) throw new Error(`temporizador del venue repetido: ${timerId}`);
    this.#pending.set(timerId, action);
    this.#cfg.clock.schedule(addMs(this.#cfg.clock.now(), ms), timerId);
  }

  #respond(updates: readonly VenueOrderUpdate[]): void {
    this.#later(this.#cfg.latency.responseMs, () => {
      for (const update of updates) this.#cfg.sinks.update(update);
    });
  }

  #fail(operation: VenueRequestFailed['operation'], clientOrderId: string, errorClass: VenueRequestFailed['errorClass'], detail: string): void {
    const failure: VenueRequestFailed = Object.freeze({ operation, clientOrderId, errorClass, reasonCode: null, retryAfter: null, detail });
    this.#later(this.#cfg.latency.responseMs, () => {
      this.#cfg.sinks.failure(failure);
    });
  }

  #outcome(order: SubmitOrder, outcome: VenueOutcome, liquidity: LiquiditySource, detail: string, reference: Price | null = null): void {
    this.#outcomes.push(Object.freeze({ clientOrderId: order.clientOrderId, at: this.#cfg.clock.now(), outcome, liquidity, detail, reference: reference?.toString() ?? null }));
  }

  #reject(order: SubmitOrder, code: string, detail: string): void {
    this.#outcome(order, 'rejected', 'none', code);
    this.#fail('submit', order.clientOrderId, 'rejected', `${code}: ${detail}`);
  }

  #update(order: VenueOrder, origin: VenueOrderUpdate['origin'], fills: readonly Fill[], status = order.status): VenueOrderUpdate {
    return Object.freeze({
      clientOrderId: order.order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
      status,
      filled: order.filled,
      averagePrice: order.averagePrice,
      fills: Object.freeze([...fills]),
      exchangeRejectCode: null,
      origin,
      exchangeTime: order.updatedAt,
    });
  }

  #record(order: SubmitOrder, status: VenueOrderUpdate['status'], fills: readonly Fill[], exchangeOrderId?: string): VenueOrder {
    const filled = sum(fills.map((f) => f.quantity));
    const averagePrice = filled.isPositive() ? sum(fills.map((f) => f.quantity.times(f.price))).div(filled, PRICE_SCALE, 'HALF_EVEN') : null;
    const record: VenueOrder = Object.freeze({
      order,
      exchangeOrderId: exchangeOrderId ?? this.#cfg.ids.next(),
      status,
      filled,
      averagePrice,
      fills: Object.freeze([...fills]),
      updatedAt: this.#cfg.clock.now(),
    });
    this.#orders.set(order.clientOrderId, record);
    return record;
  }

  #arrive(order: SubmitOrder): void {
    const now = this.#cfg.clock.now();
    const { symbol, side, quantity } = order;
    if (this.#orders.has(order.clientOrderId)) {
      this.#reject(order, 'DUPLICATE_CLIENT_ORDER_ID', 'client order ID ya usado');
      return;
    }
    if (order.expiresAt !== null && now > order.expiresAt) {
      this.#outcome(order, 'expired_ttl', 'none', `llegó en ${toUtcIso(now)}, caducaba en ${toUtcIso(order.expiresAt)}`);
      this.#respond([this.#update(this.#record(order, 'expired', []), 'rest', [])]);
      return;
    }
    const listed = this.#cfg.market.listed(symbol, now);
    if (listed === null) return this.#reject(order, 'SYMBOL_UNKNOWN', symbol);
    if (!listed) return this.#reject(order, 'SYMBOL_NOT_TRADING', `${symbol} no se negocia en ${toUtcIso(now)}`);
    const stop = order.type === 'stop_market';
    if (order.type !== 'market' && !stop) return this.#reject(order, 'ORDER_TYPE_NOT_SUPPORTED', `${order.type}: el simulador ejecuta órdenes a mercado y stops a mercado`);
    if (order.limitPrice !== null || (order.triggerPrice !== null) !== stop) return this.#reject(order, 'INVALID_PRICE', 'solo un stop lleva precio, y es el de disparo');
    const step = this.#quantityStep;
    if (!quantity.isPositive() || !quantity.roundToStep(step, 'DOWN').eq(quantity)) {
      return this.#reject(order, 'LOT_SIZE', `${quantity.toString()} no es un múltiplo positivo de ${step.toString()}`);
    }
    if (stop) {
      this.#arm(order);
      return;
    }

    const book = usableBook(this.#cfg.market.book(symbol, now), now);
    const bar = book === null ? this.#cfg.market.executionBar(symbol, now) : null;
    const reference = book !== null ? this.#mid(book) : (bar?.open ?? null);
    if (reference === null) {
      this.#outcome(order, 'no_liquidity', 'none', 'sin operaciones en el intervalo de llegada ni libro');
      this.#respond([this.#update(this.#record(order, 'expired', []), 'rest', [])]);
      return;
    }
    const instrument = instrumentFor(symbol, reference, this.#cfg.rules, true, now);
    if (quantity.times(reference).lt(instrument.minNotional)) {
      return this.#reject(order, 'MIN_NOTIONAL', `${quantity.times(reference).toString()} < ${instrument.minNotional.toString()} ${instrument.quote}`);
    }
    const liquidity: LiquiditySource = book !== null ? 'book' : 'synthetic';
    const levels = book ?? (bar === null ? null : syntheticBook(symbol, bar.open, bar.volume, instrument, this.#cfg.costs.halfSpread, this.#depth, now));
    if (levels === null) throw new Error('sin libro ni vela tras comprobar la referencia');
    const matched = walkBook(levels, side, quantity, instrument, this.#cfg.costs.minSlippage);
    if (matched.length === 0) {
      this.#outcome(order, 'no_liquidity', liquidity, 'el lado contrario del libro está vacío');
      this.#respond([this.#update(this.#record(order, 'expired', []), 'rest', [])]);
      return;
    }
    const fees = matched.map((m) => m.quantity.times(m.price).times(this.#cfg.costs.commission).roundToScale(FEE_SCALE, 'UP'));
    const notional = sum(matched.map((m) => m.quantity.times(m.price)));
    const funds = this.#fundsProblem(instrument, side, quantity, notional.plus(sum(fees)));
    if (funds !== null) {
      this.#outcome(order, 'insufficient_funds', liquidity, funds);
      this.#fail('submit', order.clientOrderId, 'insufficient_funds', funds);
      return;
    }

    const fills: Fill[] = matched.map((m, i) =>
      Object.freeze({
        tradeId: this.#cfg.ids.next(),
        clientOrderId: order.clientOrderId,
        symbol,
        side,
        quantity: m.quantity,
        price: m.price,
        fee: fees[i] ?? ZERO,
        feeCurrency: instrument.quote,
        feeEstimated: false,
        exchangeTime: now,
      }),
    );
    this.#settle(instrument, side, fills);
    const filled = sum(fills.map((f) => f.quantity));
    if (filled.eq(quantity)) {
      this.#outcome(order, 'filled', liquidity, `${String(fills.length)} fills`, reference);
      this.#respond([this.#update(this.#record(order, 'filled', fills), 'rest', fills)]);
      return;
    }
    // Lo que no cabe en la liquidez caduca, como el resto de una orden a mercado real.
    this.#outcome(order, 'partial', liquidity, `${filled.toString()} de ${quantity.toString()}`, reference);
    const record = this.#record(order, 'expired', fills);
    this.#respond([this.#update(record, 'rest', fills, 'partially_filled'), this.#update(record, 'rest', [])]);
  }

  #mid(book: BookSnapshot): Price | null {
    const ask = book.asks[0]?.price ?? null;
    const bid = book.bids[0]?.price ?? null;
    if (ask === null || bid === null) return ask ?? bid;
    return ask.plus(bid).div(TWO, PRICE_SCALE, 'HALF_EVEN');
  }

  #fundsProblem(instrument: Instrument, side: SubmitOrder['side'], quantity: Quantity, cost: Decimal): string | null {
    if (side === 'buy') {
      const cash = this.#balances.get(instrument.quote) ?? ZERO;
      return cost.gt(cash) ? `coste ${cost.toString()} > saldo ${cash.toString()} ${instrument.quote}` : null;
    }
    // Una venta bloquea en el exchange toda su cantidad, no solo la que se llega a ejecutar; lo que ya bloquea un stop
    // que espera no está libre.
    const held = (this.#balances.get(instrument.base) ?? ZERO).minus(this.#locked.get(instrument.base) ?? ZERO);
    return quantity.gt(held) ? `venta de ${quantity.toString()} > saldo ${held.toString()} ${instrument.base}` : null;
  }

  /** Stop de venta que espera (exchange-execution §6 y trading-risk §2.4): se valida, bloquea su saldo y se vigila. */
  #arm(order: SubmitOrder): void {
    const now = this.#cfg.clock.now();
    const { symbol, quantity, triggerPrice: trigger } = order;
    if (order.side !== 'sell' || trigger === null || !trigger.isPositive()) return this.#reject(order, 'ORDER_TYPE_NOT_SUPPORTED', 'solo stops de venta con disparo');
    const instrument = instrumentFor(symbol, trigger, this.#cfg.rules, true, now);
    if (!trigger.roundToStep(instrument.priceStep, 'DOWN').eq(trigger)) return this.#reject(order, 'PRICE_FILTER', `${trigger.toString()} fuera del paso ${instrument.priceStep.toString()}`);
    if (quantity.times(trigger).lt(instrument.minNotional)) return this.#reject(order, 'MIN_NOTIONAL', `${quantity.times(trigger).toString()} < ${instrument.minNotional.toString()} ${instrument.quote}`);
    // Como en un exchange, un stop que saltaría nada más llegar se rechaza: el precio ya está en el stop o por debajo.
    const current = this.#currentPrice(symbol, now);
    if (current !== null && !current.gt(trigger)) return this.#reject(order, 'STOP_WOULD_TRIGGER', `precio ${current.toString()} ≤ disparo ${trigger.toString()}`);
    const funds = this.#fundsProblem(instrument, 'sell', quantity, ZERO);
    if (funds !== null) {
      this.#outcome(order, 'insufficient_funds', 'none', funds);
      this.#fail('submit', order.clientOrderId, 'insufficient_funds', funds);
      return;
    }
    this.#lock(order, true);
    this.#resting.set(order.clientOrderId, { order, trigger, armedAt: now });
    this.#respond([this.#update(this.#record(order, 'open', []), 'rest', [])]);
    this.#watch();
  }

  #lock(order: SubmitOrder, lock: boolean): void {
    const base = instrumentFor(order.symbol, order.triggerPrice ?? ONE, this.#cfg.rules, true, this.#cfg.clock.now()).base;
    const locked = this.#locked.get(base) ?? ZERO;
    this.#locked.set(base, lock ? locked.plus(order.quantity) : locked.minus(order.quantity));
  }

  /** Último precio que el exchange conoce en `now`: el punto medio del libro o la apertura de la vela en curso. */
  #currentPrice(symbol: SymbolId, now: UtcMillis): Price | null {
    const book = usableBook(this.#cfg.market.book(symbol, now), now);
    return book !== null ? this.#mid(book) : (this.#cfg.market.executionBar(symbol, now)?.open ?? null);
  }

  /** Un temporizador al cierre de la vela en curso mientras haya órdenes que esperan. */
  #watch(): void {
    if (this.#watching || this.#resting.size === 0) return;
    const timeframe = this.#cfg.market.timeframe;
    const close = closeTimeOf(floorToTimeframe(this.#cfg.clock.now(), timeframe), timeframe);
    this.#watching = true;
    const timerId = this.#cfg.ids.next();
    this.#pending.set(timerId, () => {
      this.#watching = false;
      this.#checkResting();
      this.#watch();
    });
    this.#cfg.clock.schedule(close, timerId);
  }

  /** Al cierre de una vela, los stops que esperan y que esa vela disparó se ejecutan, en orden de llegada. */
  #checkResting(): void {
    const now = this.#cfg.clock.now();
    for (const [id, resting] of [...this.#resting]) {
      const bar = this.#cfg.market.executionBar(resting.order.symbol, addMs(now, -1));
      if (bar === null || bar.closeTime !== now) continue; // sin operaciones en esa vela, nada pudo dispararlo
      const trigger = sellTrigger(bar, { stop: resting.trigger, target: null }, resting.armedAt);
      if (trigger === null) continue;
      this.#resting.delete(id);
      this.#lock(resting.order, false);
      this.#executeTriggered(resting.order, trigger, bar.volume);
    }
  }

  #executeTriggered(order: SubmitOrder, trigger: Trigger, volume: Quantity): void {
    const now = this.#cfg.clock.now();
    const known = this.#orders.get(order.clientOrderId);
    const instrument = instrumentFor(order.symbol, trigger.reference, this.#cfg.rules, true, now);
    const book = syntheticBook(order.symbol, trigger.reference, volume, instrument, this.#cfg.costs.halfSpread, this.#depth, now);
    const matched = walkBook(book, 'sell', order.quantity, instrument, this.#cfg.costs.minSlippage);
    const detail = `stop por ${trigger.reason === 'gap' ? 'hueco, desde la apertura' : 'toque, desde el stop'} ${trigger.reference.toString()}`;
    if (matched.length === 0) {
      this.#outcome(order, 'no_liquidity', 'synthetic', `${detail}: sin profundidad`);
      this.#respond([this.#update(this.#record(order, 'expired', [], known?.exchangeOrderId), 'rest', [])]);
      return;
    }
    const fills: Fill[] = matched.map((m) =>
      Object.freeze({
        tradeId: this.#cfg.ids.next(),
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        quantity: m.quantity,
        price: m.price,
        fee: m.quantity.times(m.price).times(this.#cfg.costs.commission).roundToScale(FEE_SCALE, 'UP'),
        feeCurrency: instrument.quote,
        feeEstimated: false,
        exchangeTime: now,
      }),
    );
    this.#settle(instrument, order.side, fills);
    const filled = sum(fills.map((f) => f.quantity));
    const complete = filled.eq(order.quantity);
    this.#outcome(order, complete ? 'filled' : 'partial', 'synthetic', detail, trigger.reference);
    const record = this.#record(order, complete ? 'filled' : 'expired', fills, known?.exchangeOrderId);
    this.#respond(complete ? [this.#update(record, 'rest', fills)] : [this.#update(record, 'rest', fills, 'partially_filled'), this.#update(record, 'rest', [])]);
  }

  #settle(instrument: Instrument, side: SubmitOrder['side'], fills: readonly Fill[]): void {
    const notional = sum(fills.map((f) => f.quantity.times(f.price)));
    const fees = sum(fills.map((f) => f.fee));
    const quantity = sum(fills.map((f) => f.quantity));
    const cash = this.#balances.get(instrument.quote) ?? ZERO;
    const base = this.#balances.get(instrument.base) ?? ZERO;
    const sign = side === 'buy' ? ONE : ONE.negated();
    this.#balances.set(instrument.quote, side === 'buy' ? cash.minus(notional).minus(fees) : cash.plus(notional).minus(fees));
    this.#balances.set(instrument.base, base.plus(quantity.times(sign)));
    this.#fills.push(...fills);
  }
}
