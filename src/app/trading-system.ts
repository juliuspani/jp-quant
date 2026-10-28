// El sistema de trading compuesto (ARCHITECTURE.md §1, §8 y §14; paso 23, ADR 0026): marketdata → features → strategy →
// risk → execution → venue, y de vuelta venue → execution → portfolio → strategy. Es el mismo en todos los modos: el modo
// solo elige el reloj, la fuente de datos y el venue que recibe (ADR 0013), y los almacenes.
//
// Sin bus todavía: cada evento entra por un método on* en el orden en que llega, y todo lo que provoca se resuelve de
// forma síncrona, como un handler de §5.2. Lo que cruza un módulo se anota en el diario (journal) en JSON canónico; los
// tokens van sin su firma, que cambia en cada arranque (ADR 0023), para que el diario sea determinista.
//
// Stops de protección (trading-risk §2.4, exchange-execution §8): tras una entrada, el stop sale como intención de
// sistema por Risk y Execution y espera en el exchange. Antes de una salida o de subir el stop, primero se cancela el
// que espera y, confirmada la cancelación, sale la orden ya aprobada; si el stop se ejecutó antes, la salida sobra.
import { priceRegime, RegimeTracker } from '../analytics/regime.ts';
import { FeatureEngine } from '../features/engine.ts';
import type { FeatureSet } from '../features/types.ts';
import type { Clock } from '../kernel/clock.ts';
import {
  isSendingBlocked,
  TERMINAL_STATES,
  type AccountSnapshot,
  type ExecutionVenue,
  type ExecutionView,
  type Fill,
  type VenueOrderUpdate,
  type VenueRequestFailed,
} from '../kernel/execution.ts';
import type { Candle, MarketView, RawMarketData } from '../kernel/market-data.ts';
import type { OrderIntent, SignedApproval } from '../kernel/orders.ts';
import type { PortfolioView } from '../kernel/portfolio.ts';
import type { Ids } from '../kernel/random.ts';
import type { ExecutionStore, RiskStore } from '../kernel/stores.ts';
import { MarketDataNormalizer } from '../marketdata/normalizer.ts';
import { PortfolioLedger } from '../portfolio/ledger.ts';
import { ExecutionEngine } from '../execution/engine.ts';
import { RiskEngine } from '../risk/engine.ts';
import type { RiskLimits } from '../risk/limits.ts';
import { Decimal, type Notional, type Price } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { UtcMillis } from '../shared/time.ts';
import type { Bucket } from '../shared/trading.ts';
import { StrategyEngine, type StrategyEngineDeps } from '../strategy/engine.ts';
import type { Strategy } from '../strategy/types.ts';

/** Anota un evento en el diario del run. Lanza si no puede (persistir antes de actuar). */
export type Journal = (type: string, payload: unknown) => void;

export interface TradingSystemConfig<P> {
  readonly clock: Clock;
  readonly intentIds: Ids;
  readonly approvalIds: Ids; // UUID: el approval_id da el client order ID (exchange-execution §5.1)
  readonly venue: ExecutionVenue;
  readonly riskStore: RiskStore;
  readonly executionStore: ExecutionStore;
  readonly featureSet: FeatureSet;
  readonly strategy: Strategy<P>;
  readonly params: P;
  readonly bucket: Bucket;
  readonly riskLimits: RiskLimits;
  readonly quoteCurrency: string;
  readonly startingCash: Notional;
  readonly commit: string;
  readonly orderTtlMs: number;
  readonly tradingFrom: UtcMillis; // antes, solo calentamiento: se calculan features y no se evalúa la estrategia
  readonly journal: Journal;
}

export interface EquityPoint {
  readonly at: UtcMillis;
  readonly equity: Notional;
  readonly cash: Notional;
  readonly exposure: Notional;
  readonly exposureWithoutDust: Notional; // sin las posiciones que son polvo (ADR 0033, ADR 0042)
}

/**
 * Vistas de solo lectura (ARCHITECTURE.md §15.2): objetos congelados que solo leen. Así Strategy no recibe nada con
 * lo que enviar una orden, cambiar los datos de mercado o tocar la cartera (test/src/app/composition.test.ts).
 */
export function readOnlyMarket(market: MarketView): MarketView {
  return Object.freeze({
    instrument: (symbol: SymbolId) => market.instrument(symbol),
    quote: (symbol: SymbolId) => market.quote(symbol),
    book: (symbol: SymbolId) => market.book(symbol),
    volume24h: (symbol: SymbolId) => market.volume24h(symbol),
  });
}

export function readOnlyPortfolio(portfolio: PortfolioView): PortfolioView {
  return Object.freeze({ snapshot: () => portfolio.snapshot() });
}

