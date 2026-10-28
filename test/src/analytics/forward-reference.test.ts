// Referencia de las etapas 2 y 3 (A.5; ADR 0043): resultados conocidos con series constantes y con una pérdida aislada,
// determinismo por semilla, longitud del remuestreo e intervalo de la Poisson calculado a mano.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forwardReference, poissonCentralInterval } from '../../../src/analytics/forward-reference.ts';
import { stationaryBootstrapIndices, StatisticsError } from '../../../src/analytics/statistics.ts';
import { seededRng } from '../../../src/kernel/random.ts';

function near(actual: number, expected: number, tolerance: number): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${String(actual)} ≠ ${String(expected)} (±${String(tolerance)})`);
}

test('remuestreo de otra longitud: índices válidos y, con la longitud por defecto, los mismos que antes', () => {
  const short = stationaryBootstrapIndices(10, 2, seededRng(3, 'x'), 25);
  assert.equal(short.length, 25);
  assert.ok(short.every((i) => i >= 0 && i < 10));
  assert.deepEqual(stationaryBootstrapIndices(500, 20, seededRng(7, 'b'), 500), stationaryBootstrapIndices(500, 20, seededRng(7, 'b')));
  assert.throws(() => stationaryBootstrapIndices(10, 2, seededRng(3, 'x'), 0), StatisticsError);
  assert.throws(() => stationaryBootstrapIndices(10, 2, seededRng(3, 'x'), 2.5), StatisticsError);
});

test('con rentabilidades constantes, todos los remuestreos dan la misma rentabilidad y la misma caída', () => {
  const up = forwardReference(Array<number>(100).fill(0.001), { length: 365, meanBlock: 28, resamples: 200, rng: seededRng(1, 'r') });
  near(up.returnP5, 1.001 ** 365 - 1, 1e-12);
  assert.equal(up.drawdownP95, 0);
  assert.equal(up.resamples, 200);
  const down = forwardReference(Array<number>(100).fill(-0.01), { length: 50, meanBlock: 5, resamples: 200, rng: seededRng(1, 'r') });
  near(down.returnP5, 0.99 ** 50 - 1, 1e-12);
  near(down.drawdownP95, 1 - 0.99 ** 50, 1e-12);
});

test('la caída sale del camino remuestreado: sin reinicios, cada remuestreo es una vuelta con la pérdida dentro', () => {
  const series = [0, 0, 0, -0.2, 0, 0, 0, 0, 0, 0];
  const ref = forwardReference(series, { length: 10, meanBlock: 1e12, resamples: 50, rng: seededRng(2, 'r') });
  near(ref.returnP5, -0.2, 1e-15);
  near(ref.drawdownP95, 0.2, 1e-15);
});

test('determinista por semilla, con otra semilla otros remuestreos', () => {
  const series = Array.from({ length: 300 }, (_, i) => Math.sin(i) / 100);
  const options = { length: 60, meanBlock: 10, resamples: 500 };
  const a = forwardReference(series, { ...options, rng: seededRng(9, 's') });
  assert.deepEqual(a, forwardReference(series, { ...options, rng: seededRng(9, 's') }));
  assert.notDeepEqual(a, forwardReference(series, { ...options, rng: seededRng(10, 's') }));
  assert.ok(a.drawdownP95 > 0 && a.drawdownP95 < 1);
});

test('fail closed: serie vacía, rentabilidad no finita o de −100 %, y opciones inválidas', () => {
  const ok = { length: 10, meanBlock: 2, resamples: 10, rng: seededRng(1, 'x') };
  assert.throws(() => forwardReference([], ok), StatisticsError);
  assert.throws(() => forwardReference([0.1, Number.NaN], ok), StatisticsError);
  assert.throws(() => forwardReference([0.1, -1], ok), StatisticsError);
  assert.throws(() => forwardReference([0.1], { ...ok, length: 0 }), StatisticsError);
  assert.throws(() => forwardReference([0.1], { ...ok, resamples: 0 }), StatisticsError);
  assert.throws(() => forwardReference([0.1], { ...ok, meanBlock: 0.5 }), StatisticsError);
});

test('intervalo central de la Poisson, calculado a mano', () => {
  // Media 1: P(X ≤ 0) = 0,368 ya supera 0,025; P(X ≤ 2) = 0,920 y P(X ≤ 3) = 0,981.
  assert.deepEqual(poissonCentralInterval(1), { lower: 0, upper: 3 });
  // Media 8,102: P(X ≤ 2) = 0,013 y P(X ≤ 3) = 0,040; P(X ≤ 13) = 0,963 y P(X ≤ 14) = 0,981.
  assert.deepEqual(poissonCentralInterval(8.102), { lower: 3, upper: 14 });
  // Al 50 %, se estrecha alrededor de la media: P(X ≤ 5) = 0,182 y P(X ≤ 6) = 0,301; P(X ≤ 9) = 0,704 y P(X ≤ 10) = 0,806.
  assert.deepEqual(poissonCentralInterval(8.102, 0.5), { lower: 6, upper: 10 });
  assert.throws(() => poissonCentralInterval(0), StatisticsError);
  assert.throws(() => poissonCentralInterval(Number.NaN), StatisticsError);
  assert.throws(() => poissonCentralInterval(800), StatisticsError);
  assert.throws(() => poissonCentralInterval(5, 1), StatisticsError);
});
