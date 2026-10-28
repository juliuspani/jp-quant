// Puertos de persistencia de Risk y Execution (ARCHITECTURE.md §16.8). Los implementa persistence/ con SQLite (paso
// 33) y, hasta entonces y en cada run de investigación, el almacén en memoria de src/backtest/research-stores.ts.
// Son síncronos y lanzan si no pueden escribir: quien llama no sigue (persistir antes de actuar, §10).
import type { Decimal, Quantity } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { UtcMillis } from '../shared/time.ts';
import type { Side } from '../shared/trading.ts';
import type { Fill, OrderRecord, OrderTransition } from './execution.ts';
import type { DecisionDetail, IntentOrigin, RiskDecision } from './orders.ts';
import type { ReasonCode } from './reason-codes.ts';

/** Fila de risk_decisions (trading-risk §9.1): una decisión de Risk o un rechazo de otra capa. Solo inserción. */
export interface DecisionRecord {
  readonly ts: UtcMillis;
  readonly layer: 'risk' | 'execution' | 'capguard' | 'exchange';
  readonly decisionId: string;
  readonly intentId: string | null;
  readonly approvalId: string | null;
  readonly origin: IntentOrigin | null;
  readonly symbol: SymbolId | null;
  readonly side: Side | null;
  readonly quantity: Quantity | null; // lo pedido
  readonly notional: Decimal | null;
  readonly decision: RiskDecision['decision'];
  readonly reasonCode: ReasonCode | null;
  readonly reasonCodes: readonly ReasonCode[];
  readonly detail: DecisionDetail;
  readonly configHash: string;
  readonly commit: string;
}

/** Estado persistente de Risk. El paso 35 añade los circuit breakers y el máximo de patrimonio. */
export interface RiskState {
  readonly killSwitch: {
    readonly active: boolean;
    readonly reason: string | null;
    readonly changedAt: UtcMillis | null;
  };
}

export interface RiskStore {
  appendDecision(record: DecisionRecord): void;
  loadState(): RiskState | null; // null: nunca se guardó
  saveState(state: RiskState): void;
}

export interface ExecutionStore {
  isApprovalUsed(approvalId: string): boolean;
  reserveAndInsert(approvalId: string, order: OrderRecord): void; // una transacción: token usado + PENDING_SEND
  appendTransition(transition: OrderTransition): void;
  insertFill(fill: Fill): boolean; // false si ya existía: idempotente por símbolo y trade_id
  loadNonTerminal(): readonly OrderRecord[];
}
