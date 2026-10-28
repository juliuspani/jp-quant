// Execution mínimo del paso 20, solo simulado (ADR 0023), con las interfaces definitivas de ARCHITECTURE.md §16.7: el
// paso 36 añade la cola, las órdenes límite, la reconciliación completa, NOT_SENT y los límites de peticiones sin
// cambiar el contrato. Hoy no existe ningún venue real: el que recibe es el simulado (backtest/ o una prueba). Desde el
// paso 23 (ADR 0026) envía también stops de protección a mercado, sin TTL y con el disparo firmado en el token, y los
// cancela solo con la aprobación de una salida o de una sustitución (trading-risk §2.2).
//
// Al recibir un token comprueba, en orden: kill switch, token (trading-risk §2.2, pasos 1 a 4), modo UNKNOWN, reglas
// del mercado y coincidencia con lo aprobado (paso 5, ya redondeada la cantidad). Después guarda en una transacción
// el token usado y la orden en PENDING_SEND, la pasa a SENT y la entrega al venue. Cada respuesta mueve la orden por
// la máquina de estados; cualquier duda o evento imposible la deja en UNKNOWN y para los envíos (exchange-execution §3).
import type { KeyObject } from 'node:crypto';
import type { Clock } from '../kernel/clock.ts';
import {
  isSendingBlocked,
  type ExecutionMode,
  type ExecutionRejected,
  type ExecutionStatus,
  type ExecutionVenue,
  type ExecutionView,
  type Fill,
  type OrderRecord,
  type OrderState,
  type TransitionOrigin,
  type VenueOrderUpdate,
  type VenueRequestFailed,
} from '../kernel/execution.ts';
import type { MarketView } from '../kernel/market-data.ts';
import type { DecisionDetail, RiskView } from '../kernel/orders.ts';
import type { PortfolioView } from '../kernel/portfolio.ts';
import type { ReasonCode } from '../kernel/reason-codes.ts';
import type { ExecutionStore } from '../kernel/stores.ts';
import { Decimal, type Quantity } from '../shared/decimal.ts';
import { addMs, type UtcMillis } from '../shared/time.ts';
import { parseApproval, verifyApproval, type ApprovedOrder } from '../risk/approval.ts';
import { clientOrderIdFor } from './client-order-id.ts';
import { canTransition, isTerminal } from './state-machine.ts';

/** TTL máximo de una orden que no es un stop de protección (exchange-execution §9.3). */
export const MAX_ORDER_TTL_MS = 300_000;

export interface ExecutionEngineDeps {
  readonly clock: Clock;
  readonly venue: ExecutionVenue;
  readonly store: ExecutionStore;
  readonly market: MarketView;
  readonly portfolio: PortfolioView;
  readonly risk: RiskView;
  readonly approvalKey: KeyObject; // clave pública del Risk Engine de este arranque
  readonly onRejected: (rejected: ExecutionRejected) => void; // Risk lo persiste; si no puede, lanza
  readonly onFill: (fill: Fill) => void; // FillRecorded: cada fill nuevo, una sola vez, para Portfolio (paso 23)
  readonly orderTtlMs: number;
}

export type SubmitResult = { readonly ok: true; readonly clientOrderId: string } | { readonly ok: false; readonly reasonCode: ReasonCode };

