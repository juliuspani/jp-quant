// Robustez de los criterios congelados (paso 27B, ADR 0031) con datos de resultado conocido: variantes ±25 % y ±50 %,
// cifras significativas, estabilidad del parámetro elegido en train, serie sin el mejor año, mejor activo y PBO entre
// configuraciones alineadas por fecha.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetGroup, PeriodRecord } from '../../../src/analytics/breakdown.ts';
import { AnalyticsError, sharpeOf } from '../../../src/analytics/performance.ts';
import {
  bestAsset, numericParams, parameterVariants, pboAcross, perturbed, significantDigits, sweepStability, withoutBestYear, type ConfigurationSeries,
} from '../../../src/analytics/robustness.ts';
import { seededRng } from '../../../src/kernel/random.ts';

const DAY = 86_400_000;

test('variantes de sensibilidad: cada parámetro numérico de uno en uno a −50, −25, +25 y +50 %; los enteros, redondeados hacia fuera', () => {
  const variants = parameterVariants({ entryPeriod: 55, stopAtr: 2, salida: 'canal' }, new Set(['entryPeriod']));
  assert.deepEqual(
    variants.map((v) => [v.param, v.step, v.values['entryPeriod'], v.values['stopAtr'], v.values['salida']]),
    [
      ['entryPeriod', -0.5, 27, 2, 'canal'],
      ['entryPeriod', -0.25, 41, 2, 'canal'],
      ['entryPeriod', 0.25, 69, 2, 'canal'],
      ['entryPeriod', 0.5, 83, 2, 'canal'],
      ['stopAtr', -0.5, 55, 1, 'canal'],
      ['stopAtr', -0.25, 55, 1.5, 'canal'],
      ['stopAtr', 0.25, 55, 2.5, 'canal'],
      ['stopAtr', 0.5, 55, 3, 'canal'],
    ],
  );
  assert.deepEqual(numericParams({ entryPeriod: 55, stopAtr: 2, salida: 'canal' }), ['entryPeriod', 'stopAtr']);
  // RSI de 2: hacia fuera, nunca el mismo valor tras redondear.
  assert.deepEqual(parameterVariants({ rsiPeriod: 2 }, new Set(['rsiPeriod'])).map((v) => v.values['rsiPeriod']), [1, 1, 3, 3]);
  assert.throws(() => parameterVariants({ n: 2.5 }, new Set(['n'])), AnalyticsError);
});

test('paso 28: una variante se aplica igual a los parámetros elegidos en cada tramo de un barrido', () => {
  const integers = new Set(['entryPeriod', 'exitPeriod']);
  const chosen = [{ entryPeriod: 20, exitPeriod: 10, stopAtr: 2 }, { entryPeriod: 55, exitPeriod: 20, stopAtr: 2 }];
  assert.deepEqual(chosen.map((v) => perturbed(v, 'entryPeriod', -0.25, integers)['entryPeriod']), [15, 41]);
  assert.deepEqual(chosen.map((v) => perturbed(v, 'stopAtr', 0.25, integers)['stopAtr']), [2.5, 2.5]);
  // Las mismas que parameterVariants para unos valores dados.
  for (const v of parameterVariants(chosen[1] ?? {}, integers)) assert.deepEqual(perturbed(chosen[1] ?? {}, v.param, v.step, integers), v.values);
  assert.throws(() => perturbed({ salida: 'canal' }, 'salida', 0.5, integers), AnalyticsError, 'una elección discreta no tiene variantes');
});

test('cifras significativas tal como se escribe el valor (más de 3 indica sobreajuste)', () => {
  for (const [value, digits] of [[55, 2], [20, 1], [1000, 1], [2, 1], [2.5, 2], [0.05, 1], [10.5, 3], [0.0025, 2], [1234, 4], [1.2345, 5], [-3.75, 3], [1e-7, 1], [0, 1]] as const) {
    assert.equal(significantDigits(value), digits, String(value));
  }
});

test('estabilidad del barrido: fracción de cambios de tramo en que el elegido se mueve como mucho un punto de la rejilla', () => {
  assert.equal(sweepStability([10, 20, 20, 40], [10, 20, 30, 40]), 2 / 3);
  assert.equal(sweepStability([10, 40], [10, 20, 30, 40]), 0);
  assert.equal(sweepStability([30], [10, 20, 30]), null);
  assert.throws(() => sweepStability([10, 15], [10, 20]), AnalyticsError);
});

