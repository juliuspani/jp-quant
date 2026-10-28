// Banco de pruebas del venue simulado (ADR 0026): reloj simulado, cinta de velas o mercado con libro, sumideros que
// guardan cada respuesta con su instante y un bucle que ejecuta los temporizadores en orden, como el replay.
import type { AccountSnapshot, SubmitOrder, VenueOrderUpdate, VenueRequestFailed } from '../../../src/kernel/execution.ts';
import type { BookSnapshot, Candle } from '../../../src/kernel/market-data.ts';
import type { SignedApproval } from '../../../src/kernel/orders.ts';
import { seededIds } from '../../../src/kernel/random.ts';
import { DEFAULT_DEPTH_MODEL, type DepthModel } from '../../../src/backtest/book-model.ts';
import { CandleTape, type Listing, type VenueMarket } from '../../../src/backtest/candle-tape.ts';
import { executionCosts, type CostSpec } from '../../../src/backtest/costs.ts';
import { DEFAULT_INSTRUMENT_RULES, type InstrumentRules } from '../../../src/backtest/instrument-model.ts';
import { DEFAULT_VENUE_LATENCY, SimulatedVenue, type VenueLatency, type VenueSinks } from '../../../src/backtest/simulated-venue.ts';
import { SimulatedClock } from '../../../src/backtest/simulated-clock.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { closeTimeOf, type Timeframe } from '../../../src/shared/time.ts';

export const SYMBOL = 'BTC/EUR';
export const HOUR = 3_600_000;
export const T0 = Date.UTC(2024, 0, 1, 12); // apertura de la vela de ejecución
export const DECIDED = T0 + 60_000; // cierre de la vela anterior más la latencia de los datos: cuándo decide el sistema
export const d = (text: string): Decimal => Decimal.parse(text);

export const COSTS: CostSpec = { commission: '0.0025', halfSpread: '0.00075', minSlippage: '0.0005', multiplier: 1 };

export function bar(openTime: number, prices: { o?: string; h?: string; l?: string; c?: string; v?: string } = {}, symbol = SYMBOL): Candle {
  return {
    symbol,
    timeframe: '1h',
    openTime,
    closeTime: closeTimeOf(openTime, '1h'),
    open: d(prices.o ?? '40000'),
    high: d(prices.h ?? '40500'),
    low: d(prices.l ?? '39500'),
    close: d(prices.c ?? '40200'),
    volume: d(prices.v ?? '100'),
  };
}

export function book(at: number, asks: readonly [string, string][], bids: readonly [string, string][], symbol = SYMBOL): BookSnapshot {
  return {
    symbol,
    asks: asks.map(([price, quantity]) => ({ price: d(price), quantity: d(quantity) })),
    bids: bids.map(([price, quantity]) => ({ price: d(price), quantity: d(quantity) })),
    eventTime: at,
    receivedTime: at,
  };
}

/** Mercado con libro: los libros de la lista, por símbolo y por instante de recepción; las velas, de la cinta. */
export class BookMarket implements VenueMarket {
  readonly tape: CandleTape;
  readonly books: readonly BookSnapshot[];
  constructor(tape: CandleTape, books: readonly BookSnapshot[]) {
    this.tape = tape;
    this.books = books;
  }
  get timeframe(): Timeframe {
    return this.tape.timeframe;
  }
  listed(symbol: string, at: number): boolean | null {
    return this.tape.listed(symbol, at);
  }
  executionBar(symbol: string, at: number): Candle | null {
    return this.tape.executionBar(symbol, at);
  }
  book(symbol: string, at: number): BookSnapshot | null {
    return this.books.filter((b) => b.symbol === symbol && b.receivedTime <= at).at(-1) ?? null;
  }
}

let approvalCounter = 0;
/** Token de forma válida: el venue no lo verifica (lo hará el capguard, paso 39). */
export function approvalFor(side: 'buy' | 'sell', quantity: string): SignedApproval {
  approvalCounter += 1;
  return {
    approval_id: `00000000-0000-4000-8000-${String(approvalCounter).padStart(12, '0')}`,
    intent_id: `intent-${String(approvalCounter)}`,
    symbol: SYMBOL,
    side,
    type: 'market',
    max_quantity: quantity,
    max_notional: side === 'buy' ? '1000000' : null,
    trigger_price: null,
    reduce_only: side === 'sell',
    issued_at: DECIDED,
    expires_at: DECIDED + 10_000,
    config_hash: '0'.repeat(64),
    signature: 'A'.repeat(86),
  };
}

