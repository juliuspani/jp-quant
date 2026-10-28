// Bot de plan B: compras periódicas (DCA) y rebalanceo por bandas, en paper (paso 49, ADR 0048). Es un ejemplo de uso del
// sistema de ejecución, no una estrategia de investigación: no busca ventaja, reparte la entrada en el tiempo hacia un
// reparto objetivo que fija quien lo usa. El proyecto no recomienda ningún reparto.
// - Compone lo mismo que app/trading-system.ts (normalizador, cartera, Risk y Execution), pero en lugar de una estrategia
//   sigue un plan. Toda orden es una intención que pasa por Risk, que la dimensiona o la frena con sus límites y firma la
//   aprobación; Execution solo envía lo aprobado. Las intenciones llevan origin «system» y su motivo.
// - Las compras piden una cantidad (sizing «quantity») y declaran un stop amplio bajo el precio, con el que Risk mide la
//   pérdida máxima por operación. Tras cada compra, la posición entera queda protegida por un stop que espera en el
//   exchange (trading-risk §2.4). Para vender o para cubrir la cantidad nueva, Risk aprueba primero la orden que lo
//   sustituye (la venta o un stop_update); después se cancela el stop que espera y, confirmado, sale lo aprobado. Execution
//   no cancela un stop de protección sin esa aprobación.
// - Un símbolo con una orden sin resolver no recibe otra: esa compra o ese rebalanceo esperan al siguiente turno.
// - Fail closed como el sistema de trading: una duda en Execution pide reconciliar; el kill switch o una duda sin resolver
//   lo detienen.
// Anota en el diario los mismos eventos que app/trading-system.ts, así que el dashboard lo lee igual.
import type { Clock } from '../../src/kernel/clock.ts';
import {
  isSendingBlocked, TERMINAL_STATES, type AccountSnapshot, type ExecutionVenue, type ExecutionView, type Fill, type VenueOrderUpdate, type VenueRequestFailed,
} from '../../src/kernel/execution.ts';
import type { Candle, RawMarketData } from '../../src/kernel/market-data.ts';
import type { OrderIntent, SignedApproval } from '../../src/kernel/orders.ts';
import type { Ids } from '../../src/kernel/random.ts';
import type { ExecutionStore, RiskStore } from '../../src/kernel/stores.ts';
import { ExecutionEngine } from '../../src/execution/engine.ts';
import { MarketDataNormalizer } from '../../src/marketdata/normalizer.ts';
import { PortfolioLedger } from '../../src/portfolio/ledger.ts';
import { RiskEngine } from '../../src/risk/engine.ts';
import type { RiskLimits } from '../../src/risk/limits.ts';
import { Decimal, type Notional, type Price, type Quantity } from '../../src/shared/decimal.ts';
import type { SymbolId } from '../../src/shared/symbol.ts';
import type { UtcMillis } from '../../src/shared/time.ts';
import type { Journal } from '../../src/app/trading-system.ts';

export const PLAN_B_ID = 'plan-b-dca-rebalanceo';
export const PLAN_B_VERSION = '1.0.0';

export interface PlanBPlan {
  readonly target: Readonly<Record<SymbolId, string>>; // fracción del patrimonio por par, en texto decimal
  readonly contribution: string; // importe de cada compra periódica, repartido según el objetivo
  readonly everyMs: number; // cada cuánto se compra
  readonly rebalanceEveryMs: number; // cada cuánto se revisa el reparto
  readonly band: string; // desviación del objetivo, en fracción del patrimonio, que dispara el rebalanceo
  readonly stopFraction: string; // distancia del stop de protección bajo el precio medio de entrada
}

export interface PlanBConfig {
  readonly clock: Clock;
  readonly intentIds: Ids;
  readonly approvalIds: Ids; // UUID: el approval_id da el client order ID
  readonly venue: ExecutionVenue;
  readonly riskStore: RiskStore;
  readonly executionStore: ExecutionStore;
  readonly riskLimits: RiskLimits;
  readonly quoteCurrency: string;
  readonly startingCash: Notional;
  readonly commit: string;
  readonly orderTtlMs: number;
  readonly startAt: UtcMillis; // primera compra y primera revisión
  readonly journal: Journal;
  readonly plan: PlanBPlan;
}

