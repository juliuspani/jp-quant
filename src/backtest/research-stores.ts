// Almacén de investigación de Risk y Execution (ARCHITECTURE.md §10: backtest y replay usan un almacén en memoria del
// run con los mismos puertos). Sustituye a la base de datos hasta el paso 33, que trae persistence/ con SQLite y las
// tablas risk_decisions, orders, order_transitions, fills y approvals_used. Aplica las mismas reglas que tendrán esas
// tablas: solo inserción, un token una sola vez, fills idempotentes y transiciones encadenadas. Lo que no cumple lanza:
// quien llama no sigue (persistir antes de actuar).
import { TERMINAL_STATES, type Fill, type OrderRecord, type OrderTransition } from '../kernel/execution.ts';
import { isReasonCode } from '../kernel/reason-codes.ts';
import type { DecisionRecord, ExecutionStore, RiskState, RiskStore } from '../kernel/stores.ts';

export class StoreError extends Error {
  override readonly name = 'StoreError';
}

function freezeRecord(record: DecisionRecord): DecisionRecord {
  return Object.freeze({ ...record, reasonCodes: Object.freeze([...record.reasonCodes]), detail: Object.freeze({ ...record.detail }) });
}

export class MemoryRiskStore implements RiskStore {
  readonly #decisions: DecisionRecord[] = [];
  #state: RiskState | null = null;

  appendDecision(record: DecisionRecord): void {
    const codes = record.reasonCodes;
    if (!codes.every((code) => isReasonCode(code))) throw new StoreError(`reason_code fuera del catálogo: ${codes.join(', ')}`);
    if ((record.reasonCode ?? null) !== (codes[0] ?? null)) throw new StoreError('el código principal no es el primero de la lista');
    if (record.decision !== 'APPROVED' && record.reasonCode === null) throw new StoreError(`${record.decision} sin reason_code`);
    this.#decisions.push(freezeRecord(record));
  }

  /** Lo guardado, en orden de inserción. */
  decisions(): readonly DecisionRecord[] {
    return Object.freeze([...this.#decisions]);
  }

  loadState(): RiskState | null {
    return this.#state;
  }

  saveState(state: RiskState): void {
    this.#state = Object.freeze({ killSwitch: Object.freeze({ ...state.killSwitch }) });
  }
}

export class MemoryExecutionStore implements ExecutionStore {
  readonly #orders = new Map<string, OrderRecord>();
  readonly #usedApprovals = new Set<string>();
  readonly #transitions: OrderTransition[] = [];
  readonly #fills = new Map<string, Fill>();

  isApprovalUsed(approvalId: string): boolean {
    return this.#usedApprovals.has(approvalId);
  }

  reserveAndInsert(approvalId: string, order: OrderRecord): void {
    // Todo se comprueba antes de escribir nada: o entran el token usado y la orden, o ninguno.
    if (this.#usedApprovals.has(approvalId)) throw new StoreError(`aprobación ya usada: ${approvalId}`);
    if (this.#orders.has(order.clientOrderId)) throw new StoreError(`client order ID repetido: ${order.clientOrderId}`);
    if (order.approvalId !== approvalId) throw new StoreError('la orden no es de esta aprobación');
    if (order.state !== 'PENDING_SEND' || !order.filled.isZero()) throw new StoreError('una orden nueva entra en PENDING_SEND y sin ejecutar');
    this.#usedApprovals.add(approvalId);
    this.#orders.set(order.clientOrderId, Object.freeze({ ...order }));
  }

  appendTransition(transition: OrderTransition): void {
    const order = this.#orders.get(transition.clientOrderId);
    if (order === undefined) throw new StoreError(`transición de una orden que no consta: ${transition.clientOrderId}`);
    if (order.state !== transition.from) throw new StoreError(`la orden está en ${order.state}, no en ${transition.from}`);
    this.#transitions.push(Object.freeze({ ...transition }));
    this.#orders.set(order.clientOrderId, Object.freeze({ ...order, state: transition.to, filled: transition.filled }));
  }

  insertFill(fill: Fill): boolean {
    if (!this.#orders.has(fill.clientOrderId)) throw new StoreError(`fill de una orden que no consta: ${fill.clientOrderId}`);
    const key = `${fill.symbol}\u0000${fill.tradeId}`;
    if (this.#fills.has(key)) return false;
    this.#fills.set(key, Object.freeze({ ...fill }));
    return true;
  }

  loadNonTerminal(): readonly OrderRecord[] {
    return Object.freeze([...this.#orders.values()].filter((order) => !TERMINAL_STATES.has(order.state)));
  }

  order(clientOrderId: string): OrderRecord | null {
    return this.#orders.get(clientOrderId) ?? null;
  }

  transitions(): readonly OrderTransition[] {
    return Object.freeze([...this.#transitions]);
  }

  fills(): readonly Fill[] {
    return Object.freeze([...this.#fills.values()]);
  }
}