interface OrderContext {
  readonly symbol: SymbolId;
  readonly bucket: Bucket;
  readonly intentId: string;
  readonly role: 'entry' | 'exit' | 'protective';
  resolved: boolean;
}

/** El stop de protección de un símbolo: enviado (pending) o ya esperando en el exchange (open). */
interface Protection {
  readonly clientOrderId: string;
  readonly trigger: Price;
  state: 'pending' | 'open';
}

/** Una orden aprobada que sale cuando se confirme la cancelación del stop que espera. */
interface Replacement {
  readonly intent: OrderIntent;
  readonly approval: SignedApproval;
}

export class TradingSystem<P> {
  readonly market: MarketDataNormalizer;
  readonly portfolio: PortfolioLedger;
  readonly features: FeatureEngine;
  readonly regimes: RegimeTracker; // régimen de cada símbolo para StrategyInput (paso 26, ADR 0029)
  readonly strategy: StrategyEngine<P>;
  /** Lo que la composición entrega a Strategy: se expone para que una prueba lo audite (ARCHITECTURE.md §15.2). */
  readonly strategyDeps: StrategyEngineDeps<P>;
  readonly risk: RiskEngine;
  readonly execution: ExecutionEngine;
  readonly #config: TradingSystemConfig<P>;
  readonly #orders = new Map<string, OrderContext>();
  readonly #equity: EquityPoint[] = [];
  readonly #protection = new Map<SymbolId, Protection>();
  readonly #replacing = new Map<string, Replacement>(); // por client order ID del stop que se cancela
  #reconciling = false;
  #killSwitchSeen = false;
  #halted: string | null = null;

  constructor(config: TradingSystemConfig<P>) {
    const { strategy, featureSet } = config;
    if (strategy.featureSet.id !== featureSet.id || strategy.featureSet.version !== featureSet.version) {
      throw new RangeError(`${strategy.id} usa ${strategy.featureSet.id}@${String(strategy.featureSet.version)}, no ${featureSet.id}@${String(featureSet.version)}`);
    }
    const needed = Math.max(...featureSet.features.map((f) => f.warmupBars));
    if (strategy.warmupBars < needed) throw new RangeError(`${strategy.id}: warmupBars ${String(strategy.warmupBars)} < ${String(needed)} de sus features`);
    this.#config = config;
    this.market = new MarketDataNormalizer();
    this.portfolio = new PortfolioLedger({ clock: config.clock, market: this.market, quoteCurrency: config.quoteCurrency, startingCash: config.startingCash });
    this.features = new FeatureEngine(featureSet);
    this.regimes = new RegimeTracker(priceRegime(), featureSet.timeframe);
    this.strategyDeps = Object.freeze({
      strategy,
      params: config.params,
      bucket: config.bucket,
      market: readOnlyMarket(this.market),
      portfolio: readOnlyPortfolio(this.portfolio),
      ids: config.intentIds,
    });
    this.strategy = new StrategyEngine(this.strategyDeps);
    let execution: ExecutionEngine | null = null;
    const view: ExecutionView = {
      status: () => {
        if (execution === null) throw new Error('Execution aún no está construido');
        return execution.status();
      },
    };
    this.risk = new RiskEngine({
      clock: config.clock,
      ids: config.approvalIds,
      store: config.riskStore,
      market: this.market,
      portfolio: this.portfolio,
      execution: view,
      limits: config.riskLimits,
      commit: config.commit,
    });
    execution = new ExecutionEngine({
      clock: config.clock,
      venue: config.venue,
      store: config.executionStore,
      market: this.market,
      portfolio: this.portfolio,
      risk: this.risk,
      approvalKey: this.risk.approvalPublicKey,
      onRejected: (rejected) => {
        config.journal('ExecutionRejected', rejected);
        this.risk.recordExecutionRejection(rejected);
      },
      onFill: (fill) => {
        this.#onFill(fill);
      },
      orderTtlMs: config.orderTtlMs,
    });
    this.execution = execution;
  }

  /** Por qué dejó de operar (UNKNOWN sin resolver o kill switch), o null. */
  get halted(): string | null {
    return this.#halted;
  }

