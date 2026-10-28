// Modo backtest (ARCHITECTURE.md §14, ADR 0013 y ADR 0026): el sistema de trading real (trading-system.ts) sobre el motor
// de replay, event-driven. Solo cambian tres piezas respecto a live:
// - el reloj: el simulado del replay, que avanza al received_time de cada dato o temporizador;
// - la fuente de datos: velas de historical/ en orden de received_time, con la cotización y las reglas del mercado que
//   da el modelo (backtest/), porque el histórico no trae ni libro ni cotizaciones;
// - el venue: SimulatedVenue, cuyas respuestas vuelven como temporizadores.
// Strategy, Risk y Execution son los mismos módulos y con las mismas interfaces que en real.
//
// Ningún resultado sale sin costes: el modelo de costes no se construye por debajo de los mínimos, todas las cifras son
// netas (cada fill paga comisión, spread y slippage) y las posiciones abiertas al final se valoran como si se vendieran,
// con comisión y slippage. Lo que el modelo supone se declara en el resultado.
import type { FillRecord } from '../analytics/breakdown.ts';
import { summarize, type EquitySample, type PerformanceSummary } from '../analytics/performance.ts';
import type { FeatureSet } from '../features/types.ts';
import { DEFAULT_DEPTH_MODEL, quoteFromCandle, type DepthModel } from '../backtest/book-model.ts';
import { CandleTape, type Listing } from '../backtest/candle-tape.ts';
import { executionCosts, type CostSpec, type ExecutionCosts } from '../backtest/costs.ts';
import { DEFAULT_INSTRUMENT_RULES, instrumentFor, type InstrumentRules } from '../backtest/instrument-model.ts';
import { ReplayEngine, type ReplayContext, type ReplayEvent, type ReplayHandler, type ReplayRecord } from '../backtest/replay.ts';
import { MemoryExecutionStore, MemoryRiskStore } from '../backtest/research-stores.ts';
import { DEFAULT_VENUE_LATENCY, SimulatedVenue, type ExecutionModelReport, type OutcomeRecord, type VenueLatency } from '../backtest/simulated-venue.ts';
import type { HistoricalCandle } from '../historical/types.ts';
import type { Fill } from '../kernel/execution.ts';
import type { Sleeper } from '../kernel/clock.ts';
import type { RawMarketData } from '../kernel/market-data.ts';
import { seededIds, seededUuids } from '../kernel/random.ts';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from '../risk/limits.ts';
import { canonicalJson } from '../shared/canonical.ts';
import { Decimal, type Notional } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import { addMs, timeframeMs, toUtcIso, type UtcMillis } from '../shared/time.ts';
import type { Bucket } from '../shared/trading.ts';
import type { Strategy } from '../strategy/types.ts';
import { TradingSystem, type EquityPoint, type Journal } from './trading-system.ts';

export const MARKET_RECORD = 'RawMarketDataReceived';
const MARKET_SOURCE = 'historical';
const RATIO_SCALE = 8;

export class BacktestError extends Error {
  override readonly name = 'BacktestError';
}

export interface BacktestSpec<P> {
  readonly runId: string;
  readonly seed: number;
  readonly commit: string;
  readonly candles: readonly HistoricalCandle[]; // limpias, de historical/; en cualquier orden
  readonly listings: ReadonlyMap<SymbolId, Listing>; // altas y bajas point-in-time de cada símbolo
  readonly from: UtcMillis; // inicio del tramo que cuenta
  readonly to: UtcMillis; // fin del tramo, excluido
  readonly featureSet: FeatureSet;
  readonly strategy: Strategy<P>;
  readonly params: P;
  readonly costs: CostSpec;
  readonly startingCash: Notional;
  readonly quoteCurrency: string;
  readonly bucket?: Bucket;
  readonly riskLimits?: RiskLimits;
  readonly rules?: InstrumentRules;
  readonly depth?: DepthModel;
  readonly latency?: VenueLatency;
  readonly orderTtlMs?: number;
}

