// Execution mínimo, solo simulado (paso 20, ADR 0023): exige el token de Risk, guarda antes de enviar, sigue cada orden
// por la máquina de estados y, ante cualquier duda, entra en UNKNOWN y deja de enviar.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryExecutionStore } from '../../../src/backtest/research-stores.ts';
import { ExecutionEngine } from '../../../src/execution/engine.ts';
import { createApprovalSigner } from '../../../src/risk/signer.ts';
import { d, entry, exit, fill, position, quote, SYMBOL, T0, tradingBench, update } from '../harness/trading.ts';

function approvedEntry(bench: ReturnType<typeof tradingBench>, quantity = '0.01') {
  const { approval } = bench.risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d(quantity) } }));
  assert.ok(approval, 'Risk debía aprobar');
  return approval;
}

test('camino completo: token de Risk → PENDING_SEND → SENT → OPEN → PARTIALLY_FILLED → FILLED, guardado antes de enviar', () => {
  const bench = tradingBench();
  const approval = approvedEntry(bench);
  const result = bench.execution.submit(approval);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [sent] = bench.venue.submitted;
  assert.ok(sent);
  assert.equal(sent.clientOrderId, result.clientOrderId);
  assert.match(sent.clientOrderId, /^ijp-[A-Za-z0-9_-]{22}$/);
  assert.deepEqual({ q: sent.quantity.toString(), type: sent.type, side: sent.side, exp: sent.expiresAt }, { q: '0.01', type: 'market', side: 'buy', exp: T0 + 300_000 });
  assert.equal(sent.approval.approval_id, approval.approval_id);
  assert.ok(bench.executionStore.isApprovalUsed(approval.approval_id));

  const id = result.clientOrderId;
  bench.execution.onVenueUpdate(update(id, 'open', '0'));
  bench.execution.onVenueUpdate(update(id, 'partially_filled', '0.004', [fill(id, 't1', '0.004')]));
  bench.execution.onVenueUpdate(update(id, 'filled', '0.01', [fill(id, 't1', '0.004'), fill(id, 't2', '0.006')]));
  assert.equal(bench.execution.order(id)?.state, 'FILLED');
  assert.equal(bench.execution.status().mode, 'NORMAL');
  assert.deepEqual(bench.executionStore.transitions().map((t) => `${t.from}>${t.to}`), [
    'PENDING_SEND>SENT', 'SENT>OPEN', 'OPEN>PARTIALLY_FILLED', 'PARTIALLY_FILLED>FILLED',
  ]);
  assert.equal(bench.executionStore.fills().length, 2, 'el fill repetido no cuenta dos veces');
});