  equityCurve(): readonly EquityPoint[] {
    return Object.freeze([...this.#equity]);
  }

  /** Arranque: Execution empieza en UNKNOWN y pide la foto de la cuenta para reconciliar (exchange-execution §16). */
  start(): void {
    this.#reconciling = true;
    this.#config.venue.requestAccountSnapshot(null);
  }

  /** RawMarketDataReceived: el normalizador valida y publica; cada vela cerrada recorre el pipeline. */
  onMarketData(raw: RawMarketData, receivedTime: UtcMillis): void {
    this.onMarketBatch([raw], receivedTime);
  }

  /**
   * Lo recibido en un mismo instante: se ingiere todo antes de evaluar ninguna vela, para que Risk valore la cartera con
   * todo lo que ya se conoce (quant-research §3). Evaluar cada vela al ingerirla dejaba obsoleta la marca de los pares que
   * llegan después en ese instante, y Risk rechazaba sus entradas por STALE_DATA (auditoría quant Q-01).
   */
  onMarketBatch(raws: readonly RawMarketData[], receivedTime: UtcMillis): void {
    const closed: { readonly candle: Candle; readonly receivedTime: UtcMillis }[] = [];
    for (const raw of raws) {
      for (const event of this.market.ingest(raw, receivedTime)) {
        if (event.type === 'CandleClosed') closed.push(event);
        else this.#config.journal(event.type, event);
      }
    }
    for (const event of closed) this.#onCandle(event.candle, event.receivedTime);
  }

  /** VenueOrderUpdate. */
  onVenueUpdate(update: VenueOrderUpdate): void {
    this.#config.journal('VenueOrderUpdate', update);
    this.execution.onVenueUpdate(update);
    this.#afterExecution(update.clientOrderId);
  }

  /** VenueRequestFailed. */
  onVenueFailure(failure: VenueRequestFailed): void {
    this.#config.journal('VenueRequestFailed', failure);
    this.execution.onVenueFailure(failure);
    this.#afterExecution(failure.clientOrderId);
  }

  /** AccountSnapshotReceived: reconciliación (exchange-execution §14). Si no cuadra, el sistema sigue sin operar. */
  onAccountSnapshot(snapshot: AccountSnapshot): void {
    this.#config.journal('AccountSnapshotReceived', snapshot);
    const resolved = this.execution.reconcile(snapshot.orders);
    this.#reconciling = false;
    const status = this.execution.status();
    this.#config.journal('ReconciliationCompleted', { resolved, mode: status.mode, reason: this.execution.unknownReason });
    for (const order of snapshot.orders) this.#afterExecution(order.clientOrderId);
    if (!resolved) this.#halt(`UNKNOWN sin resolver tras reconciliar: ${this.execution.unknownReason ?? 'sin motivo'}`);
  }

  #onCandle(candle: Candle, receivedTime: UtcMillis): void {
    const vector = this.features.onCandleClosed(candle, receivedTime);
    const regime = this.regimes.onCandleClosed(candle);
    if (receivedTime < this.#config.tradingFrom) return; // calentamiento (quant-research §3)
    const step = this.strategy.onFeatures(vector, regime);
    this.#config.journal('StrategyEvaluated', {
      symbol: step.symbol,
      asOf: vector.asOf,
      action: step.decision?.action ?? null,
      reason: step.decision?.reason ?? null,
      note: step.note,
    });
    if (step.intent !== null) this.#onIntent(step.intent);
    else this.#protect(step.symbol);
    this.#sampleEquity();
  }

