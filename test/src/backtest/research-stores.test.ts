// Almacén de investigación de Risk y Execution: las reglas que tendrán las tablas de SQLite del paso 33.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryExecutionStore, MemoryRiskStore, StoreError } from '../../../src/backtest/research-stores.ts';
import type { Fill, OrderRecord } from '../../../src/kernel/execution.ts';
import type { DecisionRecord } from '../../../src/kernel/stores.ts';
import { d, SYMBOL, T0 } from '../harness/trading.ts';

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: T0, layer: 'risk', decisionId: 'd1', intentId: 'i1', approvalId: null, origin: 'strategy', symbol: SYMBOL, side: 'buy',
    quantity: d('1'), notional: null, decision: 'REJECTED', reasonCode: 'STALE_DATA', reasonCodes: ['STALE_DATA'],
    detail: { a: 1 }, configHash: 'h', commit: 'c', ...overrides,
  };
}

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    clientOrderId: 'ijp-a', approvalId: 'ap-1', intentId: 'i1', symbol: SYMBOL, side: 'buy', type: 'market', reduceOnly: false,
    quantity: d('1'), limitPrice: null, triggerPrice: null, expiresAt: T0 + 1, createdAt: T0, state: 'PENDING_SEND', filled: d('0'),
    ...overrides,
  };
}

test('risk_decisions: solo inserción, congelado y con códigos del catálogo', () => {
  const store = new MemoryRiskStore();
  store.appendDecision(decision());
  const [saved] = store.decisions();
  assert.ok(saved && Object.isFrozen(saved) && Object.isFrozen(saved.detail) && Object.isFrozen(saved.reasonCodes));
  assert.throws(() => store.appendDecision(decision({ reasonCode: null, reasonCodes: [] })), StoreError, 'un rechazo sin código');
  assert.throws(() => store.appendDecision(decision({ reasonCodes: ['NO_EXISTE' as 'STALE_DATA'], reasonCode: 'NO_EXISTE' as 'STALE_DATA' })), StoreError);
  assert.throws(() => store.appendDecision(decision({ reasonCodes: ['MAX_EXPOSURE', 'STALE_DATA'] })), StoreError, 'principal que no es el primero');
  store.appendDecision(decision({ decision: 'APPROVED', reasonCode: null, reasonCodes: [] }));
  assert.equal(store.decisions().length, 2);
  assert.equal(store.loadState(), null);
});

test('órdenes: un token una sola vez, un client order ID una sola vez, y todo o nada', () => {
  const store = new MemoryExecutionStore();
  store.reserveAndInsert('ap-1', order());
  assert.ok(store.isApprovalUsed('ap-1'));
  assert.throws(() => store.reserveAndInsert('ap-1', order({ clientOrderId: 'ijp-b' })), StoreError);
  assert.throws(() => store.reserveAndInsert('ap-2', order({ approvalId: 'ap-2' })), StoreError, 'client order ID repetido');
  assert.equal(store.isApprovalUsed('ap-2'), false, 'un intento fallido no marca el token');
  assert.throws(() => store.reserveAndInsert('ap-3', order({ approvalId: 'ap-3', clientOrderId: 'ijp-c', state: 'SENT' })), StoreError);
  assert.throws(() => store.reserveAndInsert('ap-4', order({ clientOrderId: 'ijp-d' })), StoreError, 'la orden es de otra aprobación');
});

test('transiciones encadenadas y fills idempotentes por símbolo y trade_id', () => {
  const store = new MemoryExecutionStore();
  store.reserveAndInsert('ap-1', order());
  const t = { clientOrderId: 'ijp-a', filled: d('0'), origin: 'internal', exchangeTime: null, localTime: T0, reason: 'x' } as const;
  store.appendTransition({ ...t, from: 'PENDING_SEND', to: 'SENT' });
  assert.throws(() => store.appendTransition({ ...t, from: 'PENDING_SEND', to: 'SENT' }), StoreError, 'from que no es el estado actual');
  assert.throws(() => store.appendTransition({ ...t, clientOrderId: 'ijp-x', from: 'SENT', to: 'OPEN' }), StoreError);
  assert.equal(store.loadNonTerminal().length, 1);
  store.appendTransition({ ...t, from: 'SENT', to: 'FILLED', filled: d('1') });
  assert.equal(store.order('ijp-a')?.state, 'FILLED');
  assert.equal(store.loadNonTerminal().length, 0);
  const fill: Fill = { tradeId: 't1', clientOrderId: 'ijp-a', symbol: SYMBOL, side: 'buy', quantity: d('1'), price: d('1'), fee: d('0'), feeCurrency: 'EUR', feeEstimated: false, exchangeTime: T0 };
  assert.equal(store.insertFill(fill), true);
  assert.equal(store.insertFill({ ...fill }), false);
  assert.throws(() => store.insertFill({ ...fill, tradeId: 't2', clientOrderId: 'ijp-x' }), StoreError);
  assert.equal(store.fills().length, 1);
  assert.equal(store.transitions().length, 2);
});