/** Una operación de ida y vuelta: desde que se abre una posición hasta que vuelve a cero. */
export interface RoundTrip {
  readonly symbol: SymbolId;
  readonly openedAt: UtcMillis;
  readonly closedAt: UtcMillis | null; // null: sigue abierta al final
  readonly bought: string; // cantidad comprada
  readonly cost: string; // lo pagado, con comisiones
  readonly proceeds: string; // lo cobrado, con comisiones descontadas
  readonly pnl: string | null; // neto; null si sigue abierta
}

export interface BacktestMetrics {
  readonly startEquity: string;
  readonly endEquity: string; // valor de liquidación al final, neto de costes
  readonly netReturn: string; // en fracción
  readonly maxDrawdown: string; // en fracción del máximo previo
  readonly closedTrades: number;
  readonly winningTrades: number;
  readonly openPositions: number;
  readonly fills: number;
  readonly feesPaid: string;
}

export interface BacktestResult {
  readonly journalSha256: string; // del diario del replay, sin firmas: determinista
  readonly journalEvents: number;
  readonly journal: readonly ReplayEvent[]; // en memoria; el ejecutor de experimentos elige qué guarda
  readonly from: UtcMillis;
  readonly to: UtcMillis;
  readonly warmupFrom: UtcMillis;
  readonly metrics: BacktestMetrics;
  readonly performance: PerformanceSummary; // analytics/: Sharpe, caída, exposición, rotación y costes realizados
  // Lo que analytics/ necesita para el informe del run (paso 26), en float; el ejecutor no lo guarda en la salida.
  readonly analysis: { readonly curve: readonly EquitySample[]; readonly fills: readonly FillRecord[]; readonly liquidationCost: number };
  readonly equityCurve: readonly { readonly at: UtcMillis; readonly equity: string }[];
  readonly roundTrips: readonly RoundTrip[];
  readonly execution: ExecutionModelReport;
  readonly halted: string | null; // por qué el sistema dejó de operar, o null
  readonly assumptions: readonly string[];
}

const noSleep: Sleeper = { sleep: () => Promise.resolve() };

function timerIdOf(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'timerId' in payload && typeof payload.timerId === 'string') return payload.timerId;
  throw new BacktestError('TimerFired sin timerId');
}

function byOpen(a: HistoricalCandle, b: HistoricalCandle): number {
  if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
  return a.openTime === b.openTime ? 0 : a.openTime < b.openTime ? -1 : 1;
}

