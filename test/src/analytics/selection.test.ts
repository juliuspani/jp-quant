// Elección en train del walk-forward (paso 28, ADR 0032): ventanas con purging y embargo, la puntuación de train sin los
// periodos embargados y la elección determinista. Datos sintéticos de resultado conocido.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsError, sharpeOf } from '../../../src/analytics/performance.ts';
import { chooseConfiguration, runPeriods, trainScore, trainWindows, type Fold } from '../../../src/analytics/selection.ts';

const H = 3_600_000;
const fold = (train: [number, number], validation: [number, number]): Fold => ({
  train: { from: train[0] * H, to: train[1] * H },
  validation: { from: validation[0] * H, to: validation[1] * H },
});
// Walk-forward de tres tramos: el tercero entrena sobre la validación del primero.
const FOLDS = [fold([5, 30], [30, 60]), fold([5, 60], [60, 90]), fold([30, 90], [90, 120])];

test('purging: la ventana de train acaba h velas antes; embargo: e velas tras cada tramo de evaluación que cae dentro', () => {
  const windows = trainWindows(FOLDS, 3 * H, 4 * H);
  assert.deepEqual(windows.map((w) => [w.from / H, w.to / H]), [[5, 27], [5, 57], [30, 87]]);
  // Solo la validación del primer tramo (acaba en la hora 60) termina dentro de una ventana posterior: la del tercero.
  assert.deepEqual(windows.map((w) => w.embargoed.map((e) => [e.from / H, e.to / H])), [[], [], [[60, 64]]]);
  // El embargo nunca pasa del final de la ventana.
  const [, , last] = trainWindows(FOLDS, 3 * H, 30 * H);
  assert.deepEqual(last?.embargoed.map((e) => [e.from / H, e.to / H]), [[60, 87]]);
  // Sin purging ni embargo, la ventana es la de train entera.
  assert.deepEqual(trainWindows(FOLDS, 0, 0).map((w) => [w.from / H, w.to / H, w.embargoed.length]), [[5, 30, 0], [5, 60, 0], [30, 90, 0]]);
});

test('fail closed: e < h, un purging que vacía la ventana o un valor negativo lanzan', () => {
  assert.throws(() => trainWindows(FOLDS, 4 * H, 3 * H), AnalyticsError, 'e ≥ h (quant-research §4)');
  assert.throws(() => trainWindows(FOLDS, 25 * H, 25 * H), AnalyticsError, 'el primer train dura 25 velas');
  assert.throws(() => trainWindows(FOLDS, -1, 0), AnalyticsError);
});

test('periodos de un run como los del informe: el primero desde el inicio y el último a valor de liquidación', () => {
  const curve = [{ at: 1 * H, equity: 101 }, { at: 2 * H, equity: 99 }, { at: 3 * H, equity: 102 }];
  const periods = runPeriods({ from: 0, startEquity: 100, endEquity: 101, curve });
  assert.deepEqual(periods.map((p) => [p.start / H, p.end / H]), [[0, 1], [1, 2], [2, 3]]);
  const expected = [101 / 100 - 1, 99 / 101 - 1, 101 / 99 - 1];
  for (const [i, p] of periods.entries()) assert.ok(Math.abs(p.ret - (expected[i] ?? 0)) < 1e-12, `periodo ${String(i)}`);
  assert.deepEqual(runPeriods({ from: 0, startEquity: 100, endEquity: 100, curve: [] }), []);
});

test('puntuación de train: Sharpe anualizado de los periodos que no están embargados (por su punto medio)', () => {
  const rets = [0.01, -0.02, 0.03, 0.5, -0.4, 0.02, 0.01, -0.01];
  const periods = rets.map((ret, k) => ({ start: k * H, end: (k + 1) * H, ret }));
  const window = { from: 0, to: 8 * H, embargoed: [{ from: 3 * H, to: 5 * H }] };
  const kept = [0.01, -0.02, 0.03, 0.02, 0.01, -0.01]; // sin los periodos 3 y 4, cuyo punto medio cae en [3, 5)
  const expected = (sharpeOf(kept).sharpe ?? 0) * Math.sqrt(24 * 365);
  assert.ok(Math.abs((trainScore(periods, window, 24 * 365) ?? 0) - expected) < 1e-12);
  assert.notEqual(trainScore(periods, window, 24 * 365), trainScore(periods, { ...window, embargoed: [] }, 24 * 365), 'el embargo cambia la puntuación');
  assert.equal(trainScore(periods.map((p) => ({ ...p, ret: 0 })), window, 365), null, 'sin variación no hay Sharpe');
});

test('elección: la mejor puntuación; sin Sharpe cuenta como 0; con empate gana la primera de la rejilla', () => {
  assert.equal(chooseConfiguration([0.2, 1.1, 0.7]), 1);
  assert.equal(chooseConfiguration([-0.5, null, -0.1]), 1, 'una curva plana gana a perder');
  assert.equal(chooseConfiguration([0.3, 0.3]), 0);
  assert.equal(chooseConfiguration([null, null]), 0);
  assert.throws(() => chooseConfiguration([]), AnalyticsError);
  assert.throws(() => chooseConfiguration([Number.NaN]), AnalyticsError);
});
