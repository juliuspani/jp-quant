// Prueba de la composición (compromiso del paso 14 al crear src/app/; ARCHITECTURE.md §15.2): app/ no entrega a Strategy
// ningún objeto con el que se pueda enviar una orden, cambiar los datos de mercado o tocar la cartera. El análisis de
// imports no ve lo que se inyecta en tiempo de ejecución: solo se puede comprobar así. INV-06d, la prueba de la
// composición de paper, shadow y live, sigue siendo del paso 32.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TradingSystem } from '../../../src/app/trading-system.ts';
import { MemoryExecutionStore, MemoryRiskStore } from '../../../src/backtest/research-stores.ts';
import { SimulatedClock } from '../../../src/backtest/simulated-clock.ts';
import type { ExecutionVenue } from '../../../src/kernel/execution.ts';
import { seededIds, seededUuids } from '../../../src/kernel/random.ts';
import { DEFAULT_RISK_LIMITS } from '../../../src/risk/limits.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { CROSS, FEATURES, T0 } from './scenario.ts';

// Lo que permitiría enviar o cancelar órdenes, aprobarlas, escribir datos de mercado o cambiar la cartera.
const WRITERS = [
  'submit', 'cancel', 'queryOrder', 'requestAccountSnapshot', 'evaluate', 'activateKillSwitch', 'recordExecutionRejection',
  'onKillSwitch', 'reconcile', 'onVenueUpdate', 'onVenueFailure', 'onAccountSnapshot', 'onMarketData', 'onMarketBatch', 'ingest',
  'applyFill',
];

function names(value: object): string[] {
  const found = new Set<string>();
  for (let current: object | null = value; current !== null && current !== Object.prototype; current = Object.getPrototypeOf(current) as object | null) {
    for (const key of Object.getOwnPropertyNames(current)) found.add(key);
  }
  return [...found];
}

test('Strategy solo recibe vistas de solo lectura: ni el venue, ni Execution, ni Risk, ni nada con qué escribir', () => {
  const venue: ExecutionVenue = { submit: () => undefined, cancel: () => undefined, queryOrder: () => undefined, requestAccountSnapshot: () => undefined };
  const system = new TradingSystem({
    clock: new SimulatedClock(T0),
    intentIds: seededIds(1, 'intent'),
    approvalIds: seededUuids(1, 'approval'),
    venue,
    riskStore: new MemoryRiskStore(),
    executionStore: new MemoryExecutionStore(),
    featureSet: FEATURES,
    strategy: CROSS,
    params: { stopFraction: 0.05 },
    bucket: 'core',
    riskLimits: DEFAULT_RISK_LIMITS,
    quoteCurrency: 'EUR',
    startingCash: Decimal.parse('1000'),
    commit: 'prueba',
    orderTtlMs: 300_000,
    tradingFrom: T0,
    journal: () => undefined,
  });
  const { market, portfolio, ids, strategy } = system.strategyDeps;
  assert.equal(strategy, CROSS, 'la estrategia es la suya');
  for (const [name, view] of [['market', market], ['portfolio', portfolio], ['ids', ids]] as const) {
    assert.deepEqual(names(view).filter((key) => WRITERS.includes(key)), [], `${name} expone un método que escribe`);
    for (const forbidden of [venue, system.execution, system.risk, system.market, system.portfolio]) assert.notEqual(view, forbidden, name);
  }
  assert.deepEqual(names(market).sort(), ['book', 'instrument', 'quote', 'volume24h']);
  assert.deepEqual(names(portfolio), ['snapshot']);
  assert.ok(Object.isFrozen(market) && Object.isFrozen(portfolio) && Object.isFrozen(system.strategyDeps));
  // Las vistas leen lo mismo que los dueños.
  assert.equal(portfolio.snapshot().cash.toString(), system.portfolio.snapshot().cash.toString());
  assert.equal(market.quote('BTC/EUR'), system.market.quote('BTC/EUR'));
});