type Role = 'buy' | 'sell' | 'stop';

interface OrderContext {
  readonly symbol: SymbolId;
  readonly role: Role;
  resolved: boolean;
}

interface Planned {
  readonly action: 'buy' | 'sell' | 'hold';
  readonly reason: string;
  readonly intent: OrderIntent | null;
}

const ZERO = Decimal.parse('0');
const ONE = Decimal.parse('1');
const SCALE = 12;

export class PlanBBot {
  readonly market = new MarketDataNormalizer();
  readonly portfolio: PortfolioLedger;
  readonly risk: RiskEngine;
  readonly execution: ExecutionEngine;
  readonly #config: PlanBConfig;
  readonly #target: ReadonlyMap<SymbolId, Decimal>;
  readonly #targetTotal: Decimal;
  readonly #orders = new Map<string, OrderContext>();
  readonly #busy = new Set<SymbolId>(); // compra o venta sin resolver
  readonly #stops = new Map<SymbolId, { readonly clientOrderId: string; state: 'pending' | 'open' }>();
  readonly #replacing = new Map<string, { readonly intent: OrderIntent; readonly approval: SignedApproval }>(); // por stop que se cancela
  #nextBuyAt: UtcMillis;
  #nextRebalanceAt: UtcMillis;
  #reconciling = false;
  #killSwitchSeen = false;
  #halted: string | null = null;

  constructor(config: PlanBConfig) {
    const plan = config.plan;
    const target = new Map<SymbolId, Decimal>();
    for (const [symbol, text] of Object.entries(plan.target)) target.set(symbol, Decimal.parse(text));
    const total = [...target.values()].reduce((sum, w) => sum.plus(w), ZERO);
    if (target.size === 0 || [...target.values()].some((w) => !w.isPositive()) || total.gt(ONE)) throw new RangeError('objetivo: fracciones positivas que sumen como mucho 1');
    const stop = Decimal.parse(plan.stopFraction);
    if (!stop.isPositive() || stop.gte(ONE)) throw new RangeError('stopFraction debe estar en (0, 1)');
    if (!Decimal.parse(plan.contribution).isPositive() || !Decimal.parse(plan.band).isPositive()) throw new RangeError('contribution y band deben ser positivos');
    if (!(plan.everyMs > 0) || !(plan.rebalanceEveryMs > 0)) throw new RangeError('los periodos deben ser positivos');
    this.#config = config;
    this.#target = target;
    this.#targetTotal = total;
    this.#nextBuyAt = config.startAt;
    this.#nextRebalanceAt = (config.startAt + plan.rebalanceEveryMs) as UtcMillis;
    this.portfolio = new PortfolioLedger({ clock: config.clock, market: this.market, quoteCurrency: config.quoteCurrency, startingCash: config.startingCash });
    let execution: ExecutionEngine | null = null;
    const view: ExecutionView = {
      status: () => {
        if (execution === null) throw new Error('Execution aún no está construido');
        return execution.status();
      },
    };
    this.risk = new RiskEngine({
      clock: config.clock, ids: config.approvalIds, store: config.riskStore, market: this.market, portfolio: this.portfolio, execution: view,
      limits: config.riskLimits, commit: config.commit,
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
      onFill: (fill) => this.#onFill(fill),
      orderTtlMs: config.orderTtlMs,
    });
    this.execution = execution;
  }

  get halted(): string | null {
    return this.#halted;
  }

  /** Próxima revisión del reparto, para la ficha del dashboard. */
  get nextRebalanceAt(): UtcMillis {
    return this.#nextRebalanceAt;
  }

  /** Arranque: Execution empieza en UNKNOWN y pide la foto de la cuenta para reconciliar. */
  start(): void {
    this.#reconciling = true;
    this.#config.venue.requestAccountSnapshot(null);
  }

