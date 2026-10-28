// Stops de protección (trading-risk §2.4, paso 23): Risk los aprueba como salidas reduce_only con su disparo firmado, y
// Execution los envía sin TTL y solo los cancela con la aprobación de una salida o de una sustitución.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { d, entry, position, tradingBench } from '../harness/trading.ts';

const stop = (overrides = {}) =>
  entry({ origin: 'system', side: 'sell', kind: 'protective_stop', reduceOnly: true, sizing: { mode: 'all' }, stopPrice: d('38000.04'), ...overrides });

test('Risk aprueba el stop de una posición abierta: stop a mercado, reduce_only, con el disparo al alza al paso de precio', () => {
  const bench = tradingBench();
  bench.portfolio.current = { ...bench.portfolio.current, positions: [position()] };
  const { decision, approval } = bench.risk.evaluate(stop());
  assert.equal(decision.decision, 'APPROVED');
  assert.deepEqual(
    [approval?.type, approval?.side, approval?.reduce_only, approval?.max_quantity, approval?.trigger_price, approval?.max_notional],
    ['stop_market', 'sell', true, '0.01', '38000.1', null],
  );
  assert.equal(bench.risk.evaluate(stop({ kind: 'stop_update' })).decision.decision, 'APPROVED', 'una sustitución, igual');
});

test('Risk: sin posición, REDUCE_ONLY_VIOLATION; sin disparo, mal formada; con el kill switch, nada', () => {
  const bench = tradingBench();
  assert.equal(bench.risk.evaluate(stop()).decision.reasonCode, 'REDUCE_ONLY_VIOLATION');
  assert.equal(bench.risk.evaluate(stop({ stopPrice: null })).decision.reasonCode, 'INTERNAL_ERROR');
  assert.equal(bench.risk.evaluate(stop({ side: 'buy' })).decision.reasonCode, 'INTERNAL_ERROR');
  bench.portfolio.current = { ...bench.portfolio.current, positions: [position()] };
  bench.risk.activateKillSwitch('prueba');
  assert.equal(bench.risk.evaluate(stop()).decision.reasonCode, 'KILL_SWITCH_ACTIVE');
});

test('Execution envía el stop sin TTL y con su disparo; solo lo cancela con una aprobación de salida o de sustitución', () => {
  const bench = tradingBench();
  bench.portfolio.current = { ...bench.portfolio.current, positions: [position()] };
  const { approval } = bench.risk.evaluate(stop());
  assert.ok(approval);
  const result = bench.execution.submit(approval);
  assert.ok(result.ok);
  const [sent] = bench.venue.submitted;
  assert.deepEqual([sent?.type, sent?.triggerPrice?.toString(), sent?.expiresAt, sent?.limitPrice], ['stop_market', '38000.1', null, null]);
  bench.execution.onVenueUpdate({ clientOrderId: result.clientOrderId, exchangeOrderId: 'x', status: 'open', filled: d('0'), averagePrice: null, fills: [], exchangeRejectCode: null, origin: 'rest', exchangeTime: null });
  assert.equal(bench.execution.cancel(result.clientOrderId, null, 'sin aprobación'), false, 'un stop no se cancela sin aprobación');
  assert.equal(bench.venue.canceled.length, 0);
  assert.equal(bench.execution.cancel(result.clientOrderId, '00000000-0000-4000-8000-000000000001', 'salida aprobada'), true);
  assert.deepEqual([bench.execution.order(result.clientOrderId)?.state, bench.venue.canceled[0]?.approvalId], ['CANCEL_PENDING', '00000000-0000-4000-8000-000000000001']);
  // El kill switch no toca los stops de protección.
  assert.deepEqual(bench.execution.onKillSwitch(), []);
});