function record(day: number, ret: number): PeriodRecord {
  const start = Date.UTC(2019, 0, 1) + day * DAY;
  return { start, end: start + DAY, ret, benchmark: 0, inMarket: true, exposure: 0.1 };
}

test('sin el mejor año: se quitan los periodos del año con más rentabilidad compuesta y se recalcula el Sharpe', () => {
  const rng = seededRng(3, 'años');
  // 2019 y 2021 ruidosos con media negativa; 2020 (366 días) con media muy positiva: es el mejor año.
  const rets = Array.from({ length: 365 + 366 + 365 }, (_, d) => (d >= 365 && d < 731 ? 0.01 : -0.001) + 0.002 * (rng.next() - 0.5));
  const records = rets.map((r, d) => record(d, r));
  const result = withoutBestYear(records, 365);
  assert.equal(result.bestYear, '2020');
  assert.equal(result.years, 3);
  const rest = rets.filter((_, d) => d < 365 || d >= 731);
  assert.equal(result.sharpeAnnualized, (sharpeOf(rest).sharpe ?? 0) * Math.sqrt(365));
  assert.ok((result.sharpeAnnualized ?? 0) < 0, 'sin 2020 la serie pierde');
  assert.deepEqual(withoutBestYear(records.slice(0, 100), 365), { bestYear: null, years: 1, sharpeAnnualized: null });
});

test('mejor activo: el de más P&L neto cerrado; sin operaciones cerradas, ninguno', () => {
  const group = (closed: number, netPnl: number): AssetGroup => ({
    closed, open: 0, netPnl, hitRate: null, profitFactor: null, expectancy: null, turnover: 0, feesPaid: 0, implicitCosts: 0,
  });
  assert.equal(bestAsset({ 'BTC/EUR': group(3, 50), 'ETH/EUR': group(2, 80), 'SOL/EUR': group(0, 0) }), 'ETH/EUR');
  assert.equal(bestAsset({ 'BTC/EUR': group(0, 0) }), null);
});

function series(id: string, family: string, returns: readonly number[], offset = 0): ConfigurationSeries {
  return { id, family, times: returns.map((_, k) => (k + offset) * DAY), returns };
}

test('PBO entre configuraciones: se alinean por fecha; la que domina en cada periodo da 0, y la que se invierte fuera de muestra da 1', () => {
  const rng = seededRng(11, 'pbo');
  const noise = Array.from({ length: 320 }, () => 0.02 * (rng.next() - 0.5));
  const dominant = pboAcross([series('a', 'f', noise.map((r) => r + 0.001)), series('b', 'f', noise)]);
  assert.ok(dominant.measured);
  assert.equal(dominant.result.pbo, 0);
  assert.equal(dominant.result.combinations, 12_870);
  // Con ruido puro el PBO de una realización va de casi 0 a casi 1 (las combinaciones comparten bloques): no sirve de
  // prueba. Una serie de media exactamente cero y su espejo: la mejor dentro de muestra es siempre la peor fuera.
  const mean = noise.reduce((a, b) => a + b, 0) / noise.length;
  const centred = noise.map((r) => r - mean);
  const mirrored = pboAcross([series('a', 'f', centred), series('b', 'f', centred.map((r) => -r))]);
  assert.ok(mirrored.measured);
  assert.equal(mirrored.result.pbo, 1);
  // Solo los instantes comunes: la segunda empieza 10 periodos después.
  const shifted = pboAcross([series('a', 'f', noise.map((r) => r + 0.001)), series('b', 'g', noise.slice(10), 10)]);
  assert.ok(shifted.measured);
  assert.equal(shifted.periods, 310);
});

test('PBO: con menos de dos configuraciones o sin periodos comunes suficientes no se mide', () => {
  const one = pboAcross([series('a', 'f', new Array<number>(64).fill(0.01))]);
  assert.deepEqual([one.measured, one.measured ? null : one.configurations], [false, 1]);
  const short = pboAcross([series('a', 'f', new Array<number>(20).fill(0.01)), series('b', 'f', new Array<number>(20).fill(0.02))]);
  assert.equal(short.measured, false);
  assert.throws(() => pboAcross([series('a', 'f', [0.1]), series('a', 'g', [0.2])]), AnalyticsError, 'id repetido');
});
