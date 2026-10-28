// INV-06 (SECURITY_AND_TRADING_INVARIANTS.md), paso 24: Strategy no puede evitar Risk en el sistema compuesto. Los
// límites de módulos (INV-06a y b) y el token (INV-06c) se prueban aparte; aquí, una estrategia hostil corre de verdad
// por el backtest y nada de lo que devuelve llega al venue sin una decisión de Risk que lo apruebe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../../src/app/backtest.ts';
import { DEFAULT_RISK_LIMITS } from '../../src/risk/limits.ts';
import { Decimal } from '../../src/shared/decimal.ts';
import { random, type RandomParams } from '../../src/strategy/baselines.ts';
import type { Strategy, StrategyDecision } from '../../src/strategy/types.ts';
import { traceOrders } from '../src/app/trace.ts';
import { kitSpec, walkCandles, walkCloses } from '../src/app/walk.ts';

const candles = walkCandles(walkCloses(3, 300));
const honest = random({ seed: 42, entryProbability: 0.3, exitProbability: 0.2, stopFraction: 0.05 }, '1h');

/** RANDOM con las mismas decisiones, pero cada una lleva lo que una estrategia hostil querría imponer. */
function hostile(extra: Record<string, unknown>): Strategy<RandomParams> {
  return {
    ...honest.strategy,
    evaluate: (input): StrategyDecision => {
      const decision: StrategyDecision = honest.strategy.evaluate(input);
      const forged = { ...decision, ...extra }; // una decisión con campos de más sigue siendo una StrategyDecision
      return forged;
    },
  };
}

function runWith(strategy: Strategy<RandomParams>) {
  return runBacktest(kitSpec({ ...honest, strategy }, candles, 7));
}

test('INV-06f: Strategy no evita Risk: toda orden y todo fill vuelven a una decisión aprobada, y una decisión forjada no cambia nada', () => {
  const base = runWith(honest.strategy);
  const orders = traceOrders(base.journal); // lanza si una orden o un fill no tienen intención, decisión aprobada y token previos
  assert.ok(orders.filter((o) => o.intent.kind === 'entry').length >= 10, 'el escenario abre posiciones');
  assert.ok(orders.some((o) => o.intent.kind === 'exit') && orders.some((o) => o.intent.kind === 'protective_stop'));
  // El rastreo muerde: sin las decisiones de Risk, o sin sus tokens, la cadena se rompe.
  for (const missing of ['RiskDecisionMade', 'OrderApproved', 'OrderIntentCreated']) {
    assert.throws(() => traceOrders(base.journal.filter((e) => e.type !== missing)), /sin/, missing);
  }
  // Cada entrada sale del tamaño de Risk: no pasa del tope por activo con el patrimonio de ese momento.
  for (const order of orders.filter((o) => o.intent.kind === 'entry')) {
    const notional = Decimal.parse(order.decision.approvedNotional?.toString() ?? 'NaN');
    const equity = Decimal.parse(String(order.decision.detail['equity']));
    assert.ok(!notional.gt(equity.times(DEFAULT_RISK_LIMITS.maxPositionFraction)), `${notional.toString()} de ${equity.toString()}`);
    assert.equal(order.intent.sizing.mode, 'risk', 'el tamaño lo pone Risk, nunca la estrategia');
  }

  // Una estrategia que intenta fijar cantidad, saltarse la aprobación o marcar sus órdenes como de sistema no cambia ni
  // un byte del diario: el Strategy Engine solo lee action, stopPrice y reason.
  const forged = runWith(hostile({ quantity: 1e9, sizing: { mode: 'quantity' }, approved: true, origin: 'system', reduceOnly: true, approval: 'falsa' }));
  assert.equal(forged.journalSha256, base.journalSha256);
});

test('INV-06f: con un stop inválido o ausente, la entrada de la estrategia se rechaza en Risk (STOP_INVALID) y no llega al venue', () => {
  for (const stop of [Number.NaN, -1, 0, 1e12]) {
    const result = runWith(hostile({ stopPrice: stop }));
    const decisions = result.journal.filter((e) => e.type === 'RiskDecisionMade').map((e) => e.payload as { decision: string; reasonCodes: string[] });
    assert.ok(decisions.length > 0, String(stop));
    assert.ok(decisions.every((d) => d.decision === 'REJECTED' && d.reasonCodes.includes('STOP_INVALID')), String(stop));
    assert.equal(result.metrics.fills, 0, `stop ${String(stop)}: ningún fill`);
    assert.equal(result.journal.filter((e) => e.type === 'OrderApproved' || e.type === 'OrderStateChanged').length, 0);
  }
});

test('INV-06f: la estrategia no puede escribir en lo que recibe; intentarlo detiene el backtest antes de que salga nada', () => {
  const writer: Strategy<RandomParams> = {
    ...honest.strategy,
    evaluate: (input) => {
      (input.features.values as Record<string, number | null>)['close'] = 1; // las features llegan congeladas
      return { action: 'hold', reason: 'no llega aquí' };
    },
  };
  assert.throws(() => runWith(writer), TypeError);
});
