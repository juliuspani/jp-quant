// Contratos de Execution y de los venues (ARCHITECTURE.md §16.7, exchange-execution §4). Los estados son los de
// exchange-execution §4.1; la correspondencia con los nombres del prompt del paso 20 está en el ADR 0023.
import type { Decimal, Price, Quantity } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { UtcMillis } from '../shared/time.ts';
import type { Side } from '../shared/trading.ts';
import type { DecisionDetail, OrderType, SignedApproval } from './orders.ts';
import type { ReasonCode } from './reason-codes.ts';

export type OrderState =
  | 'PENDING_SEND' | 'SENT' | 'OPEN' | 'PARTIALLY_FILLED' | 'CANCEL_PENDING'
  | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'NOT_SENT' | 'UNKNOWN';
/** Una orden terminal no cambia nunca (exchange-execution §4.3). */
export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'NOT_SENT']);
export type ExecutionMode = 'NORMAL' | 'UNKNOWN';
export type TransitionOrigin = 'rest' | 'ws' | 'reconciliation' | 'internal';

export interface SubmitOrder {
  readonly clientOrderId: string; // 'ijp-' + approval_id en base64url (exchange-execution §5.1)
  readonly approval: SignedApproval; // el capguard la vuelve a verificar
  readonly symbol: SymbolId;
  readonly side: Side;
  readonly type: OrderType;
  readonly quantity: Quantity; // ya redondeada al paso, a la baja
  readonly limitPrice: Price | null;
  readonly triggerPrice: Price | null;
  readonly expiresAt: UtcMillis | null; // TTL; null solo en los stops de protección
}
export interface CancelOrder {
  readonly clientOrderId: string;
  readonly reason: string;
  readonly approvalId: string | null; // obligatorio si cancela un stop de protección (trading-risk §2.2)
}
// Puerto de ejecución: SimulatedVenue (backtest/), ShadowVenue y LiveVenue (exchange/).
// No bloquea: cada resultado vuelve como VenueOrderUpdate o VenueRequestFailed.
export interface ExecutionVenue {
  submit(order: SubmitOrder): void;
  cancel(order: CancelOrder): void;
  queryOrder(clientOrderId: string): void;
  requestAccountSnapshot(fillsSince: UtcMillis | null): void; // saldos, órdenes abiertas y fills, para reconciliar
}

export interface Fill {
  readonly tradeId: string;
  readonly clientOrderId: string;
  readonly symbol: SymbolId;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: Price;
  readonly fee: Decimal;
  readonly feeCurrency: string;
  readonly feeEstimated: boolean; // true solo si el dato faltaba (exchange-execution §6)
  readonly exchangeTime: UtcMillis;
}
export interface VenueOrderUpdate {
  readonly clientOrderId: string;
  readonly exchangeOrderId: string | null;
  readonly status: 'open' | 'partially_filled' | 'filled' | 'canceled' | 'expired' | 'rejected' | 'not_found' | 'not_transmitted';
  readonly filled: Quantity;
  readonly averagePrice: Price | null;
  readonly fills: readonly Fill[];
  readonly exchangeRejectCode: string | null; // va al detail de EXCHANGE_REJECTED
  readonly origin: 'rest' | 'ws' | 'reconciliation';
  readonly exchangeTime: UtcMillis | null;
}
export interface VenueRequestFailed {
  readonly operation: 'submit' | 'cancel' | 'query' | 'snapshot';
  readonly clientOrderId: string | null;
  readonly errorClass:
    | 'transient' | 'timeout' | 'rate_limited' | 'ip_banned' | 'clock' | 'rejected' | 'order_not_found'
    | 'insufficient_funds' | 'credentials' | 'capguard_rejected' | 'capguard_unavailable' | 'live_disabled'
    | 'unknown'; // clases de exchange-execution §10.1, más las del capguard y de LIVE_TRADING
  readonly reasonCode: ReasonCode | null; // CAP_* o LIVE_TRADING_DISABLED cuando aplica
  readonly retryAfter: UtcMillis | null;
  readonly detail: string;
}
/** Respuesta a requestAccountSnapshot (AccountSnapshotReceived): lo que el venue confirma para reconciliar (§14.2). */
export interface AccountSnapshot {
  readonly balances: Readonly<Record<string, Decimal>>; // por moneda
  readonly orders: readonly VenueOrderUpdate[]; // las órdenes que conoce, con origin 'reconciliation'
  readonly fills: readonly Fill[]; // desde la marca pedida
  readonly exchangeTime: UtcMillis;
}
export interface OrderTransition {
  readonly clientOrderId: string;
  readonly from: OrderState;
  readonly to: OrderState;
  readonly filled: Quantity;
  readonly origin: TransitionOrigin;
  readonly exchangeTime: UtcMillis | null;
  readonly localTime: UtcMillis;
  readonly reason: string; // por qué cambió: el evento del venue o la duda que llevó a UNKNOWN
}

/** Orden tal como la guarda Execution: lo enviado y su estado actual. */
export interface OrderRecord {
  readonly clientOrderId: string;
  readonly approvalId: string;
  readonly intentId: string;
  readonly symbol: SymbolId;
  readonly side: Side;
  readonly type: OrderType;
  readonly reduceOnly: boolean;
  readonly quantity: Quantity;
  readonly limitPrice: Price | null;
  readonly triggerPrice: Price | null;
  readonly expiresAt: UtcMillis | null;
  readonly createdAt: UtcMillis;
  readonly state: OrderState;
  readonly filled: Quantity;
}

/** Rechazo de Execution, del capguard o del exchange. Risk lo persiste en risk_decisions (trading-risk §9.1). */
export interface ExecutionRejected {
  readonly approvalId: string | null;
  readonly intentId: string | null;
  readonly layer: 'execution' | 'capguard' | 'exchange';
  readonly reasonCode: ReasonCode;
  readonly symbol: SymbolId | null;
  readonly side: Side | null;
  readonly quantity: Quantity | null;
  readonly notional: Decimal | null;
  readonly detail: DecisionDetail;
}

export interface ExecutionStatus {
  readonly mode: ExecutionMode;
  readonly lastReconciledAt: UtcMillis | null;
  readonly blockedSymbols: readonly SymbolId[]; // órdenes huérfanas (EXEC_ORPHAN_ORDER)
  readonly rateLimitedUntil: UtcMillis | null; // EXEC_RATE_LIMITED
  readonly unprotectedPositions: readonly SymbolId[]; // sin stop nativo confirmado (PROTECTIVE_STOP_MISSING)
}
export interface ExecutionView {
  status(): ExecutionStatus;
}

// Modos de Execution en los que no sale ninguna orden nueva (exchange-execution §3.2). Es el modo de Execution, no el
// del run (ARCHITECTURE.md §14), que solo conoce app/: por eso se consulta aquí y no con una comparación suelta.
const SENDING_BLOCKED: ReadonlySet<ExecutionMode> = new Set(['UNKNOWN']);

export function isSendingBlocked(status: ExecutionStatus): boolean {
  return SENDING_BLOCKED.has(status.mode);
}
