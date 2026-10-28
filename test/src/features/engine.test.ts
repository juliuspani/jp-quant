// Feature Engine (ADR 0025): calentamiento, timestamp, huecos, independencia del inicio de la serie, símbolos
// separados y fail closed ante una entrada que incumple el contrato.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ema, logReturn, rsi, sma } from '../../../src/features/definitions.ts';
import { FeatureEngine, FeatureInputError } from '../../../src/features/engine.ts';
import type { FeatureDefinition, FeatureSet, FeatureVector } from '../../../src/features/types.ts';
import { seededRng } from '../../../src/kernel/random.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { LATENCY_MS, flat, randomWalk, received, type Received } from './helpers.ts';

const SET: FeatureSet = { id: 'prueba', version: 3, timeframe: '1h', features: [logReturn(1), ema(3), rsi(2)] };

function run(set: FeatureSet, series: readonly Received[]): FeatureVector[] {
  const engine = new FeatureEngine(set);
  return series.map((r) => engine.onCandleClosed(r.candle, r.receivedTime));
}

test('cada feature es null hasta tener sus warmupBars velas contiguas', () => {
  const series = Array.from({ length: 16 }, (_, i) => received('A/EUR', '1h', i, flat(String(100 + i))));
  const vectors = run(SET, series);
  const firstValue = (id: string): number => vectors.findIndex((v) => v.values[id] !== null);
  assert.equal(firstValue('logret_1'), 1); // 2 velas
  assert.equal(firstValue('ema_3'), 14); // 5·3 velas
  assert.equal(firstValue('rsi_2'), 10); // 5·2 + 1 velas
});

test('timestamp: asOf es el cierre de la vela y computedAt su received_time; el vector va congelado', () => {
  const r = received('A/EUR', '1h', 5, flat('100'));
  const [v] = run(SET, [r]);
  assert.ok(v !== undefined);
  assert.equal(v.asOf, r.candle.closeTime);
  assert.equal(v.computedAt, r.receivedTime);
  assert.equal(v.computedAt, r.candle.closeTime + LATENCY_MS);
  assert.deepEqual([v.featureSetId, v.featureSetVersion, v.symbol, v.timeframe], ['prueba', 3, 'A/EUR', '1h']);
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.values));
  for (const value of Object.values(v.values)) assert.ok(value === null || typeof value === 'number');
});

// Huecos (ADR 0036): la vela que falta se excluye y nunca se rellena, sin vaciar la ventana. sma_16 admite ⌊√16 / 2⌋ = 2
// velas de menos; logret_1 (ventana de 2) y rsi_2 (de 3), ninguna.
const GAPS: FeatureSet = { id: 'prueba-huecos', version: 1, timeframe: '1h', features: [logReturn(1), sma(16), rsi(2)] };
const meanOf = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

test('una vela que falta se excluye: la media larga sigue con las velas observadas, y las ventanas cortas esperan', () => {
  const series = randomWalk(seededRng(7, 'hueco'), 'A/EUR', '1h', 0, 60, 100, new Set([30]));
  const vectors = run(GAPS, series);
  const afterGap = series.findIndex((r) => r.candle.openTime > series[29]!.candle.openTime + 3_600_000);
  assert.equal(afterGap, 30, 'la vela 31 es la primera tras el hueco');
  const closes = series.map((r) => r.candle.close.toAnalysis());
  assert.ok(Math.abs((vectors[afterGap]?.values['sma_16'] ?? Number.NaN) - meanOf(closes.slice(afterGap - 15, afterGap + 1))) < 1e-9, 'las 16 últimas observadas, sin rellenar');
  assert.equal(vectors[afterGap]?.values['logret_1'], null, 'un retorno de una vela no cruza el hueco');
  assert.notEqual(vectors[afterGap + 1]?.values['logret_1'], null, 'a la vela siguiente, ya no lo cruza');
  assert.equal(vectors[afterGap + 1]?.values['rsi_2'], null, 'el RSI de 2 tampoco, mientras el hueco esté en sus velas');
  assert.ok(vectors.slice(afterGap).every((v) => v.values['sma_16'] !== null), 'ninguna vela sin media larga por un hueco de una');
});

test('si faltan más velas de las que admite la fórmula, null hasta que el hueco sale de sus velas', () => {
  const series = randomWalk(seededRng(8, 'hueco-largo'), 'A/EUR', '1h', 0, 80, 100, new Set([40, 41, 42]));
  const vectors = run(GAPS, series);
  const afterGap = series.findIndex((r) => r.candle.openTime > series[39]!.candle.openTime + 3_600_000);
  assert.equal(vectors[afterGap]?.values['sma_16'], null, 'tres velas de menos, más de las dos que admite');
  assert.equal(vectors[afterGap + 14]?.values['sma_16'], null, 'el hueco sigue en sus 16 velas');
  assert.notEqual(vectors[afterGap + 15]?.values['sma_16'], null, 'ya no');
});

