// INV-00, INV-06 a INV-09 (SECURITY_AND_TRADING_INVARIANTS.md) sobre los módulos risk/ y execution/ del paso 20, unidos
// como los unirá app/. El código previo (src/engine.ts, src/broker.ts) no los usa todavía: su brecha sigue anotada en
// INV-06 y se cierra en el refactor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryExecutionStore, MemoryRiskStore } from '../../src/backtest/research-stores.ts';
import type { DecisionRecord } from '../../src/kernel/stores.ts';
import { isReasonCode } from '../../src/kernel/reason-codes.ts';
import { createApprovalSigner } from '../../src/risk/signer.ts';
import { d, entry, exit, position, quote, riskBench, SYMBOL, T0, tradingBench, update } from '../src/harness/trading.ts';

test('INV-00d: un control que lanza o un valor no válido rechazan con INTERNAL_ERROR, y sin poder guardar, DECISION_LOG_UNAVAILABLE', () => {
  const { risk, market } = riskBench();
  assert.equal(risk.evaluate(entry({ signalTime: Number.NaN })).decision.reasonCode, 'INTERNAL_ERROR');
  assert.equal(risk.evaluate(entry({ signalTime: Number.POSITIVE_INFINITY })).decision.reasonCode, 'INTERNAL_ERROR');
  market.instrument = () => {
    throw new Error('control roto');
  };
  const broken = risk.evaluate(entry());
  assert.deepEqual([broken.decision.decision, broken.decision.reasonCode, broken.approval], ['REJECTED', 'INTERNAL_ERROR', null]);

  class Unwritable extends MemoryRiskStore {
    override appendDecision(_record: DecisionRecord): void {
      throw new Error('no se puede escribir');
    }
  }
  const bench = riskBench({ store: new Unwritable() });
  const outcome = bench.risk.evaluate(entry());
  assert.deepEqual([outcome.decision.reasonCode, outcome.approval], ['DECISION_LOG_UNAVAILABLE', null]);
  assert.equal(bench.risk.tradingState().killSwitch, true);
});

