// Rastreo del diario de un backtest: cada orden que llegó al venue y cada fill vuelven, por su client order ID, a un
// token de Risk, a una decisión de Risk que aprobó y a una intención. Si algo llegó a Execution sin pasar por Risk, la
// cadena se rompe y rastrear lanza. Lo usan test/src/app/baselines.test.ts y test/invariants/strategy-risk.test.ts.
import type { ReplayEvent } from '../../../src/backtest/replay.ts';
import { clientOrderIdFor } from '../../../src/execution/client-order-id.ts';
import type { Fill } from '../../../src/kernel/execution.ts';
import type { OrderIntent, RiskDecision, SignedApproval } from '../../../src/kernel/orders.ts';
import { Decimal } from '../../../src/shared/decimal.ts';

export interface TracedOrder {
  readonly clientOrderId: string;
  readonly intent: OrderIntent;
  readonly decision: RiskDecision;
  readonly approval: Omit<SignedApproval, 'signature'>;
  readonly fills: readonly Fill[];
}

function payloads<T>(journal: readonly ReplayEvent[], type: string): { index: number; payload: T }[] {
  return journal.flatMap((e, index) => (e.type === type ? [{ index, payload: e.payload as T }] : []));
}

/** Cada orden del diario con su intención, su decisión y su token. Lanza si una orden o un fill no tienen esa cadena. */
export function traceOrders(journal: readonly ReplayEvent[]): TracedOrder[] {
  const intents = new Map(payloads<OrderIntent>(journal, 'OrderIntentCreated').map(({ index, payload }) => [payload.intentId, { index, payload }]));
  const decisions = new Map(payloads<RiskDecision>(journal, 'RiskDecisionMade').map(({ index, payload }) => [payload.intentId, { index, payload }]));
  const approvals = new Map(
    payloads<Omit<SignedApproval, 'signature'> & { signed: boolean }>(journal, 'OrderApproved').map(({ index, payload }) => [
      clientOrderIdFor(payload.approval_id),
      { index, payload },
    ]),
  );
  const orders = new Map<string, TracedOrder>();
  const link = (clientOrderId: string, at: number): TracedOrder => {
    const known = orders.get(clientOrderId);
    if (known !== undefined) return known;
    const approval = approvals.get(clientOrderId);
    if (approval === undefined || approval.index > at) throw new Error(`${clientOrderId}: orden sin token de Risk previo`);
    if (!approval.payload.signed) throw new Error(`${clientOrderId}: token sin firma`);
    const decision = decisions.get(approval.payload.intent_id);
    if (decision === undefined || decision.index > approval.index) throw new Error(`${clientOrderId}: token sin decisión de Risk previa`);
    if (decision.payload.decision === 'REJECTED') throw new Error(`${clientOrderId}: token de una decisión rechazada`);
    const intent = intents.get(approval.payload.intent_id);
    if (intent === undefined || intent.index > decision.index) throw new Error(`${clientOrderId}: decisión sin intención previa`);
    const traced = { clientOrderId, intent: intent.payload, decision: decision.payload, approval: approval.payload, fills: [] as Fill[] };
    orders.set(clientOrderId, traced);
    return traced;
  };
  journal.forEach((event, index) => {
    if (event.type === 'OrderStateChanged') link((event.payload as { clientOrderId: string }).clientOrderId, index);
    if (event.type === 'FillRecorded') {
      const fill = event.payload as Fill;
      const order = link(fill.clientOrderId, index);
      if (fill.symbol !== order.approval.symbol || fill.side !== order.approval.side) throw new Error(`${fill.clientOrderId}: fill distinto de lo aprobado`);
      (order.fills as Fill[]).push(fill);
    }
  });
  for (const order of orders.values()) {
    const filled = order.fills.reduce((total, f) => total.plus(f.quantity), Decimal.parse('0'));
    if (filled.gt(Decimal.parse(order.approval.max_quantity))) throw new Error(`${order.clientOrderId}: se ejecutó más de lo aprobado`);
  }
  return [...orders.values()];
}