  /** Lo recibido en un mismo instante: se ingiere todo y después se decide, como app/trading-system.ts. */
  onMarketBatch(raws: readonly RawMarketData[], receivedTime: UtcMillis): void {
    const closed: Candle[] = [];
    for (const raw of raws) {
      for (const event of this.market.ingest(raw, receivedTime)) {
        if (event.type === 'CandleClosed') closed.push(event.candle);
        else this.#config.journal(event.type, event);
      }
    }
    if (closed.length === 0) return;
    const planned = this.#plan(receivedTime, closed);
    for (const candle of closed) {
      const step = planned.get(candle.symbol) ?? { action: 'hold', reason: 'fuera del plan', intent: null };
      this.#config.journal('StrategyEvaluated', { symbol: candle.symbol, asOf: candle.closeTime, action: step.action, reason: step.reason, note: null });
      if (step.intent !== null) this.#onIntent(step.intent);
      else this.#protect(candle.symbol);
    }
  }

  onVenueUpdate(update: VenueOrderUpdate): void {
    this.#config.journal('VenueOrderUpdate', update);
    this.execution.onVenueUpdate(update);
    this.#afterExecution(update.clientOrderId);
  }

  onVenueFailure(failure: VenueRequestFailed): void {
    this.#config.journal('VenueRequestFailed', failure);
    this.execution.onVenueFailure(failure);
    this.#afterExecution(failure.clientOrderId);
  }

  onAccountSnapshot(snapshot: AccountSnapshot): void {
    this.#config.journal('AccountSnapshotReceived', snapshot);
    const resolved = this.execution.reconcile(snapshot.orders);
    this.#reconciling = false;
    this.#config.journal('ReconciliationCompleted', { resolved, mode: this.execution.status().mode, reason: this.execution.unknownReason });
    for (const order of snapshot.orders) this.#afterExecution(order.clientOrderId);
    if (!resolved) this.#halt(`UNKNOWN sin resolver tras reconciliar: ${this.execution.unknownReason ?? 'sin motivo'}`);
  }

