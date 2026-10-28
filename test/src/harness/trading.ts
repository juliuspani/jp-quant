// Banco de pruebas de Risk y Execution: reloj simulado, vistas de mercado, cartera y ejecución que cada prueba ajusta,
// y constructores de intenciones. Sin red ni exchange: todo en memoria.
import type {
  CancelOrder,
  ExecutionMode,
  ExecutionRejected,
  ExecutionStatus,
  ExecutionVenue,
  ExecutionView,
  Fill,
  SubmitOrder,
  VenueOrderUpdate,
} from '../../../src/kernel/execution.ts';
import type { Instrument, MarketView, QuoteSnapshot } from '../../../src/kernel/market-data.ts';
import type { OrderIntent } from '../../../src/kernel/orders.ts';
import type { PortfolioSnapshot, PortfolioView, PositionSnapshot } from '../../../src/kernel/portfolio.ts';
import { seededUuids } from '../../../src/kernel/random.ts';
import { SimulatedClock } from '../../../src/backtest/simulated-clock.ts';
import { MemoryExecutionStore, MemoryRiskStore } from '../../../src/backtest/research-stores.ts';
import { ExecutionEngine } from '../../../src/execution/engine.ts';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from '../../../src/risk/limits.ts';
import { RiskEngine } from '../../../src/risk/engine.ts';
import { Decimal } from '../../../src/shared/decimal.ts';

export const T0 = Date.parse('2026-01-05T12:00:00Z');
export const SYMBOL = 'BTC/EUR';
export const d = (text: string): Decimal => Decimal.parse(text);

export function instrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    symbol: SYMBOL,
    base: 'BTC',
    quote: 'EUR',
    tradable: true,
    priceStep: d('0.1'),
    quantityStep: d('0.0001'),
    minQuantity: d('0.0001'),
    minNotional: d('5'),
    asOf: T0,
    ...overrides,
  };
}

export function quote(at: number, ask = '40000', overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return { symbol: SYMBOL, bid: d(ask).minus(d('10')), ask: d(ask), bidSize: d('1'), askSize: d('1'), eventTime: at, receivedTime: at, ...overrides };
}

export function position(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    symbol: SYMBOL,
    bucket: 'core',
    quantity: d('0.01'),
    available: d('0.01'),
    costBasis: d('400'),
    averageEntry: d('40000'),
    realizedPnl: d('0'),
    dust: d('0'),
    openedAt: T0 - 86_400_000,
    ...overrides,
  };
}

export class TestMarket implements MarketView {
  readonly instruments = new Map<string, Instrument>([[SYMBOL, instrument()]]);
  readonly quotes = new Map<string, QuoteSnapshot>([[SYMBOL, quote(T0)]]);
  instrument(symbol: string): Instrument | null {
    return this.instruments.get(symbol) ?? null;
  }
  quote(symbol: string): QuoteSnapshot | null {
    return this.quotes.get(symbol) ?? null;
  }
  book(): null {
    return null;
  }
  volume24h(): null {
    return null;
  }
}

export class TestPortfolio implements PortfolioView {
  current: PortfolioSnapshot = {
    asOf: T0,
    quoteCurrency: 'EUR',
    cash: d('10000'),
    equity: d('10000'),
    exposure: d('0'),
    exposureWithoutDust: d('0'),
    positions: [],
    marksAsOf: T0,
  };
  snapshot(): PortfolioSnapshot {
    return this.current;
  }
}

export class TestExecutionView implements ExecutionView {
  mode: ExecutionMode = 'NORMAL';
  status(): ExecutionStatus {
    return { mode: this.mode, lastReconciledAt: T0, blockedSymbols: [], rateLimitedUntil: null, unprotectedPositions: [] };
  }
}

let intentCounter = 0;
export function entry(overrides: Partial<OrderIntent> = {}): OrderIntent {
  intentCounter += 1;
  return {
    intentId: `intent-${String(intentCounter)}`,
    origin: 'strategy',
    strategyId: 'trend',
    strategyVersion: '1',
    bucket: 'core',
    symbol: SYMBOL,
    side: 'buy',
    kind: 'entry',
    reduceOnly: false,
    sizing: { mode: 'quantity', quantity: d('0.01') },
    stopPrice: d('39500'), // cerca de la entrada: el tamaño por riesgo (0,1008 BTC) no recorta las cantidades de las pruebas
    reason: 'prueba',
    signalTime: T0,
    ...overrides,
  };
}