  #onIntent(intent: OrderIntent): void {
    const journal = this.#config.journal;
    journal('OrderIntentCreated', intent);
    const outcome = this.risk.evaluate(intent);
    journal('RiskDecisionMade', outcome.decision);
    this.#checkKillSwitch();
    if (outcome.approval === null) {
      this.#resolveStrategy(intent);
      return;
    }
    const { signature, ...approval } = outcome.approval;
    journal('OrderApproved', { ...approval, signed: signature !== '' });
    const guard = this.#protection.get(intent.symbol);
    if ((intent.kind === 'exit' || intent.kind === 'stop_update') && guard !== undefined) {
      // Primero cancelar el stop que espera y, confirmado, enviar (exchange-execution §8). Si aún no lo ha aceptado el
      // exchange, esta intención se descarta y se vuelve a proponer en la vela siguiente.
      if (guard.state === 'open' && this.execution.cancel(guard.clientOrderId, outcome.approval.approval_id, `${intent.kind}: ${intent.reason}`)) {
        this.#replacing.set(guard.clientOrderId, { intent, approval: outcome.approval });
        this.#afterExecution(guard.clientOrderId);
        return;
      }
      this.#resolveStrategy(intent);
      return;
    }
    this.#submit(intent, outcome.approval);
  }

  #submit(intent: OrderIntent, approval: SignedApproval): void {
    const result = this.execution.submit(approval);
    this.#checkKillSwitch();
    if (!result.ok) {
      this.#resolveStrategy(intent);
      return;
    }
    const role = intent.kind === 'entry' ? 'entry' : intent.kind === 'exit' ? 'exit' : 'protective';
    this.#orders.set(result.clientOrderId, { symbol: intent.symbol, bucket: intent.bucket, intentId: intent.intentId, role, resolved: false });
    if (role === 'protective' && approval.trigger_price !== null) {
      this.#protection.set(intent.symbol, { clientOrderId: result.clientOrderId, trigger: Decimal.parse(approval.trigger_price), state: 'pending' });
    }
    this.#afterExecution(result.clientOrderId);
  }

  /** Las intenciones de la estrategia bloquean su símbolo hasta resolverse; las de stop, no. */
  #resolveStrategy(intent: OrderIntent): void {
    if (intent.kind === 'entry' || intent.kind === 'exit') this.strategy.onIntentResolved(intent.symbol);
  }

  /** Con posición y sin stop, propone el primero; con un stop que espera, lo sustituye si la estrategia lo subió. */
  #protect(symbol: SymbolId): void {
    if (this.strategy.isPending(symbol) || this.#halted !== null) return;
    const guard = this.#protection.get(symbol);
    if (guard !== undefined && (guard.state !== 'open' || this.#isReplacing(guard.clientOrderId))) return;
    const intent = this.strategy.protectiveStop(symbol, guard?.trigger ?? null, this.#config.clock.now());
    if (intent !== null) this.#onIntent(intent);
  }

  #isReplacing(clientOrderId: string): boolean {
    return this.#replacing.has(clientOrderId);
  }

  #onProtective(clientOrderId: string, context: OrderContext): void {
    const order = this.execution.order(clientOrderId);
    const guard = this.#protection.get(context.symbol);
    if (order === null || guard?.clientOrderId !== clientOrderId) return;
    if (order.state === 'OPEN') guard.state = 'open';
    if (!TERMINAL_STATES.has(order.state)) return;
    this.#protection.delete(context.symbol);
    const replacement = this.#replacing.get(clientOrderId);
    this.#replacing.delete(clientOrderId);
    // Cancelado: sale lo aprobado. Ejecutado antes de cancelarse: la posición ya se vendió y la salida sobra.
    if (replacement !== undefined && order.state === 'CANCELED') this.#submit(replacement.intent, replacement.approval);
    else if (replacement !== undefined) this.#resolveStrategy(replacement.intent);
    // Si queda posición sin stop (stop sin liquidez o ejecutado en parte), se vuelve a proteger. Un stop rechazado no se
    // repite en el acto, porque el exchange lo rechazaría igual: se vuelve a proponer con la vela siguiente, y si para
    // entonces el precio ya lo ha cruzado, sale como salida urgente (StrategyEngine.protectiveStop; paso 28).
    if (replacement === undefined && order.state !== 'REJECTED') this.#protect(context.symbol);
  }

  #onFill(fill: Fill): void {
    const context = this.#orders.get(fill.clientOrderId);
    if (context === undefined) throw new Error(`fill de una orden que el sistema no envió: ${fill.clientOrderId}`);
    this.portfolio.applyFill(fill, context.bucket);
    this.#config.journal('FillRecorded', fill);
  }

  #afterExecution(clientOrderId: string | null): void {
    if (clientOrderId !== null) {
      const order = this.execution.order(clientOrderId);
      const context = this.#orders.get(clientOrderId);
      if (order !== null) this.#config.journal('OrderStateChanged', { clientOrderId, state: order.state, filled: order.filled });
      if (context !== undefined && context.role === 'protective') this.#onProtective(clientOrderId, context);
      else if (order !== null && context !== undefined && !context.resolved && TERMINAL_STATES.has(order.state)) {
        context.resolved = true;
        this.strategy.onIntentResolved(context.symbol);
        if (context.role === 'entry') this.#protect(context.symbol);
      }
    }
    // Una duda pide una reconciliación (exchange-execution §3.2), una sola vez por cada entrada en UNKNOWN.
    if (isSendingBlocked(this.execution.status()) && !this.#reconciling && this.#halted === null) {
      this.#reconciling = true;
      this.#config.journal('ExecutionModeChanged', { mode: this.execution.status().mode, reason: this.execution.unknownReason });
      this.#config.venue.requestAccountSnapshot(null);
    }
  }

  #checkKillSwitch(): void {
    if (this.#killSwitchSeen || !this.risk.tradingState().killSwitch) return;
    this.#killSwitchSeen = true;
    this.#config.journal('KillSwitchChanged', { active: true });
    this.execution.onKillSwitch();
    this.#halt('kill switch activo');
  }

  #halt(reason: string): void {
    if (this.#halted !== null) return;
    this.#halted = reason;
    this.#config.journal('TradingHalted', { reason });
  }

  #sampleEquity(): void {
    const snapshot = this.portfolio.snapshot();
    const point: EquityPoint = Object.freeze({
      at: snapshot.asOf, equity: snapshot.equity, cash: snapshot.cash, exposure: snapshot.exposure, exposureWithoutDust: snapshot.exposureWithoutDust,
    });
    // Varios símbolos con el mismo instante dan una sola marca: la última.
    if (this.#equity.at(-1)?.at === point.at) this.#equity.pop();
    this.#equity.push(point);
  }
}
