// Estadística de la validación (paso 26, ADR 0029): cada función contra un resultado conocido, calculado a mano o
// publicado (el ejemplo numérico de Bailey y López de Prado, 2014, para el DSR).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bootstrapInterval, deflatedSharpe, expectedMaxSharpe, meanBlockLength, minTrackRecordLength, moments, normalCdf,
  normalQuantile, nullSharpeVariance, probabilisticSharpe, probabilityOfBacktestOverfitting, sharpeInterval, sharpeLongRunVariance,
  sortedQuantile, stationaryBootstrapIndices, StatisticsError,
} from '../../../src/analytics/statistics.ts';
import { seededRng } from '../../../src/kernel/random.ts';

function near(actual: number | null, expected: number, tolerance: number): void {
  assert.ok(actual !== null, `se esperaba ${String(expected)} y es null`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${String(actual)} ≠ ${String(expected)} (±${String(tolerance)})`);
}

test('normal estándar: valores de tabla y Φ(Φ⁻¹(p)) = p', () => {
  near(normalCdf(0), 0.5, 1e-15);
  near(normalCdf(1.959963984540054), 0.975, 1e-14);
  near(normalCdf(-1.6448536269514722), 0.05, 1e-14);
  near(normalCdf(-8), 6.22096057427178e-16, 1e-20);
  near(normalQuantile(0.975), 1.959963984540054, 1e-12);
  near(normalQuantile(0.05), -1.6448536269514722, 1e-12);
  near(normalQuantile(0.99), 2.3263478740408408, 1e-12);
  for (const p of [1e-10, 0.001, 0.02, 0.3, 0.5, 0.77, 0.98, 0.999999]) near(normalCdf(normalQuantile(p)), p, 1e-13 + p * 1e-12);
  assert.throws(() => normalQuantile(0), StatisticsError);
  assert.throws(() => normalQuantile(1), StatisticsError);
});

test('momentos: 1 a 5 tienen media 3, desviación √2,5, asimetría 0 y curtosis 1,7', () => {
  const m = moments([1, 2, 3, 4, 5]);
  near(m.mean, 3, 1e-15);
  near(m.std, Math.sqrt(2.5), 1e-15);
  near(m.skewness, 0, 1e-15);
  near(m.kurtosis, 1.7, 1e-14);
  // Asimetría de [0, 0, 3]: m2 = 2, m3 = 2 → 2/2^1,5 = 0,7071.
  near(moments([0, 0, 3]).skewness, 1 / Math.SQRT2, 1e-14);
  assert.equal(moments([2, 2, 2]).kurtosis, null, 'sin variación no hay forma');
  assert.throws(() => moments([1]), StatisticsError);
  assert.throws(() => moments([1, Number.NaN]), StatisticsError);
});

test('PSR: SR = SR* da 0,5; con normalidad es Φ(SR·√(T−1)/√(1 + SR²/2))', () => {
  near(probabilisticSharpe({ sharpe: 0.1, periods: 50, skewness: 0, kurtosis: 3 }, 0.1), 0.5, 1e-15);
  const expected = normalCdf((0.1 * 10) / Math.sqrt(1 + 0.5 * 0.01));
  near(probabilisticSharpe({ sharpe: 0.1, periods: 101, skewness: 0, kurtosis: 3 }, 0), expected, 1e-15);
  near(expected, 0.84074, 1e-4);
});

test('DSR: el ejemplo de Bailey y López de Prado (2014) da SR₀ ≈ 0,1132 y DSR ≈ 0,9004', () => {
  // SR anual 2,5 con 1250 días (250 al año), γ₃ = −3, γ₄ = 10, N = 100 y V[SR] anual 0,5.
  const sample = { sharpe: 2.5 / Math.sqrt(250), periods: 1250, skewness: -3, kurtosis: 10 };
  const { sr0, dsr } = deflatedSharpe(sample, 100, 0.5 / 250);
  near(sr0, 0.1132, 5e-4);
  near(dsr, 0.9004, 5e-3);
  assert.equal(expectedMaxSharpe(1, 0.5), 0, 'con N = 1, SR₀ = 0');
  assert.ok(expectedMaxSharpe(1000, 0.002) > expectedMaxSharpe(10, 0.002), 'más pruebas, más exigencia');
});

test('V[SRₙ] (ADR 0039): la de un Sharpe sin habilidad con la misma longitud y dependencia; nunca por debajo de 1/(T − 1)', () => {
  const alternating = Array.from({ length: 101 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  near(nullSharpeVariance(alternating, 5), 0.01, 1e-15); // autocorrelación negativa: el suelo, 1/(T − 1)
  near(nullSharpeVariance(alternating, 0), 0.01, 1e-15);
  assert.throws(() => nullSharpeVariance([0.01, 0.01, 0.01], 2), StatisticsError);
});

test('MinTRL: con SR 0,1 y normalidad, 1 + 1,005·(1,6449/0,1)² ≈ 272,9 periodos; null si SR ≤ 0', () => {
  near(minTrackRecordLength({ sharpe: 0.1, skewness: 0, kurtosis: 3 }), 1 + 1.005 * (1.6448536269514722 / 0.1) ** 2, 1e-9);
  assert.equal(minTrackRecordLength({ sharpe: 0, skewness: 0, kurtosis: 3 }), null);
  assert.equal(minTrackRecordLength({ sharpe: -0.2, skewness: 0, kurtosis: 3 }), null);
});

test('cuantil de tipo 7', () => {
  near(sortedQuantile([1, 2, 3, 4], 0.5), 2.5, 0);
  near(sortedQuantile([1, 2, 3, 4], 0), 1, 0);
  near(sortedQuantile([1, 2, 3, 4], 1), 4, 0);
  near(sortedQuantile([10, 20], 0.25), 12.5, 1e-12);
});

/** Dos observaciones por bloque que suman `value`, con variación dentro del bloque. */
function blockSeries(values: readonly number[]): number[] {
  return values.flatMap((v) => [v / 2 + 0.1, v / 2 - 0.1]);
}

test('PBO = 0 cuando la mejor configuración lo es en todos los bloques', () => {
  const base = blockSeries(Array.from({ length: 16 }, (_, b) => Math.sin(b + 1)));
  // Misma desviación, media mayor con k: el Sharpe ordena igual dentro y fuera de muestra en cualquier combinación.
  const configs = [0, 1, 2, 3].map((k) => base.map((r) => r + 0.01 * k));
  const result = probabilityOfBacktestOverfitting(configs, 16);
  assert.equal(result.combinations, 12870);
  assert.equal(result.pbo, 0);
});

test('PBO = 1 cuando la mejor dentro de muestra es siempre la peor fuera', () => {
  // A suma 0 en total y ninguna mitad de bloques suma 0; B = −A. Lo que A gana dentro, lo pierde fuera.
  const a = blockSeries([...Array.from({ length: 15 }, (_, b) => b + 1), -120]);
  const b = a.map((r) => -r);
  assert.equal(probabilityOfBacktestOverfitting([a, b], 16).pbo, 1);
});

test('PBO: fail closed con una configuración, S impar o series de distinta longitud', () => {
  const s = Array.from({ length: 40 }, (_, i) => Math.sin(i));
  assert.throws(() => probabilityOfBacktestOverfitting([s], 16), StatisticsError);
  assert.throws(() => probabilityOfBacktestOverfitting([s, s], 15), StatisticsError);
  assert.throws(() => probabilityOfBacktestOverfitting([s, s.slice(1)], 4), StatisticsError);
  assert.throws(() => probabilityOfBacktestOverfitting([s, s], 22), StatisticsError);
});

test('bloque del bootstrap: el mayor de ⌈T^(1/3)⌉ y la duración media de una operación', () => {
  assert.equal(meanBlockLength(1000, null), 10);
  assert.equal(meanBlockLength(1000, 23.2), 24);
  assert.equal(meanBlockLength(1001, 2), 11);
});

test('bootstrap estacionario: índices válidos, deterministas por semilla y bloques contiguos', () => {
  const a = stationaryBootstrapIndices(500, 20, seededRng(7, 'bootstrap'));
  const b = stationaryBootstrapIndices(500, 20, seededRng(7, 'bootstrap'));
  assert.deepEqual(a, b);
  assert.ok(a.every((i) => i >= 0 && i < 500));
  let continues = 0;
  for (let t = 1; t < a.length; t++) if (a[t] === ((a[t - 1] ?? 0) + 1) % 500) continues++;
  // Con L = 20 se sigue el bloque con probabilidad 0,95 (más los saltos que caen justo en el siguiente).
  near(continues / 499, 0.95, 0.03);
  const long = stationaryBootstrapIndices(50, 1e12, seededRng(1, 'x'));
  for (let t = 1; t < long.length; t++) assert.equal(long[t], ((long[t - 1] ?? 0) + 1) % 50, 'sin reinicios, una sola vuelta');
});

test('IC del bootstrap: la media de una serie con media conocida y la serie constante', () => {
  const rng = seededRng(42, 'serie');
  // Normal por Box-Muller con media 0,001 y desviación 0,01.
  const series = Array.from({ length: 2000 }, () => 0.001 + 0.01 * Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next()));
  const mean = (idx: Int32Array): number => idx.reduce((s, i) => s + (series[i] ?? 0), 0) / idx.length;
  const ci = bootstrapInterval(series.length, mean, { resamples: 4000, meanBlock: 13, rng: seededRng(42, 'bootstrap') });
  assert.ok(ci !== null);
  assert.ok(ci.lower < 0.001 && ci.upper > 0.001, `[${String(ci.lower)}, ${String(ci.upper)}]`);
  // Ancho teórico con independencia: 2·1,96·0,01/√2000 ≈ 0,000877.
  near(ci.upper - ci.lower, 0.000877, 0.0003);
  assert.equal(ci.resamples, 4000);
  const flat = bootstrapInterval(100, () => 0.5, { resamples: 50, meanBlock: 5, rng: seededRng(1, 'b') });
  assert.deepEqual([flat?.lower, flat?.upper], [0.5, 0.5]);
  const undefinedStat = bootstrapInterval(100, () => null, { resamples: 10, meanBlock: 5, rng: seededRng(1, 'b') });
  assert.equal(undefinedStat, null, 'sin ningún estadístico definido no hay IC');
});

// Autocorrelación (ADR 0038): la varianza del Sharpe estimado es la varianza a largo plazo de su función de influencia.
/** AR(1) gaussiano de media 0 con coeficiente rho, con una semilla: su varianza a largo plazo es (1 + rho)/(1 − rho). */
function ar1(rho: number, periods: number, seed: number): number[] {
  const rng = seededRng(seed, 'ar1');
  const out: number[] = [];
  let x = 0;
  for (let t = 0; t < periods; t++) {
    const e = Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
    x = rho * x + Math.sqrt(1 - rho * rho) * e;
    out.push(x);
  }
  return out;
}

test('varianza a largo plazo del Sharpe: sin retardos, la de rentabilidades independientes; con AR(1), la de la teoría', () => {
  const series = ar1(0.5, 20_000, 38);
  const m = moments(series);
  const sharpe = m.mean / m.std;
  const independent = 1 - (m.skewness ?? 0) * sharpe + (((m.kurtosis ?? 3) - 1) / 4) * sharpe * sharpe;
  near(sharpeLongRunVariance(series, 0), independent, 1e-12);
  // Con 50 retardos y pesos de Bartlett, cerca de (1 + 0,5)/(1 − 0,5) = 3, un poco por debajo por los pesos.
  const corrected = sharpeLongRunVariance(series, 50);
  assert.ok(corrected > 2.6 && corrected < 3.2, String(corrected));
});

test('con autocorrelación negativa no baja de la de rentabilidades independientes: corregir no facilita pasar', () => {
  const series = ar1(-0.5, 5000, 39);
  near(sharpeLongRunVariance(series, 20), sharpeLongRunVariance(series, 0), 1e-12);
  assert.throws(() => sharpeLongRunVariance(series, -1), StatisticsError);
  assert.throws(() => sharpeLongRunVariance([1, 1, 1], 2), StatisticsError);
});

test('PSR, MinTRL e IC usan la varianza que se les da', () => {
  near(probabilisticSharpe({ sharpe: 0.1, periods: 101, skewness: 0, kurtosis: 3, varianceFactor: 4 }, 0), normalCdf(0.5), 1e-15);
  near(minTrackRecordLength({ sharpe: 0.1, skewness: 0, kurtosis: 3, varianceFactor: 4 }), 1 + 4 * (1.6448536269514722 / 0.1) ** 2, 1e-9);
  const ic = sharpeInterval(0.1, 101, 1);
  near(ic.lower, 0.1 - 1.959963984540054 * 0.1, 1e-12);
  near(ic.upper, 0.1 + 1.959963984540054 * 0.1, 1e-12);
  assert.throws(() => sharpeInterval(0.1, 101, 0), StatisticsError);
});

test('V[SRₙ] con autocorrelación positiva: crece como la varianza a largo plazo de las rentabilidades', () => {
  const series = ar1(0.5, 20_000, 40);
  const v = nullSharpeVariance(series, 50) * (series.length - 1);
  assert.ok(v > 2.6 && v < 3.2, String(v)); // (1 + 0,5)/(1 − 0,5) = 3, algo menos por los pesos de Bartlett
});