test('una orden sin pasar por Risk es rechazada: sin token, inventado o firmado por otra clave, y no llega al venue', () => {
  const bench = tradingBench();
  const genuine = approvedEntry(bench);
  assert.deepEqual(bench.execution.submit(null), { ok: false, reasonCode: 'APPROVAL_MISSING' });
  assert.deepEqual(bench.execution.submit(undefined), { ok: false, reasonCode: 'APPROVAL_MISSING' });
  assert.equal(bench.risk.tradingState().killSwitch, false, 'un token que falta no es una manipulación');

  const forged = { ...genuine, max_quantity: '5', max_notional: '200000' };
  assert.deepEqual(bench.execution.submit(forged), { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' });
  assert.equal(bench.risk.tradingState().killSwitch, true, 'una firma inválida activa el kill switch');
  assert.equal(bench.venue.submitted.length, 0);

  const other = tradingBench();
  const outsider = createApprovalSigner().sign({ ...genuine, approval_id: '11111111-2222-4333-8444-555555555555' });
  assert.deepEqual(other.execution.submit(outsider), { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' });
  assert.equal(other.venue.submitted.length, 0);

  const persisted = bench.store.decisions().filter((r) => r.layer === 'execution').map((r) => r.reasonCode);
  assert.deepEqual(persisted, ['APPROVAL_MISSING', 'APPROVAL_MISSING', 'APPROVAL_BAD_SIGNATURE']);
});

test('un token caducado o reutilizado no envía nada; el reutilizado activa el kill switch', () => {
  const late = tradingBench();
  const approval = approvedEntry(late);
  late.clock.advanceTo(T0 + 10_001);
  assert.deepEqual(late.execution.submit(approval), { ok: false, reasonCode: 'APPROVAL_EXPIRED' });

  const bench = tradingBench();
  const token = approvedEntry(bench);
  assert.equal(bench.execution.submit(token).ok, true);
  assert.deepEqual(bench.execution.submit(token), { ok: false, reasonCode: 'APPROVAL_REPLAYED' });
  assert.equal(bench.venue.submitted.length, 1);
  assert.equal(bench.risk.tradingState().killSwitch, true);
});

test('la orden tiene que coincidir con lo aprobado: precio que sube o posición que ya no está', () => {
  const bench = tradingBench();
  const approval = approvedEntry(bench);
  bench.market.quotes.set(SYMBOL, quote(T0, '40001'));
  assert.deepEqual(bench.execution.submit(approval), { ok: false, reasonCode: 'APPROVAL_MISMATCH' });

  const sell = tradingBench();
  sell.portfolio.current = { ...sell.portfolio.current, exposure: d('400'), positions: [position()] };
  const { approval: exitToken } = sell.risk.evaluate(exit());
  assert.ok(exitToken);
  sell.portfolio.current = { ...sell.portfolio.current, positions: [position({ available: d('0.005') })] };
  assert.deepEqual(sell.execution.submit(exitToken), { ok: false, reasonCode: 'APPROVAL_MISMATCH' });
  assert.equal(sell.venue.submitted.length, 0);
});

test('la cantidad se redondea a la baja al paso del mercado; por debajo del mínimo, EXEC_MARKET_RULES', () => {
  const bench = tradingBench();
  const approval = approvedEntry(bench, '0.01009');
  const result = bench.execution.submit(approval);
  assert.equal(result.ok, true);
  assert.equal(bench.venue.submitted[0]?.quantity.toString(), '0.01');

  const tiny = tradingBench();
  const token = approvedEntry(tiny, '0.0002');
  tiny.market.instruments.set(SYMBOL, { ...tiny.market.instruments.get(SYMBOL)!, quantityStep: d('0.001') });
  assert.deepEqual(tiny.execution.submit(token), { ok: false, reasonCode: 'EXEC_MARKET_RULES' });
});

test('arranca en UNKNOWN: no envía hasta reconciliar, y Risk tampoco aprueba', () => {
  const bench = tradingBench({ reconcile: false });
  assert.equal(bench.execution.status().mode, 'UNKNOWN');
  assert.equal(bench.risk.evaluate(entry()).decision.reasonCode, 'STATE_UNRECONCILED');
  assert.equal(bench.execution.reconcile([]), true);
  assert.equal(bench.execution.status().mode, 'NORMAL');
  assert.equal(bench.execution.status().lastReconciledAt, T0);
  assert.equal(bench.execution.submit(approvedEntry(bench)).ok, true);
});

test('una transición inválida que llega del venue no se aplica: la orden o el sistema pasan a UNKNOWN', () => {
  const bench = tradingBench();
  const first = bench.execution.submit(approvedEntry(bench));
  assert.ok(first.ok);
  const id = first.clientOrderId;
  bench.execution.onVenueUpdate(update(id, 'filled', '0.01', [fill(id, 't1', '0.01')]));
  bench.execution.onVenueUpdate(update(id, 'open', '0'));
  assert.equal(bench.execution.order(id)?.state, 'FILLED', 'una orden terminal no cambia');
  assert.equal(bench.execution.status().mode, 'UNKNOWN');
  assert.match(bench.execution.unknownReason ?? '', /FILLED → OPEN/);
  assert.deepEqual(bench.execution.submit(approvedEntry(tradingBench())), { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' }, 'token de otro arranque');

  const cases: [string, (b: ReturnType<typeof tradingBench>, id: string) => void][] = [
    ['el filled baja', (b, i) => {
      b.execution.onVenueUpdate(update(i, 'partially_filled', '0.005'));
      b.execution.onVenueUpdate(update(i, 'partially_filled', '0.004'));
    }],
    ['el filled supera la cantidad', (b, i) => b.execution.onVenueUpdate(update(i, 'filled', '0.02'))],
    ['FILLED sin la cantidad completa', (b, i) => b.execution.onVenueUpdate(update(i, 'filled', '0.005'))],
    ['orden que no consta', (b) => b.execution.onVenueUpdate(update('ijp-desconocida', 'open', '0'))],
    ['fill de otra orden', (b, i) => b.execution.onVenueUpdate(update(i, 'partially_filled', '0.005', [fill('ijp-otra', 't9', '0.005')]))],
    ['not_found', (b, i) => b.execution.onVenueUpdate(update(i, 'not_found', '0'))],
    ['timeout al enviar', (b, i) => b.execution.onVenueFailure({ operation: 'submit', clientOrderId: i, errorClass: 'timeout', reasonCode: null, retryAfter: null, detail: '10 s' })],
  ];
  for (const [name, provoke] of cases) {
    const b = tradingBench();
    const r = b.execution.submit(approvedEntry(b));
    assert.ok(r.ok);
    const next = approvedEntry(b); // firmado antes de la duda: después, Risk ya no aprueba (STATE_UNRECONCILED)
    provoke(b, r.clientOrderId);
    assert.equal(b.execution.status().mode, 'UNKNOWN', name);
    assert.deepEqual(b.execution.submit(next), { ok: false, reasonCode: 'EXEC_STATE_UNKNOWN' }, name);
    assert.equal(b.risk.evaluate(entry()).decision.reasonCode, 'STATE_UNRECONCILED', name);
    assert.equal(b.venue.submitted.length, 1, `${name}: no sale nada más`);
  }
});

test('el venue que lanza al enviar deja la orden en UNKNOWN: pudo salir', () => {
  const bench = tradingBench();
  bench.venue.failSubmit = new Error('conexión cortada');
  const result = bench.execution.submit(approvedEntry(bench));
  assert.ok(result.ok);
  assert.equal(bench.execution.order(result.clientOrderId)?.state, 'UNKNOWN');
  assert.equal(bench.execution.status().mode, 'UNKNOWN');
  assert.ok(bench.executionStore.isApprovalUsed(bench.executionStore.order(result.clientOrderId)?.approvalId ?? ''));
});

test('eventos repetidos son idempotentes y un rechazo del exchange queda guardado con su capa', () => {
  const bench = tradingBench();
  const r = bench.execution.submit(approvedEntry(bench));
  assert.ok(r.ok);
  const done = update(r.clientOrderId, 'filled', '0.01', [fill(r.clientOrderId, 't1', '0.01')]);
  bench.execution.onVenueUpdate(done);
  bench.execution.onVenueUpdate({ ...done, origin: 'rest' });
  assert.equal(bench.execution.status().mode, 'NORMAL');
  assert.equal(bench.executionStore.transitions().length, 2);
  assert.equal(bench.executionStore.fills().length, 1);

  const second = bench.execution.submit(approvedEntry(bench));
  assert.ok(second.ok);
  bench.execution.onVenueFailure({ operation: 'submit', clientOrderId: second.clientOrderId, errorClass: 'rejected', reasonCode: null, retryAfter: null, detail: '-2010' });
  assert.equal(bench.execution.order(second.clientOrderId)?.state, 'REJECTED');
  assert.equal(bench.execution.status().mode, 'NORMAL');
  const last = bench.store.decisions().at(-1);
  assert.deepEqual([last?.layer, last?.reasonCode], ['exchange', 'EXCHANGE_REJECTED']);
});

test('reconciliación: confirma el estado de una orden en duda; si falta alguna, sigue en UNKNOWN', () => {
  const bench = tradingBench();
  const r = bench.execution.submit(approvedEntry(bench));
  assert.ok(r.ok);
  bench.execution.onVenueFailure({ operation: 'submit', clientOrderId: r.clientOrderId, errorClass: 'timeout', reasonCode: null, retryAfter: null, detail: '' });
  assert.equal(bench.execution.reconcile([]), false, 'la orden en duda no aparece');
  bench.execution.onVenueUpdate(update(r.clientOrderId, 'filled', '0.01', [fill(r.clientOrderId, 't1', '0.01')]));
  assert.equal(bench.execution.order(r.clientOrderId)?.state, 'UNKNOWN', 'un evento normal no saca de UNKNOWN');
  assert.equal(bench.execution.reconcile([update(r.clientOrderId, 'filled', '0.01', [fill(r.clientOrderId, 't1', '0.01')], 'reconciliation')]), true);
  assert.equal(bench.execution.order(r.clientOrderId)?.state, 'FILLED');
  assert.equal(bench.execution.status().mode, 'NORMAL');
  assert.equal(bench.execution.reconcile([update('ijp-ajena', 'open', '0', [], 'reconciliation')]), false, 'una orden que no consta');
  assert.equal(bench.execution.status().mode, 'UNKNOWN');
});

test('el kill switch bloquea todo: Risk rechaza, Execution no envía ni un token ya firmado y cancela lo abierto', () => {
  const bench = tradingBench();
  const open = bench.execution.submit(approvedEntry(bench));
  assert.ok(open.ok);
  bench.execution.onVenueUpdate(update(open.clientOrderId, 'open', '0'));
  const issuedBefore = approvedEntry(bench);

  bench.risk.activateKillSwitch('prueba');
  assert.equal(bench.risk.evaluate(entry()).decision.reasonCode, 'KILL_SWITCH_ACTIVE');
  assert.equal(bench.risk.evaluate(exit()).decision.reasonCode, 'KILL_SWITCH_ACTIVE');
  assert.deepEqual(bench.execution.submit(issuedBefore), { ok: false, reasonCode: 'KILL_SWITCH_ACTIVE' });
  assert.deepEqual(bench.execution.onKillSwitch(), [open.clientOrderId]);
  assert.equal(bench.execution.order(open.clientOrderId)?.state, 'CANCEL_PENDING');
  assert.deepEqual(bench.venue.canceled.map((c) => c.clientOrderId), [open.clientOrderId]);
  assert.equal(bench.venue.submitted.length, 1);
});

test('el kill switch mantiene los stops de protección: no los cancela', () => {
  const store = new MemoryExecutionStore();
  // Un stop nativo que quedó abierto antes de un reinicio (los stops se envían desde el paso 36).
  const stopId = 'ijp-stop';
  store.reserveAndInsert('ap-stop', {
    clientOrderId: stopId, approvalId: 'ap-stop', intentId: 'i-stop', symbol: SYMBOL, side: 'sell', type: 'stop_market', reduceOnly: true,
    quantity: d('0.01'), limitPrice: null, triggerPrice: d('38000'), expiresAt: null, createdAt: T0, state: 'PENDING_SEND', filled: d('0'),
  });
  const base = { clientOrderId: stopId, filled: d('0'), origin: 'internal', exchangeTime: null, localTime: T0, reason: 'antes del reinicio' } as const;
  store.appendTransition({ ...base, from: 'PENDING_SEND', to: 'SENT' });
  store.appendTransition({ ...base, from: 'SENT', to: 'OPEN' });
  const bench = tradingBench({ executionStore: store, reconcile: false });
  assert.equal(bench.execution.reconcile([update(stopId, 'open', '0', [], 'reconciliation')]), true);
  const entryOrder = bench.execution.submit(approvedEntry(bench));
  assert.ok(entryOrder.ok);
  bench.execution.onVenueUpdate(update(entryOrder.clientOrderId, 'open', '0'));

  bench.risk.activateKillSwitch('prueba');
  assert.deepEqual(bench.execution.onKillSwitch(), [entryOrder.clientOrderId]);
  assert.equal(bench.execution.order(stopId)?.state, 'OPEN');
});

test('client order IDs únicos en muchas órdenes, y TTL fuera de rango no arranca', () => {
  const bench = tradingBench();
  const ids = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    const r = bench.execution.submit(approvedEntry(bench, '0.0002'));
    assert.ok(r.ok);
    ids.add(r.clientOrderId);
  }
  assert.equal(ids.size, 50);
  for (const orderTtlMs of [0, 300_001, 1.5]) {
    assert.throws(
      () => new ExecutionEngine({ clock: bench.clock, venue: bench.venue, store: new MemoryExecutionStore(), market: bench.market, portfolio: bench.portfolio, risk: bench.risk, approvalKey: bench.risk.approvalPublicKey, onRejected: () => undefined, onFill: () => undefined, orderTtlMs }),
      RangeError,
    );
  }
});