test('el valor no depende de dónde empieza la serie: mismo cálculo en backtest y en real', () => {
  const rng = seededRng(11, 'inicio');
  const series = randomWalk(rng, 'A/EUR', '1h', 0, 120, 100);
  const full = run(SET, series);
  const late = run(SET, series.slice(37));
  // Desde que el motor que empieza tarde tiene el calentamiento más largo (15 velas, el de ema_3), los valores coinciden.
  assert.deepEqual(full.slice(37 + 14), late.slice(14));
  assert.notDeepEqual(full[37 + 13], late[13], 'antes de eso, ema_3 aún no tiene valor en el motor tardío');
});

test('cada símbolo tiene su propia ventana', () => {
  const rng = seededRng(3, 'simbolos');
  const a = randomWalk(rng, 'A/EUR', '1h', 0, 40, 100);
  const b = randomWalk(rng, 'B/EUR', '1h', 0, 40, 5);
  const mixed = a.flatMap((r, i) => [r, b[i]!]);
  const vectors = run(SET, mixed);
  assert.deepEqual(vectors.filter((v) => v.symbol === 'A/EUR'), run(SET, a));
  assert.deepEqual(vectors.filter((v) => v.symbol === 'B/EUR'), run(SET, b));
});

test('un resultado no finito es null', () => {
  const weird = (id: string, value: number): FeatureDefinition => ({
    id, version: 1, formula: 'valor fijo de prueba', window: 1, warmupBars: 1, missingData: 'null si no es finito', compute: () => value,
  });
  const set: FeatureSet = { id: 'raro', version: 1, timeframe: '1h', features: [weird('nan', Number.NaN), weird('inf', Number.POSITIVE_INFINITY)] };
  const [v] = run(set, [received('A/EUR', '1h', 0, flat('1'))]);
  assert.deepEqual(v?.values, { nan: null, inf: null });
});

test('fail closed: velas que incumplen el contrato lanzan FeatureInputError', () => {
  const ok = received('A/EUR', '1h', 10, flat('100'));
  const fails = (prior: readonly Received[], candle: Received['candle'], receivedTime: number, why: string): void => {
    const engine = new FeatureEngine(SET);
    for (const r of prior) engine.onCandleClosed(r.candle, r.receivedTime);
    assert.throws(() => engine.onCandleClosed(candle, receivedTime), FeatureInputError, why);
  };
  fails([], ok.candle, ok.candle.closeTime - 1, 'recibida antes de cerrar: look-ahead');
  const earlier = received('B/EUR', '1h', 5, flat('100'));
  fails([ok], earlier.candle, earlier.receivedTime, 'received_time hacia atrás, aunque sea de otro símbolo');
  fails([ok], ok.candle, ok.receivedTime, 'vela repetida');
  fails([ok], received('A/EUR', '1h', 9, flat('100')).candle, ok.receivedTime, 'vela desordenada');
  fails([], { ...ok.candle, timeframe: '4h' }, ok.receivedTime, 'otro timeframe');
  fails([], { ...ok.candle, closeTime: ok.candle.closeTime + 1 }, ok.receivedTime + 1, 'cierre incoherente');
  fails([], { ...ok.candle, high: Decimal.parse('99') }, ok.receivedTime, 'máximo por debajo del cierre');
  fails([], { ...ok.candle, low: Decimal.parse('101') }, ok.receivedTime, 'mínimo por encima del cierre');
  fails([], { ...ok.candle, close: Decimal.parse('0'), low: Decimal.parse('0') }, ok.receivedTime, 'precio no positivo');
  fails([], { ...ok.candle, volume: Decimal.parse('-1') }, ok.receivedTime, 'volumen negativo');
});

test('fail closed: un conjunto mal formado no arranca', () => {
  const bad = (features: FeatureDefinition[]): void => {
    assert.throws(() => new FeatureEngine({ id: 'malo', version: 1, timeframe: '1h', features }), RangeError);
  };
  bad([]);
  bad([ema(3), ema(3)]);
  bad([{ ...ema(3), warmupBars: 2 }]);
  bad([{ ...ema(3), window: 0 }]);
  bad([{ ...ema(3), missingData: ' ' }]);
});