export function exit(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return entry({ side: 'sell', kind: 'exit', reduceOnly: true, sizing: { mode: 'all' }, stopPrice: null, ...overrides });
}

export interface RiskBench {
  readonly clock: SimulatedClock;
  readonly market: TestMarket;
  readonly portfolio: TestPortfolio;
  readonly execution: ExecutionView;
  readonly store: MemoryRiskStore;
  readonly risk: RiskEngine;
}

export function riskBench(
  options: { execution?: ExecutionView; store?: MemoryRiskStore; limits?: RiskLimits; seed?: number; clock?: SimulatedClock } = {},
): RiskBench {
  const clock = options.clock ?? new SimulatedClock(T0);
  const market = new TestMarket();
  const portfolio = new TestPortfolio();
  const execution = options.execution ?? new TestExecutionView();
  const store = options.store ?? new MemoryRiskStore();
  const risk = new RiskEngine({
    clock,
    ids: seededUuids(options.seed ?? 7, 'risk'),
    store,
    market,
    portfolio,
    execution,
    limits: options.limits ?? DEFAULT_RISK_LIMITS,
    commit: 'test',
  });
  return { clock, market, portfolio, execution, store, risk };
}

/** Venue de prueba: guarda lo que recibe y puede lanzar. Las respuestas las inyecta cada prueba. */
export class TestVenue implements ExecutionVenue {
  readonly submitted: SubmitOrder[] = [];
  readonly canceled: CancelOrder[] = [];
  failSubmit: Error | null = null;
  failCancel: Error | null = null;
  submit(order: SubmitOrder): void {
    if (this.failSubmit !== null) throw this.failSubmit;
    this.submitted.push(order);
  }
  cancel(order: CancelOrder): void {
    if (this.failCancel !== null) throw this.failCancel;
    this.canceled.push(order);
  }
  queryOrder(): void {}
  requestAccountSnapshot(): void {}
}

export function update(clientOrderId: string, status: VenueOrderUpdate['status'], filled: string, fills: Fill[] = [], origin: VenueOrderUpdate['origin'] = 'ws'): VenueOrderUpdate {
  return { clientOrderId, exchangeOrderId: 'x-1', status, filled: d(filled), averagePrice: null, fills, exchangeRejectCode: null, origin, exchangeTime: T0 };
}

export function fill(clientOrderId: string, tradeId: string, quantity: string, side: 'buy' | 'sell' = 'buy'): Fill {
  return { tradeId, clientOrderId, symbol: SYMBOL, side, quantity: d(quantity), price: d('40000'), fee: d('0.4'), feeCurrency: 'EUR', feeEstimated: false, exchangeTime: T0 };
}

export interface TradingBench extends Omit<RiskBench, 'execution'> {
  readonly execution: ExecutionEngine;
  readonly executionStore: MemoryExecutionStore;
  readonly venue: TestVenue;
  readonly rejections: ExecutionRejected[];
  readonly fills: Fill[]; // los que Execution entregó a Portfolio (FillRecorded)
}

/** Risk y Execution reales, unidos como los unirá app/. Por defecto, Execution sale de UNKNOWN con una reconciliación vacía. */
export function tradingBench(options: { reconcile?: boolean; executionStore?: MemoryExecutionStore; seed?: number } = {}): TradingBench {
  let execution: ExecutionEngine | null = null;
  const view: ExecutionView = {
    status: () => {
      if (execution === null) throw new Error('Execution aún no está construido');
      return execution.status();
    },
  };
  const bench = riskBench({ execution: view, seed: options.seed ?? 7 });
  const executionStore = options.executionStore ?? new MemoryExecutionStore();
  const venue = new TestVenue();
  const rejections: ExecutionRejected[] = [];
  const fills: Fill[] = [];
  execution = new ExecutionEngine({
    clock: bench.clock,
    venue,
    store: executionStore,
    market: bench.market,
    portfolio: bench.portfolio,
    risk: bench.risk,
    approvalKey: bench.risk.approvalPublicKey,
    onRejected: (rejected) => {
      rejections.push(rejected);
      bench.risk.recordExecutionRejection(rejected);
    },
    onFill: (recorded) => {
      fills.push(recorded);
    },
    orderTtlMs: 300_000,
  });
  if (options.reconcile ?? true) execution.reconcile([]);
  return { ...bench, execution, executionStore, venue, rejections, fills };
}
