// Ventanas de crisis, episodios bajistas y regímenes de los criterios congelados (paso 27B, ADR 0031), con periodos
// sintéticos de resultado conocido: cobertura por los tramos de validación, rentabilidad y caída dentro de cada ventana,
// asignación de cada periodo por su punto medio y rentabilidad en los periodos alcistas y laterales de BTC. Y el
// benchmark de A.3.9 con la exposición de la estrategia (ADR 0042).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { periodInstant, type PeriodRecord } from '../../../src/analytics/breakdown.ts';
import { AnalyticsError } from '../../../src/analytics/performance.ts';
import {
  BEAR_EPISODES, benchmarkExposure, coverage, CRISIS_WINDOWS, regimeMeasures, regimeReturns, scaledBenchmark, windowResult,
} from '../../../src/analytics/windows.ts';
import type { RegimeView } from '../../../src/kernel/regime.ts';
import { parseUtcIso, toUtcIso } from '../../../src/shared/time.ts';

const DAY = 86_400_000;
const LATENCY = 60_000;

function near(actual: number | null, expected: number, tolerance = 1e-12): void {
  assert.ok(actual !== null, `se esperaba ${String(expected)} y es null`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${String(actual)} ≠ ${String(expected)}`);
}

/** Periodos diarios desde `from`: cada uno termina al recibir la vela (cierre + latencia), como las marcas de la curva. */
function daily(from: string, returns: readonly number[], bench: (k: number) => number = () => 0, exposure: (k: number) => number = () => 0.1): PeriodRecord[] {
  const t0 = parseUtcIso(from);
  return returns.map((ret, k) => ({
    start: k === 0 ? t0 : t0 + k * DAY - 1 + LATENCY,
    end: t0 + (k + 1) * DAY - 1 + LATENCY,
    ret,
    benchmark: bench(k),
    inMarket: true,
    exposure: exposure(k),
  }));
}

test('las ventanas de crisis y los episodios bajistas son los de A.3.7 y A.3.9, con el extremo final incluido', () => {
  assert.deepEqual(
    CRISIS_WINDOWS.map((w) => [w.id, toUtcIso(w.from), toUtcIso(w.to)]),
    [
      ['2018-01-01/2018-12-31', '2018-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z'],
      ['2020-03-01/2020-04-30', '2020-03-01T00:00:00.000Z', '2020-05-01T00:00:00.000Z'],
      ['2021-05-01/2021-07-31', '2021-05-01T00:00:00.000Z', '2021-08-01T00:00:00.000Z'],
      ['2022-01-01/2022-12-31', '2022-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z'],
    ],
  );
  assert.deepEqual(BEAR_EPISODES.map((w) => [toUtcIso(w.from), toUtcIso(w.to)]), [
    ['2018-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z'],
    ['2022-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z'],
  ]);
});

test('cobertura: dentro solo si los tramos de validación cubren la ventana entera, sin huecos', () => {
  const [w2018] = BEAR_EPISODES;
  assert.ok(w2018 !== undefined);
  const y = (year: number): number => Date.UTC(year, 0, 1);
  assert.equal(coverage(w2018, [{ from: y(2017), to: y(2018) }, { from: y(2018), to: y(2019) }]), 'dentro');
  assert.equal(coverage(w2018, [{ from: y(2016), to: y(2020) }]), 'dentro');
  assert.equal(coverage(w2018, [{ from: Date.UTC(2018, 3, 1), to: y(2019) }]), 'parcial', 'empieza en abril');
  assert.equal(coverage(w2018, [{ from: y(2018), to: Date.UTC(2018, 5, 1) }, { from: Date.UTC(2018, 6, 1), to: y(2019) }]), 'parcial', 'hueco en junio');
  assert.equal(coverage(w2018, [{ from: y(2019), to: y(2020) }]), 'fuera');
});

test('cada periodo cuenta en la fecha de su punto medio: el de la vela del 31 de diciembre es de ese año aunque se reciba el 1 de enero', () => {
  const [last] = daily('2018-12-31T00:00:00Z', [0]).slice(-1);
  assert.ok(last !== undefined);
  assert.equal(toUtcIso(last.end).slice(0, 10), '2019-01-01');
  assert.equal(toUtcIso(periodInstant(last)).slice(0, 10), '2018-12-31');
});

test('ventana: rentabilidad compuesta, la de BTC en los mismos periodos y la caída máxima de la estrategia dentro', () => {
  const [w2018] = BEAR_EPISODES;
  assert.ok(w2018 !== undefined);
  // 2017-12-31 (fuera), 365 días de 2018 y 2019-01-01 (fuera). En 2018: +10 %, −20 %, +5 % y el resto planos.
  const rets = [0.5, 0.1, -0.2, 0.05, ...new Array<number>(362).fill(0), 0.5];
  const records = daily('2017-12-31T00:00:00Z', rets, (k) => (k >= 1 && k <= 365 ? -0.001 : 0.3));
  const folds = [{ from: Date.UTC(2017, 0, 1), to: Date.UTC(2020, 0, 1) }];
  const r = windowResult(w2018, records, folds);
  assert.equal(r.coverage, 'dentro');
  assert.equal(r.periods, 365);
  near(r.strategyReturn, 1.1 * 0.8 * 1.05 - 1);
  near(r.benchmarkReturn, 0.999 ** 365 - 1, 1e-12);
  near(r.maxDrawdown, 0.2);
  const partial = windowResult(w2018, records, [{ from: Date.UTC(2018, 5, 1), to: Date.UTC(2020, 0, 1) }]);
  assert.deepEqual([partial.coverage, partial.strategyReturn, partial.maxDrawdown], ['parcial', null, null], 'sin la ventana entera no se mide');
});

test('regímenes: rentabilidad en los periodos ALCISTA y LATERAL de BTC según la etiqueta conocida al empezar cada periodo', () => {
  const records = daily('2020-01-01T00:00:00Z', [0.01, 0.02, -0.01, 0.03], (k) => [0.02, 0.01, 0.0, -0.01][k] ?? 0);
  const view = (day: number, trend: RegimeView['trend']): RegimeView => ({
    scope: 'BTC/EUR', timeframe: '1d', asOf: Date.UTC(2020, 0, 1) + day * DAY - 1 + LATENCY, volatility: 'NORMAL', trend, classifierId: 'regimen-precio@1',
  });
  // La etiqueta del periodo k es la de la última vela recibida antes de empezar: la del día k − 1. El primero, sin etiqueta.
  const regimes = [view(1, 'ALCISTA'), view(2, 'LATERAL'), view(3, 'ALCISTA')];
  const bull = regimeReturns(records, regimes, 'ALCISTA', 365);
  assert.equal(bull.periods, 2); // periodos 1 y 3
  near(bull.strategyReturn, 1.02 * 1.03 - 1);
  near(bull.benchmarkReturn, 1.01 * 0.99 - 1);
  const lateral = regimeReturns(records, regimes, 'LATERAL', 365);
  assert.equal(lateral.periods, 1);
  near(lateral.strategyAnnualized, 0.99 ** 365 - 1, 1e-12);
  assert.deepEqual(regimeReturns(records, [], 'ALCISTA', 365), { periods: 0, strategyReturn: null, benchmarkReturn: null, strategyAnnualized: null });
});

test('exposición del benchmark de A.3.9: media ponderada por la exposición; los periodos sin posición no pesan, y una muy pequeña casi nada', () => {
  near(benchmarkExposure([0, 0.1, 0.1, 0]), 0.1);
  // Una posición diminuta el doble de tiempo que la normal apenas mueve la media; la simple de los periodos con algo
  // dentro la dejaría en un tercio. El polvo ni siquiera llega: la exposición de cada periodo ya va sin él.
  near(benchmarkExposure([0.1, 0.1, 0.0005, 0.0005, 0.0005, 0.0005]), (2 * 0.01 + 4 * 0.0005 ** 2) / (2 * 0.1 + 4 * 0.0005));
  assert.ok((benchmarkExposure([0.1, 0.1, 0.0005, 0.0005, 0.0005, 0.0005]) ?? 0) > 0.099);
  near(benchmarkExposure([0.1, 0.2]), (0.01 + 0.04) / 0.3);
  assert.equal(benchmarkExposure([0, 0]), null, 'nunca tiene posición');
  assert.equal(benchmarkExposure([]), null);
  assert.throws(() => benchmarkExposure([Number.NaN]), AnalyticsError);
});

test('BTC con la exposición de la estrategia: en cada periodo, esa fracción de la rentabilidad del buy-and-hold de todo el capital', () => {
  const t0 = parseUtcIso('2018-01-01T00:00:00Z');
  const record = (k: number, benchmark: number, ret = 0.01): PeriodRecord => ({ start: t0 + k * DAY, end: t0 + (k + 1) * DAY, ret, benchmark, inMarket: true, exposure: 0.1 });
  // Un buy-and-hold que sube un 100 % en dos periodos y vuelve a caer: con el 25 % siempre en BTC, cada periodo es la
  // cuarta parte. Si comprara el 25 % al empezar y no lo tocara, llegaría al 40 % tras el segundo periodo.
  const records = [record(0, 0.5), record(1, 1 / 3), record(2, -0.5)];
  const scaled = scaledBenchmark(records, 0.25);
  assert.deepEqual(scaled.map((r) => r.benchmark), [0.125, 1 / 12, -0.125]);
  assert.deepEqual(scaled.map((r) => [r.start, r.end, r.ret, r.inMarket]), records.map((r) => [r.start, r.end, r.ret, r.inMarket]), 'la estrategia no cambia');
  assert.deepEqual(scaledBenchmark(records, 1), records);
  assert.throws(() => scaledBenchmark(records, 0), AnalyticsError);
  assert.throws(() => scaledBenchmark(records, 1.5), AnalyticsError);
});

test('lo que mide A.3.9: el bajista y el alcista frente al benchmark con la exposición; sin exposición, frente a todo el capital', () => {
  const records = daily('2018-01-01T00:00:00Z', new Array<number>(365).fill(0), () => -0.002);
  const input = { regimes: [], folds: [{ from: Date.UTC(2018, 0, 1), to: Date.UTC(2019, 0, 1) }], perYear: 365 };
  const scaled = regimeMeasures({ ...input, records });
  const [bear2018] = scaled.bearEpisodes;
  near(scaled.regimeExposure, 0.1);
  assert.deepEqual([bear2018?.coverage, bear2018?.periods, bear2018?.strategyReturn], ['dentro', 365, 0]);
  near(bear2018?.benchmarkReturn ?? null, 0.9998 ** 365 - 1, 1e-12);
  assert.equal(scaled.bull.periods, 0, 'sin etiquetas no hay alcista');
  const full = regimeMeasures({ ...input, records: records.map((r) => ({ ...r, exposure: 0 })) });
  assert.equal(full.regimeExposure, null);
  near(full.bearEpisodes[0]?.benchmarkReturn ?? null, 0.998 ** 365 - 1, 1e-12);
  assert.deepEqual(full.own, { bull: null, bear: [null, null] }, 'sin ninguna posición tampoco hay condición por régimen');
});

test('condición por régimen de A.3.9: el alcista y cada bajista, también frente a BTC con la exposición que la estrategia tuvo en ellos', () => {
  // 2018 bajista con posiciones del 5 %; 2019 alcista con posiciones del 20 %. La exposición de toda la serie las mezcla.
  const bear = daily('2018-01-01T00:00:00Z', new Array<number>(365).fill(-0.0001), () => -0.002, () => 0.05);
  const bull = daily('2019-01-01T00:00:00Z', new Array<number>(365).fill(0.0004), () => 0.002, () => 0.2);
  const records = [...bear, ...bull];
  const view = (asOf: number, trend: RegimeView['trend']): RegimeView => ({ scope: 'BTC/EUR', timeframe: '1d', asOf, volatility: 'NORMAL', trend, classifierId: 'regimen-precio@1' });
  // Etiqueta ALCISTA desde el 1 de enero de 2019: vale para los periodos de 2019 (empiezan después).
  const regimes = [view(Date.UTC(2018, 0, 1), 'BAJISTA'), view(Date.UTC(2019, 0, 1) - 1, 'ALCISTA')];
  const m = regimeMeasures({ records, regimes, folds: [{ from: Date.UTC(2018, 0, 1), to: Date.UTC(2020, 0, 1) }], perYear: 365 });
  near(m.regimeExposure, (365 * 0.05 ** 2 + 365 * 0.2 ** 2) / (365 * 0.05 + 365 * 0.2));
  // El bajista se compara también con BTC al 5 % y el alcista con BTC al 20 %, cada uno con su tamaño.
  near(m.own.bear[0]?.exposure ?? null, 0.05);
  near(m.own.bear[0]?.result.benchmarkReturn ?? null, (1 - 0.05 * 0.002) ** 365 - 1, 1e-12);
  near(m.bearEpisodes[0]?.benchmarkReturn ?? null, (1 - (m.regimeExposure ?? 0) * 0.002) ** 365 - 1, 1e-12);
  assert.equal(m.own.bear[1], null, 'sin posición en 2022, la condición no añade nada');
  near(m.own.bull?.exposure ?? null, 0.2);
  assert.equal(m.own.bull?.result.periods, 365);
  near(m.own.bull?.result.benchmarkReturn ?? null, (1 + 0.2 * 0.002) ** 365 - 1, 1e-12);
  // Con la exposición de toda la serie (0,17) el alcista frente a BTC parece más fácil que con la suya (0,20).
  assert.ok((m.bull.benchmarkReturn ?? 0) < (m.own.bull?.result.benchmarkReturn ?? 0));
});