function roundTrips(fills: readonly Fill[]): RoundTrip[] {
  const zero = Decimal.parse('0');
  const open = new Map<SymbolId, { openedAt: UtcMillis; held: Decimal; bought: Decimal; cost: Decimal; proceeds: Decimal }>();
  const trips: RoundTrip[] = [];
  for (const fill of fills) {
    const trip = open.get(fill.symbol) ?? { openedAt: fill.exchangeTime, held: zero, bought: zero, cost: zero, proceeds: zero };
    const notional = fill.quantity.times(fill.price);
    if (fill.side === 'buy') {
      trip.held = trip.held.plus(fill.quantity);
      trip.bought = trip.bought.plus(fill.quantity);
      trip.cost = trip.cost.plus(notional).plus(fill.fee);
    } else {
      trip.held = trip.held.minus(fill.quantity);
      trip.proceeds = trip.proceeds.plus(notional).minus(fill.fee);
    }
    if (trip.held.isZero()) {
      open.delete(fill.symbol);
      trips.push(Object.freeze({
        symbol: fill.symbol, openedAt: trip.openedAt, closedAt: fill.exchangeTime, bought: trip.bought.toString(),
        cost: trip.cost.toString(), proceeds: trip.proceeds.toString(), pnl: trip.proceeds.minus(trip.cost).toString(),
      }));
    } else open.set(fill.symbol, trip);
  }
  for (const [symbol, trip] of [...open.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    trips.push(Object.freeze({
      symbol, openedAt: trip.openedAt, closedAt: null, bought: trip.bought.toString(), cost: trip.cost.toString(),
      proceeds: trip.proceeds.toString(), pnl: null,
    }));
  }
  return trips;
}

/** Precio de referencia de cada orden ejecutada, por client order ID: lo que el venue tomó como mercado al ejecutarla. */
function referencesOf(outcomes: readonly OutcomeRecord[]): ReadonlyMap<string, Decimal> {
  const references = new Map<string, Decimal>();
  for (const o of outcomes) if (o.reference !== null) references.set(o.clientOrderId, Decimal.parse(o.reference));
  return references;
}

/** Medio spread, slippage e impacto realizados en un fill: lo que se pagó de más (compra) o se cobró de menos (venta). */
function implicitCost(fill: Fill, references: ReadonlyMap<string, Decimal>): Decimal {
  const reference = references.get(fill.clientOrderId);
  if (reference === undefined) throw new BacktestError(`fill ${fill.tradeId} sin precio de referencia de su orden`);
  const gap = fill.side === 'buy' ? fill.price.minus(reference) : reference.minus(fill.price);
  return gap.times(fill.quantity);
}

function maxDrawdown(points: readonly Notional[]): Decimal {
  let peak: Decimal | null = null;
  let worst = Decimal.parse('0');
  for (const equity of points) {
    if (peak === null || equity.gt(peak)) peak = equity;
    if (peak.isPositive()) {
      const drawdown = peak.minus(equity).div(peak, RATIO_SCALE, 'UP');
      if (drawdown.gt(worst)) worst = drawdown;
    }
  }
  return worst;
}

function assumptions(costs: ExecutionCosts, latency: VenueLatency, rules: InstrumentRules, warmupBars: number, receivedLatencyMs: string): string[] {
  return [
    `Calentamiento: ${String(warmupBars)} velas antes del tramo, con features y sin evaluar la estrategia.`,
    `Datos: velas cerradas que el sistema recibe en su received_time (latencia de la fuente: ${receivedLatencyMs}).`,
    `Cotización del sistema: el cierre de cada vela ± el medio spread (${costs.halfSpread.toString()}), con fecha del cierre; el último trade pudo ser anterior.`,
    `Reglas del mercado modeladas como Bitvavo [verificar]: ${String(rules.priceSignificantDigits)} cifras significativas de precio, ${String(rules.quantityDecimals)} decimales de cantidad e importe mínimo de ${rules.minNotional.toString()}.`,
    `Latencia de las órdenes: ${String(latency.orderMs)} ms de ida y ${String(latency.responseMs)} ms de vuelta.`,
    'Stops de protección: esperan en el exchange tras cada entrada y se comprueban al cierre de cada vela; si la vela abre más allá del stop, se venden desde la apertura; si el mínimo lo toca, desde el precio del stop; con stop y objetivo en la misma vela, primero el stop. Antes de una salida o de subir el stop, se cancela el que espera.',
    `Valoración final: las posiciones abiertas, al bid menos la comisión (${costs.commission.toString()}) y el slippage mínimo (${costs.minSlippage.toString()}).`,
    'Sin reconciliación periódica: una duda que la primera reconciliación no resuelve detiene el sistema (halted).',
  ];
}

/** Ejecuta un backtest. Lanza si algo incumple el contrato (fail closed): el registro lo cierra como «fallido». */
export function runBacktest<P>(spec: BacktestSpec<P>): BacktestResult {
  const costs = executionCosts(spec.costs);
  const rules = spec.rules ?? DEFAULT_INSTRUMENT_RULES;
  const depth = spec.depth ?? DEFAULT_DEPTH_MODEL;
  const latency = spec.latency ?? DEFAULT_VENUE_LATENCY;
  toUtcIso(spec.from);
  toUtcIso(spec.to);
  if (spec.to <= spec.from) throw new BacktestError('tramo vacío o invertido');
  const timeframe = spec.featureSet.timeframe;
  const warmupFrom = addMs(spec.from, -spec.strategy.warmupBars * timeframeMs(timeframe));
  const sorted = [...spec.candles].sort(byOpen);
  const latencies = new Set<number>();
  for (const candle of sorted) {
    if (candle.timeframe !== timeframe) throw new BacktestError(`${candle.symbol}: vela de ${candle.timeframe}, el conjunto de features es de ${timeframe}`);
    latencies.add(candle.receivedTime - candle.closeTime);
  }
  const tape = new CandleTape(sorted, spec.listings);

  const payloads = new WeakMap<object, HistoricalCandle>();
  const records: ReplayRecord[] = sorted.map((candle, i) => {
    const payload = Object.freeze({ ...candle });
    payloads.set(payload, candle);
    return { type: MARKET_RECORD, source: MARKET_SOURCE, sourceSeq: i, eventTime: candle.closeTime, receivedTime: candle.receivedTime, payload };
  });

  let context: ReplayContext | null = null;
  let system: TradingSystem<P> | null = null;
  let venue: SimulatedVenue | null = null;
  const journal: Journal = (type, payload) => {
    if (context === null) throw new BacktestError(`${type} fuera de un evento del replay`);
    context.output(type, payload);
  };
  // Las velas que llegan en el mismo instante se entregan juntas, con la primera de ellas (auditoría quant Q-01).
  const instants = new Map<UtcMillis, HistoricalCandle[]>();
  for (const candle of sorted) {
    const group = instants.get(candle.receivedTime);
    if (group === undefined) instants.set(candle.receivedTime, [candle]);
    else group.push(candle);
  }
  let deliveredAt: UtcMillis | null = null;
  const deliver = (receivedTime: UtcMillis): void => {
    if (system === null) throw new BacktestError('sistema sin construir');
    if (deliveredAt === receivedTime) return;
    deliveredAt = receivedTime;
    const raws: RawMarketData[] = [];
    for (const candle of instants.get(receivedTime) ?? []) {
      const listed = tape.listed(candle.symbol, receivedTime) === true;
      const instrument = instrumentFor(candle.symbol, candle.close, rules, listed, receivedTime);
      const { receivedTime: _received, ...plain } = candle;
      raws.push(
        { kind: 'instruments', instruments: [instrument] },
        { kind: 'quote', quote: quoteFromCandle(candle, instrument, costs.halfSpread, depth, receivedTime) },
        { kind: 'candle', candle: plain, closed: true },
      );
    }
    system.onMarketBatch(raws, receivedTime);
  };
  const handler: ReplayHandler = (event, ctx) => {
    context = ctx;
    try {
      if (event.type === 'TimerFired') {
        const timerId = timerIdOf(event.payload);
        if (venue === null || !venue.onTimer(timerId)) throw new BacktestError(`temporizador desconocido: ${timerId}`);
      } else if (event.type === MARKET_RECORD) {
        const candle = typeof event.payload === 'object' && event.payload !== null ? payloads.get(event.payload) : undefined;
        if (candle === undefined) throw new BacktestError('registro de mercado sin su vela');
        deliver(event.receivedTime);
      } else {
        throw new BacktestError(`evento desconocido en el replay: ${event.type}`);
      }
    } finally {
      context = null;
    }
    return undefined;
  };

  const engine = new ReplayEngine(records, [handler], { runId: spec.runId, seed: spec.seed, segment: { from: warmupFrom, to: spec.to } }, noSleep);
  const executionStore = new MemoryExecutionStore();
  venue = new SimulatedVenue({
    clock: engine.clock,
    ids: seededIds(spec.seed, 'venue'),
    market: tape,
    rules,
    costs,
    depth,
    latency,
    quoteCurrency: spec.quoteCurrency,
    startingCash: spec.startingCash,
    sinks: {
      update: (update) => system?.onVenueUpdate(update),
      failure: (failure) => system?.onVenueFailure(failure),
      snapshot: (snapshot) => system?.onAccountSnapshot(snapshot),
    },
  });
  system = new TradingSystem({
    clock: engine.clock,
    intentIds: seededIds(spec.seed, 'intent'),
    approvalIds: seededUuids(spec.seed, 'approval'),
    venue,
    riskStore: new MemoryRiskStore(),
    executionStore,
    featureSet: spec.featureSet,
    strategy: spec.strategy,
    params: spec.params,
    bucket: spec.bucket ?? 'core',
    riskLimits: spec.riskLimits ?? DEFAULT_RISK_LIMITS,
    quoteCurrency: spec.quoteCurrency,
    startingCash: spec.startingCash,
    commit: spec.commit,
    orderTtlMs: spec.orderTtlMs ?? 300_000,
    tradingFrom: spec.from,
    journal,
  });
  system.start();
  engine.run();
  const replay = engine.result();

  // Valor de liquidación: las posiciones abiertas, al bid menos la comisión y el slippage mínimo.
  const final = system.portfolio.snapshot();
  const exitCost = costs.commission.plus(costs.minSlippage);
  const exitFactor = Decimal.parse('1').minus(exitCost);
  let liquidationCost = Decimal.parse('0'); // para analytics: comisión, slippage y medio spread de esa venta supuesta
  const liquidation = final.positions.reduce((total, p) => {
    const bid = system?.market.quote(p.symbol)?.bid ?? null;
    if (bid === null) return total;
    liquidationCost = liquidationCost.plus(p.quantity.times(bid).times(exitCost.plus(costs.halfSpread)));
    return total.plus(p.quantity.times(bid).times(exitFactor));
  }, final.cash);
  const curve: EquityPoint[] = [...system.equityCurve()];
  const fills = executionStore.fills();
  const references = referencesOf(venue.outcomes());
  const trips = roundTrips(fills);
  const closed = trips.filter((t) => t.pnl !== null);
  const start = spec.startingCash;
  const metrics: BacktestMetrics = Object.freeze({
    startEquity: start.toString(),
    endEquity: liquidation.toString(),
    netReturn: start.isPositive() ? liquidation.div(start, RATIO_SCALE, 'HALF_EVEN').minus(Decimal.parse('1')).toString() : '0',
    maxDrawdown: maxDrawdown([start, ...curve.map((p) => p.equity), liquidation]).toString(),
    closedTrades: closed.length,
    winningTrades: closed.filter((t) => t.pnl !== null && Decimal.parse(t.pnl).isPositive()).length,
    openPositions: final.positions.length,
    fills: fills.length,
    feesPaid: fills.reduce((total, f) => total.plus(f.fee), Decimal.parse('0')).toString(),
  });
  // Analytics trabaja en float (análisis): la frontera es toAnalysis.
  const analysisCurve: EquitySample[] = curve.map((p) => ({
    at: p.at, equity: p.equity.toAnalysis(), exposure: p.exposure.toAnalysis(), exposureWithoutDust: p.exposureWithoutDust.toAnalysis(),
  }));
  const fillCosts: FillRecord[] = fills.map((f) => ({
    symbol: f.symbol,
    notional: f.quantity.times(f.price).toAnalysis(),
    fee: f.fee.toAnalysis(),
    implicit: implicitCost(f, references).toAnalysis(),
  }));
  const performance = summarize({
    timeframe,
    startEquity: start.toAnalysis(),
    endEquity: liquidation.toAnalysis(),
    curve: analysisCurve,
    fills: fillCosts,
    liquidationCost: liquidationCost.toAnalysis(),
  });
  return Object.freeze({
    journalSha256: replay.sha256,
    journalEvents: replay.journal.length,
    journal: replay.journal,
    from: spec.from,
    to: spec.to,
    warmupFrom,
    metrics,
    performance,
    analysis: Object.freeze({ curve: Object.freeze(analysisCurve), fills: Object.freeze(fillCosts), liquidationCost: liquidationCost.toAnalysis() }),
    equityCurve: Object.freeze(curve.map((p) => Object.freeze({ at: p.at, equity: p.equity.toString() }))),
    roundTrips: Object.freeze(trips),
    execution: venue.report(),
    halted: system.halted,
    assumptions: Object.freeze(assumptions(costs, latency, rules, spec.strategy.warmupBars, [...latencies].sort((a, b) => a - b).map((ms) => `${String(ms)} ms`).join(', ') || 'sin velas')),
  });
}

/**
 * El diario de un backtest como texto inversor-replay/1, el que lee el dashboard (paso 41C): cabecera, un evento por línea
 * y cierre. runBacktest da los eventos, no el JSONL del motor: la cabecera lleva lo que se conoce del run (sin la huella de
 * la entrada) y el SHA-256 del diario que calculó el motor.
 */
export function journalText(runId: string, seed: number, result: BacktestResult): string {
  const header = canonicalJson({ format: 'inversor-replay/1', runId, seed, segment: { from: result.warmupFrom, to: result.to }, journalSha256: result.journalSha256 });
  const footer = canonicalJson({ events: result.journal.length, clock: result.journal.at(-1)?.receivedTime ?? result.to });
  return `${[header, ...result.journal.map((e) => canonicalJson(e)), footer].join('\n')}\n`;
}