const ZERO = Decimal.parse('0');
const STATE_OF: Readonly<Record<VenueOrderUpdate['status'], OrderState | null>> = {
  open: 'OPEN',
  partially_filled: 'PARTIALLY_FILLED',
  filled: 'FILLED',
  canceled: 'CANCELED',
  expired: 'EXPIRED',
  rejected: 'REJECTED',
  not_found: null, // duda: NOT_SENT exige las condiciones de exchange-execution §9.2 (paso 36)
  not_transmitted: null, // solo ShadowVenue (paso 32)
};
const CANCELABLE: ReadonlySet<OrderState> = new Set(['OPEN', 'PARTIALLY_FILLED']);
const PROTECTIVE_TYPES: ReadonlySet<string> = new Set(['stop_market', 'stop_limit']);
const IN_FLIGHT: ReadonlySet<OrderState> = new Set(['PENDING_SEND', 'SENT', 'CANCEL_PENDING', 'UNKNOWN']);

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class ExecutionEngine implements ExecutionView {
  readonly #deps: ExecutionEngineDeps;
  readonly #orders = new Map<string, OrderRecord>();
  #mode: ExecutionMode = 'UNKNOWN'; // siempre se arranca en UNKNOWN (exchange-execution §16)
  #unknownReason: string | null = 'arranque: falta reconciliar';
  #lastReconciledAt: UtcMillis | null = null;
  readonly #doubtLog: string[] = []; // motivo de cada duda, en orden

  constructor(deps: ExecutionEngineDeps) {
    if (!Number.isSafeInteger(deps.orderTtlMs) || deps.orderTtlMs <= 0 || deps.orderTtlMs > MAX_ORDER_TTL_MS) {
      throw new RangeError(`CONFIG_INVALID: orderTtlMs debe ser un entero de ms en (0, ${String(MAX_ORDER_TTL_MS)}]`);
    }
    this.#deps = deps;
    for (const order of deps.store.loadNonTerminal()) this.#orders.set(order.clientOrderId, order);
  }

  status(): ExecutionStatus {
    return Object.freeze({
      mode: this.#mode,
      lastReconciledAt: this.#lastReconciledAt,
      blockedSymbols: Object.freeze([]),
      rateLimitedUntil: null,
      unprotectedPositions: Object.freeze([]),
    });
  }

  /** Por qué está en UNKNOWN, o null. */
  get unknownReason(): string | null {
    return this.#unknownReason;
  }

  order(clientOrderId: string): OrderRecord | null {
    return this.#orders.get(clientOrderId) ?? null;
  }

  /** Recibe un token de OrderApproved. Una orden sin token válido de Risk no sale nunca. */
  submit(approval: unknown): SubmitResult {
    const now = this.#deps.clock.now();
    if (this.#deps.risk.tradingState().killSwitch) return this.#reject('KILL_SWITCH_ACTIVE', approval, {});

    const check = verifyApproval(approval, this.#deps.approvalKey, now);
    if (!check.ok) return this.#reject(check.reasonCode, approval, {});
    const approved = check.order;
    if (this.#deps.store.isApprovalUsed(approved.approval_id)) return this.#reject('APPROVAL_REPLAYED', approved, {});
    if (isSendingBlocked(this.status())) return this.#reject('EXEC_STATE_UNKNOWN', approved, { unknownReason: this.#unknownReason });

    const instrument = this.#deps.market.instrument(approved.symbol);
    if (instrument === null || !instrument.tradable || instrument.symbol !== approved.symbol) {
      return this.#reject('EXEC_MARKET_RULES', approved, { instrument: instrument === null ? 'sin datos' : 'no negociable' });
    }
    // Órdenes a mercado y, desde el paso 23, stops de protección a mercado (venta reduce_only con su disparo firmado).
    const protective = PROTECTIVE_TYPES.has(approved.type);
    if (approved.type !== 'market' && !(approved.type === 'stop_market' && approved.side === 'sell' && approved.reduce_only)) {
      return this.#reject('EXEC_MARKET_RULES', approved, { type: `${approved.type}: límite y stop-limit llegan en el paso 36` });
    }
    const trigger = approved.trigger_price === null ? null : Decimal.parse(approved.trigger_price);
    if (protective && (trigger === null || !trigger.roundToStep(instrument.priceStep, 'DOWN').eq(trigger))) {
      return this.#reject('EXEC_MARKET_RULES', approved, { trigger: approved.trigger_price, priceStep: instrument.priceStep.toString() });
    }
    // El redondeo nunca aumenta el riesgo: la cantidad, siempre a la baja (exchange-execution §7).
    const quantity = Decimal.parse(approved.max_quantity).roundToStep(instrument.quantityStep, 'DOWN');
    if (!quantity.isPositive() || quantity.lt(instrument.minQuantity)) {
      return this.#reject('EXEC_MARKET_RULES', approved, { quantity: quantity.toString(), minQuantity: instrument.minQuantity.toString() });
    }
    const mismatch = this.#mismatch(approved, quantity);
    if (mismatch !== null) return this.#reject(mismatch.code, approved, mismatch.detail);

    // Persistir antes de actuar (exchange-execution §5.2): si la transacción lanza, no sale nada.
    const clientOrderId = clientOrderIdFor(approved.approval_id);
    const record: OrderRecord = Object.freeze({
      clientOrderId,
      approvalId: approved.approval_id,
      intentId: approved.intent_id,
      symbol: approved.symbol,
      side: approved.side,
      type: approved.type,
      reduceOnly: approved.reduce_only,
      quantity,
      limitPrice: null,
      triggerPrice: trigger,
      expiresAt: protective ? null : addMs(now, this.#deps.orderTtlMs), // un stop de protección no caduca (§9.3)
      createdAt: now,
      state: 'PENDING_SEND',
      filled: ZERO,
    });
    this.#deps.store.reserveAndInsert(approved.approval_id, record);
    this.#orders.set(clientOrderId, record);
    this.#move(clientOrderId, 'SENT', ZERO, 'internal', null, 'entregada al venue');
    try {
      this.#deps.venue.submit({
        clientOrderId,
        approval: approved,
        symbol: record.symbol,
        side: record.side,
        type: record.type,
        quantity,
        limitPrice: null,
        triggerPrice: trigger,
        expiresAt: record.expiresAt,
      });
    } catch (error) {
      // Pudo salir o no: es una duda, nunca un «no enviada» (exchange-execution §1.3).
      this.#doubt(clientOrderId, `el venue lanzó al enviar: ${message(error)}`);
    }
    return { ok: true, clientOrderId };
  }

  /** Respuesta del venue sobre una orden (REST, WebSocket o reconciliación). */
  onVenueUpdate(update: VenueOrderUpdate): void {
    this.#apply(update, update.origin);
  }

  /** Fallo de una petición al venue (exchange-execution §10.1). */
  onVenueFailure(failure: VenueRequestFailed): void {
    if (failure.operation === 'query' || failure.operation === 'snapshot') return; // lecturas: no cambian ninguna orden
    const id = failure.clientOrderId;
    const order = id === null ? undefined : this.#orders.get(id);
    if (id === null || order === undefined) {
      this.#enterUnknown(`fallo de ${failure.operation} sobre una orden que no consta: ${id ?? 'sin id'}`);
      return;
    }
    // Rechazo definitivo del exchange al enviar (exchange-execution §7): REJECTED, sin reintento.
    if (failure.operation === 'submit' && order.state === 'SENT' && failure.errorClass === 'rejected') {
      this.#move(id, 'REJECTED', order.filled, 'internal', null, `rechazada por el exchange: ${failure.detail}`);
      this.#emit('EXCHANGE_REJECTED', 'exchange', order, { errorClass: failure.errorClass, detail: failure.detail });
      return;
    }
    // Timeout, red, saldo, límites, credenciales o desconocido al crear o cancelar: duda (exchange-execution §3.1). Los
    // rechazos del capguard y de LIVE_TRADING también, hasta que existan sus venues (pasos 32 y 39).
    this.#doubt(id, `fallo de ${failure.operation}: ${failure.errorClass} (${failure.detail})`);
  }

  /**
   * Reconciliación mínima (exchange-execution §14.2, paso 3): aplica el estado que confirma el venue a cada orden local.
   * Sale de UNKNOWN solo si todas las órdenes vivas quedan confirmadas y no aparece ninguna orden que no conste. Los
   * saldos, los fills desde la última marca, las huérfanas y los stops nativos llegan en el paso 36.
   */
  reconcile(venueOrders: readonly VenueOrderUpdate[]): boolean {
    const doubtsBefore = this.#doubtLog.length;
    let resolved = true;
    for (const update of venueOrders) {
      if (!this.#orders.has(update.clientOrderId)) resolved = false;
      this.#apply(update, 'reconciliation');
    }
    const confirmed = new Set(venueOrders.map((u) => u.clientOrderId));
    for (const order of this.#orders.values()) {
      if (isTerminal(order.state)) continue;
      if (IN_FLIGHT.has(order.state) || !confirmed.has(order.clientOrderId)) resolved = false;
    }
    if (this.#doubtLog.length !== doubtsBefore) resolved = false; // la propia reconciliación encontró una duda
    if (resolved) {
      this.#mode = 'NORMAL';
      this.#unknownReason = null;
      this.#lastReconciledAt = this.#deps.clock.now();
    }
    return resolved;
  }

  /**
   * Cancela una orden propia viva (exchange-execution §8). Un stop de protección solo se cancela como parte de una salida
   * o de una sustitución aprobadas por Risk (trading-risk §2.2): sin ese approvalId, se niega. Devuelve si la pidió.
   */
  cancel(clientOrderId: string, approvalId: string | null, reason: string): boolean {
    const order = this.#orders.get(clientOrderId);
    if (order === undefined || !CANCELABLE.has(order.state)) return false;
    if (PROTECTIVE_TYPES.has(order.type) && approvalId === null) return false;
    this.#move(clientOrderId, 'CANCEL_PENDING', order.filled, 'internal', null, reason);
    try {
      this.#deps.venue.cancel({ clientOrderId, reason, approvalId });
    } catch (error) {
      this.#doubt(clientOrderId, `el venue lanzó al cancelar: ${message(error)}`);
    }
    return true;
  }

  /**
   * Kill switch activo (trading-risk §6): cancela las órdenes propias abiertas y mantiene los stops de protección.
   * Las que están en duda no se tocan: las resuelve la reconciliación. Devuelve las que pidió cancelar.
   */
  onKillSwitch(): readonly string[] {
    const canceled: string[] = [];
    for (const order of [...this.#orders.values()]) {
      if (!CANCELABLE.has(order.state) || PROTECTIVE_TYPES.has(order.type)) continue;
      this.#move(order.clientOrderId, 'CANCEL_PENDING', order.filled, 'internal', null, 'kill switch');
      canceled.push(order.clientOrderId);
      try {
        this.#deps.venue.cancel({ clientOrderId: order.clientOrderId, reason: 'kill switch', approvalId: null });
      } catch (error) {
        this.#doubt(order.clientOrderId, `el venue lanzó al cancelar: ${message(error)}`);
      }
    }
    return Object.freeze(canceled);
  }

  #mismatch(approved: ApprovedOrder, quantity: Quantity): { code: ReasonCode; detail: DecisionDetail } | null {
    if (approved.side === 'buy') {
      const ask = this.#deps.market.quote(approved.symbol)?.ask ?? null;
      if (ask === null || approved.max_notional === null) return { code: 'APPROVAL_MISMATCH', detail: { price: 'sin precio de envío' } };
      const notional = quantity.times(ask);
      if (notional.gt(Decimal.parse(approved.max_notional))) {
        return { code: 'APPROVAL_MISMATCH', detail: { notional: notional.toString(), maxNotional: approved.max_notional } };
      }
      return null;
    }
    const position = this.#deps.portfolio.snapshot().positions.find((p) => p.symbol === approved.symbol);
    const available = position?.available ?? ZERO;
    if (!approved.reduce_only || quantity.gt(available)) {
      return { code: 'APPROVAL_MISMATCH', detail: { quantity: quantity.toString(), available: available.toString() } };
    }
    return null;
  }

  #apply(update: VenueOrderUpdate, origin: TransitionOrigin): void {
    const order = this.#orders.get(update.clientOrderId);
    if (order === undefined) {
      this.#enterUnknown(`actualización de una orden que no consta: ${update.clientOrderId}`);
      return;
    }
    const target = STATE_OF[update.status];
    const same = target === order.state && update.filled.eq(order.filled);
    if (same && update.fills.length === 0) return; // el mismo evento repetido: idempotente
    if (target === null) {
      this.#doubt(order.clientOrderId, `el venue responde ${update.status}`);
      return;
    }
    if (order.state === 'UNKNOWN' && origin !== 'reconciliation') return; // de UNKNOWN solo saca la reconciliación
    const problem = this.#impossible(order, target, update, origin);
    if (problem !== null) {
      this.#doubt(order.clientOrderId, problem);
      return;
    }
    for (const fill of update.fills) {
      if (this.#deps.store.insertFill(fill)) this.#deps.onFill(fill); // idempotente por símbolo y trade_id
    }
    if (!same) this.#move(order.clientOrderId, target, update.filled, origin, update.exchangeTime, `venue: ${update.status}`);
    if (target === 'REJECTED' && order.state !== 'REJECTED') {
      this.#emit('EXCHANGE_REJECTED', 'exchange', order, { exchangeRejectCode: update.exchangeRejectCode });
    }
  }

  #impossible(order: OrderRecord, target: OrderState, update: VenueOrderUpdate, origin: TransitionOrigin): string | null {
    if (target !== order.state && !canTransition(order.state, target, origin)) return `transición imposible: ${order.state} → ${target}`;
    const filled = update.filled;
    if (filled.lt(order.filled)) return `el filled baja: ${order.filled.toString()} → ${filled.toString()}`;
    if (filled.gt(order.quantity)) return `el filled supera la cantidad: ${filled.toString()} > ${order.quantity.toString()}`;
    if (target === 'FILLED' && !filled.eq(order.quantity)) return 'FILLED sin la cantidad completa';
    if (target === 'PARTIALLY_FILLED' && (!filled.isPositive() || filled.eq(order.quantity))) return 'PARTIALLY_FILLED sin ejecución parcial';
    if ((target === 'OPEN' || target === 'REJECTED') && !filled.isZero()) return `${target} con ejecución`;
    if (target === order.state && target !== 'PARTIALLY_FILLED' && !filled.eq(order.filled)) return `${target} repetido con otro filled`;
    for (const fill of update.fills) {
      if (fill.clientOrderId !== order.clientOrderId || fill.symbol !== order.symbol || fill.side !== order.side) {
        return `fill ${fill.tradeId} que no es de esta orden`;
      }
    }
    return null;
  }

  #move(clientOrderId: string, to: OrderState, filled: Quantity, origin: TransitionOrigin, exchangeTime: UtcMillis | null, reason: string): void {
    const order = this.#orders.get(clientOrderId);
    if (order === undefined) throw new Error(`orden que no consta: ${clientOrderId}`);
    this.#deps.store.appendTransition({
      clientOrderId,
      from: order.state,
      to,
      filled,
      origin,
      exchangeTime,
      localTime: this.#deps.clock.now(),
      reason,
    });
    this.#orders.set(clientOrderId, Object.freeze({ ...order, state: to, filled }));
  }

  #doubt(clientOrderId: string, reason: string): void {
    const order = this.#orders.get(clientOrderId);
    if (order !== undefined && !isTerminal(order.state) && order.state !== 'UNKNOWN') {
      this.#move(clientOrderId, 'UNKNOWN', order.filled, 'internal', null, reason);
    }
    this.#enterUnknown(`${clientOrderId}: ${reason}`);
  }

  #enterUnknown(reason: string): void {
    this.#mode = 'UNKNOWN';
    this.#unknownReason = reason;
    this.#doubtLog.push(reason);
  }

  #emit(code: ReasonCode, layer: ExecutionRejected['layer'], order: OrderRecord, detail: DecisionDetail): void {
    this.#deps.onRejected(Object.freeze({
      approvalId: order.approvalId,
      intentId: order.intentId,
      layer,
      reasonCode: code,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      notional: null,
      detail: Object.freeze({ clientOrderId: order.clientOrderId, ...detail }),
    }));
  }

  #reject(code: ReasonCode, approval: unknown, detail: DecisionDetail): SubmitResult {
    // Lo que se presentó, aunque no se haya podido verificar: sirve para encontrar el rechazo, no para decidir.
    const shown = parseApproval(approval);
    this.#deps.onRejected(Object.freeze({
      approvalId: shown?.approval_id ?? null,
      intentId: shown?.intent_id ?? null,
      layer: 'execution',
      reasonCode: code,
      symbol: shown?.symbol ?? null,
      side: shown?.side ?? null,
      quantity: shown === null ? null : Decimal.parse(shown.max_quantity),
      notional: shown === null || shown.max_notional === null ? null : Decimal.parse(shown.max_notional),
      detail: Object.freeze({ ...detail }),
    }));
    return { ok: false, reasonCode: code };
  }
}