test('INV-06c: Execution rechaza sin token, con firma inválida, caducado, reutilizado o distinto de lo aprobado, también en ventas', () => {
  const sells = (): ReturnType<typeof tradingBench> => {
    const b = tradingBench();
    b.portfolio.current = { ...b.portfolio.current, exposure: d('400'), positions: [position()] };
    return b;
  };
  for (const side of ['buy', 'sell'] as const) {
    const fresh = (): ReturnType<typeof tradingBench> => (side === 'buy' ? tradingBench() : sells());
    const sign = (b: ReturnType<typeof tradingBench>) => {
      const { approval } = b.risk.evaluate(side === 'buy' ? entry() : exit());
      assert.ok(approval, `${side}: Risk debía aprobar`);
      return approval;
    };

    let b = fresh();
    assert.deepEqual(b.execution.submit(null), { ok: false, reasonCode: 'APPROVAL_MISSING' }, side);

    b = fresh();
    assert.deepEqual(b.execution.submit({ ...sign(b), max_quantity: '0.009' }), { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' }, side);
    b = fresh();
    const foreign = createApprovalSigner().sign({ ...sign(b), approval_id: '11111111-2222-4333-8444-555555555555' });
    assert.deepEqual(b.execution.submit(foreign), { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' }, `${side}: otra clave`);

    b = fresh();
    const late = sign(b);
    b.clock.advanceTo(T0 + 10_001);
    assert.deepEqual(b.execution.submit(late), { ok: false, reasonCode: 'APPROVAL_EXPIRED' }, side);

    b = fresh();
    const once = sign(b);
    assert.equal(b.execution.submit(once).ok, true, side);
    assert.deepEqual(b.execution.submit(once), { ok: false, reasonCode: 'APPROVAL_REPLAYED' }, side);

    b = fresh();
    const token = sign(b);
    if (side === 'buy') b.market.quotes.set(SYMBOL, quote(T0, '41000'));
    else b.portfolio.current = { ...b.portfolio.current, positions: [position({ available: d('0.001') })] };
    assert.deepEqual(b.execution.submit(token), { ok: false, reasonCode: 'APPROVAL_MISMATCH' }, side);
    assert.equal(b.venue.submitted.length, 0, `${side}: nada llega al venue`);
  }
});

test('INV-06e: cada rechazo de Risk y de Execution queda guardado antes de responder, con un reason_code del catálogo', () => {
  const b = tradingBench();
  b.risk.evaluate(entry({ stopPrice: null }));
  b.execution.submit(null);
  const decisions = b.store.decisions();
  assert.deepEqual(decisions.map((r) => [r.layer, r.decision, r.reasonCode]), [
    ['risk', 'REJECTED', 'STOP_INVALID'],
    ['execution', 'REJECTED', 'APPROVAL_MISSING'],
  ]);
  for (const r of decisions) {
    assert.ok(r.reasonCode !== null && isReasonCode(r.reasonCode));
    assert.ok(r.reasonCodes.every((code) => isReasonCode(code)));
    assert.equal(r.commit, 'test');
    assert.match(r.configHash, /^[0-9a-f]{64}$/);
  }
});

test('INV-07b: con el kill switch activo, Execution cancela las órdenes pendientes y mantiene los stops nativos', () => {
  const store = new MemoryExecutionStore();
  store.reserveAndInsert('ap-stop', {
    clientOrderId: 'ijp-stop', approvalId: 'ap-stop', intentId: 'i-stop', symbol: SYMBOL, side: 'sell', type: 'stop_market', reduceOnly: true,
    quantity: d('0.01'), limitPrice: null, triggerPrice: d('38000'), expiresAt: null, createdAt: T0, state: 'PENDING_SEND', filled: d('0'),
  });
  const t = { clientOrderId: 'ijp-stop', filled: d('0'), origin: 'internal', exchangeTime: null, localTime: T0, reason: 'previo' } as const;
  store.appendTransition({ ...t, from: 'PENDING_SEND', to: 'SENT' });
  store.appendTransition({ ...t, from: 'SENT', to: 'OPEN' });
  const b = tradingBench({ executionStore: store, reconcile: false });
  assert.equal(b.execution.reconcile([update('ijp-stop', 'open', '0', [], 'reconciliation')]), true);
  const { approval } = b.risk.evaluate(entry());
  const sent = b.execution.submit(approval);
  assert.ok(sent.ok);
  b.execution.onVenueUpdate(update(sent.clientOrderId, 'partially_filled', '0.004'));

  b.risk.activateKillSwitch('INV-07b');
  assert.deepEqual(b.execution.onKillSwitch(), [sent.clientOrderId]);
  assert.equal(b.execution.order(sent.clientOrderId)?.state, 'CANCEL_PENDING');
  assert.equal(b.execution.order('ijp-stop')?.state, 'OPEN');
  assert.deepEqual(b.venue.canceled.map((c) => c.clientOrderId), [sent.clientOrderId]);
});

test('INV-07d: el kill switch bloquea todo: Risk rechaza cualquier intención y Execution no envía ni un token ya firmado', () => {
  const b = tradingBench();
  b.portfolio.current = { ...b.portfolio.current, exposure: d('400'), positions: [position()] };
  const signedBefore = [b.risk.evaluate(entry()).approval, b.risk.evaluate(exit()).approval];
  b.risk.activateKillSwitch('INV-07d');
  for (const intent of [entry(), exit(), entry({ origin: 'manual' }), exit({ origin: 'system' })]) {
    const outcome = b.risk.evaluate(intent);
    assert.deepEqual([outcome.decision.reasonCode, outcome.approval], ['KILL_SWITCH_ACTIVE', null]);
  }
  for (const token of signedBefore) {
    assert.ok(token);
    assert.deepEqual(b.execution.submit(token), { ok: false, reasonCode: 'KILL_SWITCH_ACTIVE' });
  }
  assert.equal(b.venue.submitted.length, 0);
});

test('INV-08b: precio o valoración de más de 60 s, precio que falta o señal de más de 20 min rechazan la entrada', () => {
  const b = riskBench();
  b.clock.advanceTo(T0 + 60_001);
  assert.equal(b.risk.evaluate(entry({ signalTime: T0 + 60_001 })).decision.reasonCode, 'STALE_DATA');
  b.market.quotes.delete(SYMBOL);
  assert.equal(b.risk.evaluate(entry({ signalTime: T0 + 60_001 })).decision.reasonCode, 'STALE_DATA');
  b.market.quotes.set(SYMBOL, quote(T0 + 60_001));
  b.portfolio.current = { ...b.portfolio.current, exposure: d('400'), positions: [position()], marksAsOf: T0 };
  assert.equal(b.risk.evaluate(entry({ signalTime: T0 + 60_001 })).decision.reasonCode, 'STALE_DATA');
  b.portfolio.current = { ...b.portfolio.current, marksAsOf: T0 + 60_001 };
  assert.equal(b.risk.evaluate(entry({ signalTime: T0 + 60_001 - 1_200_001 })).decision.reasonCode, 'SIGNAL_TOO_OLD');
});

test('INV-09b: en modo UNKNOWN Execution no envía órdenes nuevas (EXEC_STATE_UNKNOWN) hasta reconciliar', () => {
  const b = tradingBench({ reconcile: false });
  // Al arrancar: UNKNOWN. Risk no aprueba y Execution no envía.
  assert.equal(b.risk.evaluate(entry()).decision.reasonCode, 'STATE_UNRECONCILED');
  assert.equal(b.risk.evaluate(exit()).decision.reasonCode, 'STATE_UNRECONCILED');
  b.execution.reconcile([]);
  const first = b.execution.submit(b.risk.evaluate(entry()).approval);
  assert.ok(first.ok);
  const pending = b.risk.evaluate(entry()).approval;
  b.execution.onVenueFailure({ operation: 'submit', clientOrderId: first.clientOrderId, errorClass: 'timeout', reasonCode: null, retryAfter: null, detail: 'sin respuesta' });
  assert.deepEqual(b.execution.submit(pending), { ok: false, reasonCode: 'EXEC_STATE_UNKNOWN' });
  assert.equal(b.venue.submitted.length, 1);
  assert.equal(b.execution.reconcile([]), false, 'la orden en duda no se ha confirmado');
  assert.equal(b.execution.reconcile([update(first.clientOrderId, 'open', '0', [], 'reconciliation')]), true);
  assert.equal(b.execution.submit(b.risk.evaluate(entry()).approval).ok, true);
});
