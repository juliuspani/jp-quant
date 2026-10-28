// Estrategias de referencia (paso 24, ADR 0027): BASELINE, RANDOM y BUY_AND_HOLD. Decisiones puras, deterministas y sin
// parámetros por defecto. El camino completo y el control negativo están en test/src/app/baselines.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeatureVector } from '../../../src/features/types.ts';
import { baseline, buyAndHold, random } from '../../../src/strategy/baselines.ts';
import type { PositionView, Strategy, StrategyDecision } from '../../../src/strategy/types.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);
const HELD: PositionView = { quantity: 1, entryPrice: 100, stopPrice: 90, highestPrice: 100 };

function vector(setId: string, values: Record<string, number | null>, asOf = T0, symbol = 'BTC/EUR'): FeatureVector {
  return { symbol, timeframe: '1h', asOf, computedAt: asOf + 60_000, featureSetId: setId, featureSetVersion: 1, values };
}

function decide<P>(strategy: Strategy<P>, params: P, v: FeatureVector, position: PositionView | null = null): StrategyDecision {
  return strategy.evaluate({ asOf: v.asOf, symbol: v.symbol, features: v, regime: null, position, params });
}

test('BASELINE: entra con el cierre sobre la EMA, con el stop a su fracción del cierre, y sale cuando cae por debajo', () => {
  const kit = baseline({ emaPeriod: 20, stopFraction: 0.05 }, '1h');
  const { strategy, featureSet, params } = kit;
  assert.deepEqual(featureSet.features.map((f) => f.id), ['close', 'ema_20']);
  assert.deepEqual(strategy.featureSet, { id: 'cierre-ema_20', version: 1 });
  assert.equal(strategy.warmupBars, 100, 'el calentamiento de la EMA: 5 veces su periodo');
  const set = featureSet.id;
  assert.deepEqual(decide(strategy, params, vector(set, { close: 110, ema_20: 100 })), { action: 'enter', stopPrice: 110 * 0.95, reason: 'cierre sobre la EMA' });
  assert.equal(decide(strategy, params, vector(set, { close: 90, ema_20: 100 })).action, 'hold');
  assert.equal(decide(strategy, params, vector(set, { close: 90, ema_20: 100 }), HELD).action, 'exit');
  assert.equal(decide(strategy, params, vector(set, { close: 110, ema_20: 100 }), HELD).action, 'hold');
  assert.deepEqual(decide(strategy, params, vector(set, { close: 110, ema_20: null })), { action: 'hold', reason: 'sin features' });
});

test('RANDOM: decide solo con la semilla, el símbolo y el instante; la misma entrada da la misma decisión', () => {
  const { strategy, params } = random({ seed: 7, entryProbability: 0.2, exitProbability: 0.1, stopFraction: 0.05 }, '1h');
  const run = (closes: (t: number) => number, p = params): string[] =>
    Array.from({ length: 400 }, (_, i) => decide(strategy, p, vector('cierre', { close: closes(i) }, T0 + i * HOUR)).action);
  const first = run(() => 100);
  assert.deepEqual(run(() => 100), first, 'pura: repetirla da lo mismo');
  assert.deepEqual(run((i) => 50 + (i % 7) * 13), first, 'el precio no cambia la decisión, solo el stop');
  assert.notDeepEqual(run(() => 100, { ...params, seed: 8 }), first, 'otra semilla, otras decisiones');
  // Unas 80 entradas de 400 (p = 0,2; error típico 8).
  const entries = first.filter((a) => a === 'enter').length;
  assert.ok(entries > 50 && entries < 110, String(entries));
  const exits = Array.from({ length: 400 }, (_, i) => decide(strategy, params, vector('cierre', { close: 100 }, T0 + i * HOUR), HELD).action);
  assert.ok(!exits.includes('enter') && exits.includes('exit') && exits.every((a) => a === 'exit' || a === 'hold'));
  const other = Array.from({ length: 400 }, (_, i) => decide(strategy, params, vector('cierre', { close: 100 }, T0 + i * HOUR, 'ETH/EUR')).action);
  assert.notDeepEqual(other, first, 'cada símbolo tiene su propio azar');
});

test('BUY_AND_HOLD: entra en cuanto puede y después solo mantiene', () => {
  const { strategy, params } = buyAndHold({ stopFraction: 0.5 }, '1h');
  assert.deepEqual(decide(strategy, params, vector('cierre', { close: 200 })), { action: 'enter', stopPrice: 100, reason: 'comprar y mantener' });
  assert.equal(decide(strategy, params, vector('cierre', { close: 1 }), HELD).action, 'hold');
  assert.equal(decide(strategy, params, vector('cierre', { close: null })).action, 'hold');
});

test('sin parámetros por defecto: valores fuera de rango se rechazan al construirlas', () => {
  for (const bad of [0, 1, -0.1, Number.NaN]) {
    assert.throws(() => baseline({ emaPeriod: 20, stopFraction: bad }, '1h'), RangeError);
    assert.throws(() => buyAndHold({ stopFraction: bad }, '1h'), RangeError);
    assert.throws(() => random({ seed: 1, entryProbability: bad, exitProbability: 0.1, stopFraction: 0.05 }, '1h'), RangeError);
  }
  assert.throws(() => baseline({ emaPeriod: 1, stopFraction: 0.05 }, '1h'), RangeError);
  assert.throws(() => random({ seed: -1, entryProbability: 0.1, exitProbability: 0.1, stopFraction: 0.05 }, '1h'), RangeError);
});
