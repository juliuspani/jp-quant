// Máquina de estados de una orden (exchange-execution §4.2). Una transición que no está en la tabla es imposible y
// lanza: el motor la convierte en una duda (UNKNOWN), nunca la aplica. Una orden terminal no cambia nunca, y de UNKNOWN
// solo se sale desde la reconciliación, con el estado que confirma el exchange.
import { TERMINAL_STATES, type OrderState, type TransitionOrigin } from '../kernel/execution.ts';

export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';
}

// §4.2. UNKNOWN está en todos los estados vivos: PENDING_SEND, SENT y CANCEL_PENDING pasan a él ante cualquier duda, y
// los demás cuando llega un evento imposible («cualquier otra transición… la orden pasa a UNKNOWN»).
const ALLOWED: Readonly<Record<OrderState, readonly OrderState[]>> = {
  PENDING_SEND: ['SENT', 'UNKNOWN'],
  SENT: ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'EXPIRED', 'REJECTED', 'UNKNOWN'],
  OPEN: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'EXPIRED', 'UNKNOWN'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'EXPIRED', 'UNKNOWN'],
  CANCEL_PENDING: ['CANCELED', 'FILLED', 'EXPIRED', 'UNKNOWN'],
  // «Cualquier estado» de §4.2 que el exchange pueda confirmar: SENT y CANCEL_PENDING no los confirma nadie.
  UNKNOWN: ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'NOT_SENT'],
  FILLED: [],
  CANCELED: [],
  EXPIRED: [],
  REJECTED: [],
  NOT_SENT: [],
};

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: OrderState, to: OrderState, origin: TransitionOrigin): boolean {
  if (from === 'UNKNOWN' && origin !== 'reconciliation') return false;
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: OrderState, to: OrderState, origin: TransitionOrigin): void {
  if (!canTransition(from, to, origin)) {
    throw new InvalidTransitionError(`transición imposible: ${from} → ${to} (origen ${origin})`);
  }
}