  /** Qué toca en este instante: el rebalanceo, si vence, va antes que la compra periódica. */
  #plan(now: UtcMillis, closed: readonly Candle[]): Map<SymbolId, Planned> {
    const out = new Map<SymbolId, Planned>();
    if (this.#halted !== null || isSendingBlocked(this.execution.status())) return out;
    const rebalance = now >= this.#nextRebalanceAt;
    const buy = now >= this.#nextBuyAt;
    if (!rebalance && !buy) return out;
    while (this.#nextRebalanceAt <= now) this.#nextRebalanceAt = (this.#nextRebalanceAt + this.#config.plan.rebalanceEveryMs) as UtcMillis;
    while (this.#nextBuyAt <= now) this.#nextBuyAt = (this.#nextBuyAt + this.#config.plan.everyMs) as UtcMillis;
    const snapshot = this.portfolio.snapshot();
    const equity = snapshot.equity;
    if (!equity.isPositive()) return out;
    const band = Decimal.parse(this.#config.plan.band);
    for (const candle of closed) {
      const symbol = candle.symbol;
      const weight = this.#target.get(symbol);
      if (weight === undefined) continue;
      if (this.#busy.has(symbol)) {
        out.set(symbol, { action: 'hold', reason: 'orden anterior sin resolver', intent: null });
        continue;
      }
      const quote = this.market.quote(symbol);
      const instrument = this.market.instrument(symbol);
      if (quote === null || instrument === null || !instrument.tradable) continue;
      const held = snapshot.positions.find((p) => p.symbol === symbol);
      const value = (held?.quantity ?? ZERO).times(quote.bid);
      const goal = equity.times(weight);
      const deviation = value.minus(goal).div(equity, SCALE, 'HALF_EVEN');
      let amount: Decimal | null = null;
      let reason = '';
      if (rebalance && deviation.gt(band)) {
        const quantity = Decimal.min(value.minus(goal).div(quote.bid, SCALE, 'DOWN'), held?.available ?? ZERO).roundToStep(instrument.quantityStep, 'DOWN');
        if (quantity.isPositive() && quantity.times(quote.bid).gte(instrument.minNotional)) {
          out.set(symbol, { action: 'sell', reason: `rebalanceo: ${pct(deviation)} por encima del objetivo`, intent: this.#exit(symbol, quantity, candle, 'rebalanceo: vender el exceso') });
          continue;
        }
      } else if (rebalance && deviation.lt(band.times(Decimal.parse('-1')))) {
        amount = goal.minus(value);
        reason = `rebalanceo: ${pct(deviation.abs())} por debajo del objetivo`;
      }
      if (amount === null && buy) {
        const share = Decimal.parse(this.#config.plan.contribution).times(weight).div(this.#targetTotal, SCALE, 'DOWN');
        const missing = goal.minus(value);
        if (missing.isPositive()) {
          amount = Decimal.min(share, missing);
          reason = 'compra periódica (DCA)';
        } else {
          out.set(symbol, { action: 'hold', reason: 'objetivo alcanzado', intent: null });
          continue;
        }
      }
      if (amount === null) continue;
      const quantity = amount.div(quote.ask, SCALE, 'DOWN').roundToStep(instrument.quantityStep, 'DOWN');
      if (!quantity.isPositive() || quantity.times(quote.ask).lt(instrument.minNotional)) {
        out.set(symbol, { action: 'hold', reason: 'por debajo del importe mínimo', intent: null });
        continue;
      }
      const stop = quote.ask.times(ONE.minus(Decimal.parse(this.#config.plan.stopFraction))).roundToStep(instrument.priceStep, 'UP');
      out.set(symbol, { action: 'buy', reason, intent: this.#entry(symbol, quantity, stop, candle, reason) });
    }
    return out;
  }

  #base(symbol: SymbolId, reason: string, signalTime: UtcMillis): Pick<OrderIntent, 'intentId' | 'origin' | 'strategyId' | 'strategyVersion' | 'bucket' | 'symbol' | 'reason' | 'signalTime'> {
    return { intentId: this.#config.intentIds.next(), origin: 'system', strategyId: PLAN_B_ID, strategyVersion: PLAN_B_VERSION, bucket: 'core', symbol, reason, signalTime };
  }

  #entry(symbol: SymbolId, quantity: Quantity, stop: Price, candle: Candle, reason: string): OrderIntent {
    return Object.freeze({
      ...this.#base(symbol, reason, candle.closeTime), side: 'buy', kind: 'entry', reduceOnly: false, sizing: Object.freeze({ mode: 'quantity', quantity }), stopPrice: stop,
    });
  }

  #exit(symbol: SymbolId, quantity: Quantity, candle: Candle, reason: string): OrderIntent {
    return Object.freeze({
      ...this.#base(symbol, reason, candle.closeTime), side: 'sell', kind: 'exit', reduceOnly: true, sizing: Object.freeze({ mode: 'quantity', quantity }), stopPrice: null,
    });
  }

  #onIntent(intent: OrderIntent): void {
    const journal = this.#config.journal;
    const trades = intent.kind === 'entry' || intent.kind === 'exit';
    if (trades) this.#busy.add(intent.symbol);
    journal('OrderIntentCreated', intent);
    const outcome = this.risk.evaluate(intent);
    journal('RiskDecisionMade', outcome.decision);
    this.#checkKillSwitch();
    if (outcome.approval === null) {
      if (trades) this.#busy.delete(intent.symbol);
      return;
    }
    const { signature, ...approval } = outcome.approval;
    journal('OrderApproved', { ...approval, signed: signature !== '' });
    const guard = this.#stops.get(intent.symbol);
    if ((intent.kind === 'exit' || intent.kind === 'stop_update') && guard !== undefined) {
      // Primero se cancela el stop que espera y, confirmado, sale lo aprobado.
      if (guard.state === 'open' && !this.#replacing.has(guard.clientOrderId) && this.execution.cancel(guard.clientOrderId, outcome.approval.approval_id, `${intent.kind}: ${intent.reason}`)) {
        this.#replacing.set(guard.clientOrderId, { intent, approval: outcome.approval });
        this.#afterExecution(guard.clientOrderId);
        return;
      }
      if (trades) this.#busy.delete(intent.symbol);
      return;
    }
    this.#submit(intent, outcome.approval);
  }

  #submit(intent: OrderIntent, approval: SignedApproval): void {
    const result = this.execution.submit(approval);
    this.#checkKillSwitch();
    const role: Role = intent.kind === 'entry' ? 'buy' : intent.kind === 'exit' ? 'sell' : 'stop';
    if (!result.ok) {
      if (role !== 'stop') this.#busy.delete(intent.symbol);
      return;
    }
    this.#orders.set(result.clientOrderId, { symbol: intent.symbol, role, resolved: false });
    if (role === 'stop') this.#stops.set(intent.symbol, { clientOrderId: result.clientOrderId, state: 'pending' });
    this.#afterExecution(result.clientOrderId);
  }

  /** Con posición, sin orden pendiente y sin stop, propone el stop de toda la posición bajo su precio medio. */
  #protect(symbol: SymbolId): void {
    if (this.#halted !== null || this.#busy.has(symbol) || this.#stops.has(symbol)) return;
    const intent = this.#stopIntent(symbol, 'protective_stop', 'stop de protección del plan');
    if (intent !== null) this.#onIntent(intent);
  }

  /** Tras una compra, el stop tiene que cubrir la cantidad nueva: un stop_update, aprobado por Risk, sustituye al que espera. */
  #refreshStop(symbol: SymbolId): void {
    const guard = this.#stops.get(symbol);
    if (guard === undefined) {
      this.#protect(symbol);
      return;
    }
    const intent = this.#stopIntent(symbol, 'stop_update', 'stop de protección: la posición cambió');
    if (guard.state === 'open' && intent !== null) this.#onIntent(intent);
  }

  /** El stop de toda la posición, a stopFraction bajo su precio medio de entrada; null sin posición que proteger. */
  #stopIntent(symbol: SymbolId, kind: 'protective_stop' | 'stop_update', reason: string): OrderIntent | null {
    const held = this.portfolio.snapshot().positions.find((p) => p.symbol === symbol);
    const instrument = this.market.instrument(symbol);
    if (held === undefined || !held.quantity.isPositive() || !held.dust.isZero() || instrument === null) return null;
    const trigger = held.averageEntry.times(ONE.minus(Decimal.parse(this.#config.plan.stopFraction))).roundToStep(instrument.priceStep, 'UP');
    return Object.freeze({
      ...this.#base(symbol, reason, this.#config.clock.now()), side: 'sell', kind, reduceOnly: true, sizing: Object.freeze({ mode: 'all' }), stopPrice: trigger,
    });
  }

  #onStop(clientOrderId: string, context: OrderContext): void {
    const order = this.execution.order(clientOrderId);
    const guard = this.#stops.get(context.symbol);
    if (order === null || guard?.clientOrderId !== clientOrderId) return;
    if (order.state === 'OPEN') guard.state = 'open';
    if (!TERMINAL_STATES.has(order.state)) return;
    this.#stops.delete(context.symbol);
    const replacement = this.#replacing.get(clientOrderId);
    this.#replacing.delete(clientOrderId);
    // Cancelado: sale la venta aprobada. Ejecutado antes: la posición ya se vendió y la venta sobra.
    if (replacement !== undefined && order.state === 'CANCELED') this.#submit(replacement.intent, replacement.approval);
    else if (replacement?.intent.kind === 'exit') this.#busy.delete(context.symbol);
    else if (order.state !== 'REJECTED') this.#protect(context.symbol);
  }

  #onFill(fill: Fill): void {
    if (!this.#orders.has(fill.clientOrderId)) throw new Error(`fill de una orden que el bot no envió: ${fill.clientOrderId}`);
    this.portfolio.applyFill(fill, 'core');
    this.#config.journal('FillRecorded', fill);
  }

  #afterExecution(clientOrderId: string | null): void {
    if (clientOrderId !== null) {
      const order = this.execution.order(clientOrderId);
      const context = this.#orders.get(clientOrderId);
      if (order !== null) this.#config.journal('OrderStateChanged', { clientOrderId, state: order.state, filled: order.filled });
      if (context?.role === 'stop') this.#onStop(clientOrderId, context);
      else if (order !== null && context !== undefined && !context.resolved && TERMINAL_STATES.has(order.state)) {
        context.resolved = true;
        this.#busy.delete(context.symbol);
        if (context.role === 'buy') this.#refreshStop(context.symbol);
        else this.#protect(context.symbol);
      }
    }
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
}

function pct(fraction: Decimal): string {
  return `${fraction.times(Decimal.parse('100')).roundToStep(Decimal.parse('0.1'), 'HALF_EVEN').toString()} %`;
}