let orderCounter = 0;
export function marketOrder(side: 'buy' | 'sell', quantity: string, overrides: Partial<SubmitOrder> = {}): SubmitOrder {
  orderCounter += 1;
  return {
    clientOrderId: `ijp-test-${String(orderCounter)}`,
    approval: approvalFor(side, quantity),
    symbol: SYMBOL,
    side,
    type: 'market',
    quantity: d(quantity),
    limitPrice: null,
    triggerPrice: null,
    expiresAt: DECIDED + 300_000,
    ...overrides,
  };
}

export type Captured =
  | { readonly at: number; readonly kind: 'update'; readonly value: VenueOrderUpdate }
  | { readonly at: number; readonly kind: 'failure'; readonly value: VenueRequestFailed }
  | { readonly at: number; readonly kind: 'snapshot'; readonly value: AccountSnapshot };

export interface VenueBench {
  readonly clock: SimulatedClock;
  readonly venue: SimulatedVenue;
  readonly captured: Captured[];
  /** Ejecuta los temporizadores pendientes en orden de vencimiento, como el replay; con `until`, solo hasta ese instante. */
  drain(until?: number): void;
  updates(): VenueOrderUpdate[];
  failures(): VenueRequestFailed[];
}

export interface VenueBenchOptions {
  readonly candles?: readonly Candle[];
  readonly books?: readonly BookSnapshot[];
  readonly listings?: ReadonlyMap<string, Listing>;
  readonly costs?: CostSpec;
  readonly depth?: DepthModel;
  readonly latency?: VenueLatency;
  readonly rules?: InstrumentRules;
  readonly cash?: string;
  readonly start?: number;
  readonly sinks?: Partial<VenueSinks>;
}

export function venueBench(options: VenueBenchOptions = {}): VenueBench {
  const clock = new SimulatedClock(options.start ?? DECIDED);
  const candles = options.candles ?? [bar(T0 - HOUR), bar(T0), bar(T0 + HOUR)];
  const listings = options.listings ?? new Map<string, Listing>([[SYMBOL, { listedAt: Date.UTC(2020, 0, 1), delistedAt: null }]]);
  const tape = new CandleTape(candles, listings);
  const market = options.books === undefined ? tape : new BookMarket(tape, options.books);
  const captured: Captured[] = [];
  const venue = new SimulatedVenue({
    clock,
    ids: seededIds(1, 'venue'),
    market,
    rules: options.rules ?? DEFAULT_INSTRUMENT_RULES,
    costs: executionCosts(options.costs ?? COSTS),
    depth: options.depth ?? DEFAULT_DEPTH_MODEL,
    latency: options.latency ?? DEFAULT_VENUE_LATENCY,
    quoteCurrency: 'EUR',
    startingCash: d(options.cash ?? '1000'),
    sinks: {
      update: (value) => {
        captured.push({ at: clock.now(), kind: 'update', value });
        options.sinks?.update?.(value);
      },
      failure: (value) => {
        captured.push({ at: clock.now(), kind: 'failure', value });
        options.sinks?.failure?.(value);
      },
      snapshot: (value) => {
        captured.push({ at: clock.now(), kind: 'snapshot', value });
        options.sinks?.snapshot?.(value);
      },
    },
  });
  const drain = (until = Number.POSITIVE_INFINITY): void => {
    for (;;) {
      const next = clock.nextTimer();
      if (next === null || next.at > until) return;
      clock.advanceTo(next.at);
      clock.takeTimer(next.timerId);
      if (!venue.onTimer(next.timerId)) throw new Error(`temporizador ajeno al venue: ${next.timerId}`);
    }
  };
  return {
    clock,
    venue,
    captured,
    drain,
    updates: () => captured.flatMap((c) => (c.kind === 'update' ? [c.value] : [])),
    failures: () => captured.flatMap((c) => (c.kind === 'failure' ? [c.value] : [])),
  };
}
