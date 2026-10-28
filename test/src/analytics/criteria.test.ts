// Evaluador de los criterios congelados (paso 27B, ADR 0031): una prueba por criterio de A.3, con evidencia sintética de
// resultado conocido. Parte de una evidencia que lo pasa todo y cambia una sola medida para ver el FAIL y el
// NO CONCLUYENTE de cada criterio. Comprueba también el veredicto: un FAIL basta para RECHAZADA y lo que no se mide nunca
// da PASS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  controlUsable, evaluateCriteria, FAMILY_PROFILES, FROZEN_DOCUMENTS, WORST_CASE_INTRABAR, type ControlMethod, type ControlResult, type CriteriaEvidence,
  type CriterionResult, type CriterionStatus,
} from '../../../src/analytics/criteria.ts';
import type { DeflatedSharpeReport } from '../../../src/analytics/report.ts';
import type { PboOutcome } from '../../../src/analytics/robustness.ts';
import type { WindowResult } from '../../../src/analytics/windows.ts';

const dsr = (value: number, trials: number, meets = true): DeflatedSharpeReport => ({
  trials, sharpe: 0.1, periods: 3000, skewness: 0, kurtosis: 3, varianceFactor: 1.2, lag: 15, trialVariance: 0.001, sr0: 0.05, dsr: value, psr: 0.99,
  minTrackRecord: 500, meetsMinTrackRecord: meets,
});
const ci = (lower: number, upper: number) => ({ lower, upper, level: 0.95, resamples: 10_000, discarded: 0 });
const win = (id: string, strategyReturn: number, benchmarkReturn: number, maxDrawdown: number, coverage: WindowResult['coverage'] = 'dentro'): WindowResult => ({
  id, coverage, periods: 365, strategyReturn, benchmarkReturn, maxDrawdown,
});
const pboOk: PboOutcome = { measured: true, result: { pbo: 0.1, combinations: 12_870, blocks: 16, configurations: 4 }, periods: 3000 };
const ok = <T>(value: T) => ({ ok: true as const, value });
const missing = (reason: string) => ({ ok: false as const, reason });

/** Control aleatorio con el simulador y una réplica a un 5 % del Sharpe real (1,2). */
const control = (change: Partial<ControlResult> = {}): ControlResult => ({
  method: 'simulador', simulations: 1000, p95: 0.9, median: 0.3, percentile: 0.99, replica: 1.14, deviation: 0.05, simulatorP95: null, ...change,
});
const shift = (change: Partial<{ method: ControlMethod; deviation: number | null; median: number; p95: number }> = {}) => ({
  method: 'simulador' as ControlMethod, deviation: 0.05, median: 0.1, p95: 0.9, ...change,
});
const walk = (change: Partial<{ method: ControlMethod; deviation: number | null; replica: number | null; sharpe: number | null; p95: number }> = {}) => ({
  method: 'simulador' as ControlMethod, deviation: 0.08, replica: 0.2, sharpe: 0.2, p95: 0.8, ...change,
});

/** Evidencia de una estrategia de tendencia que pasa todo lo que se mide. */
function passing(): CriteriaEvidence {
  return {
    family: 'tendencia-donchian-atr',
    sharpe: 1.2,
    netPnl: 900,
    calmar: 2,
    foldSharpes: [0.8, 1.5, -0.2, 1.1],
    maxDrawdown: 0.08,
    bootstrap: { sharpe: ci(0.3, 2), maxDrawdown: ci(0.05, 0.15), excessSharpe: ci(-0.5, 1) },
    intervalLongRun: { lower: 0.25, upper: 2.1, lag: 15 },
    closedTrades: 140,
    dsrFamily: dsr(0.97, 49),
    dsrGlobal: ok(dsr(0.96, 65)),
    // Frente a BTC con la exposición de la estrategia (10 %): un −70 % de BTC es un −7 % del benchmark (ADR 0042).
    bearEpisodes: [win('2018', -0.02, -0.07, 0.09), win('2022', -0.01, -0.06, 0.08)],
    crisisWindows: [win('2018-01-01/2018-12-31', -0.02, -0.7, 0.09), win('2020-03-01/2020-04-30', 0.01, -0.1, 0.03)],
    bull: { periods: 900, strategyReturn: 0.3, benchmarkReturn: 0.45, strategyAnnualized: 0.11 },
    lateral: { periods: 600, strategyReturn: -0.03, benchmarkReturn: 0.1, strategyAnnualized: -0.02 },
    regimeExposure: 0.1,
    // La condición por régimen: frente a BTC con la exposición que tuvo en el alcista (15 %) y en cada bajista (14 %).
    regimeOwn: {
      bull: { exposure: 0.15, result: { periods: 900, strategyReturn: 0.3, benchmarkReturn: 0.5, strategyAnnualized: 0.11 } },
      bear: [{ exposure: 0.14, result: win('2018', -0.02, -0.1, 0.09) }, { exposure: 0.14, result: win('2022', -0.01, -0.08, 0.08) }],
    },
    costs2: ok({ sharpe: 0.9, netPnl: 600 }),
    costs3: ok({ sharpe: 0.6, netPnl: 300 }),
    delay: ok({ sharpe: 0.7, netPnl: 500 }),
    intrabarPolicy: WORST_CASE_INTRABAR,
    params: { entryPeriod: 55, exitPeriod: 20, stopAtr: 2 },
    sensitivity: ok([
      { param: 'entryPeriod', step: -0.5, sharpe: ok(0.7) },
      { param: 'entryPeriod', step: 0.5, sharpe: ok(1.4) },
      { param: 'stopAtr', step: -0.25, sharpe: ok(1.0) },
    ]),
    sweep: null,
    benchmarks: { btc: { sharpe: 0.9, calmar: 0.8 }, universe: ok({ sharpe: 0.8, calmar: 0.7 }) },
    randomControl: ok(control()),
    ablation: ok([{ component: 'salida-canal', sharpe: ok(0.4), excess: ok(0.2), exposure: { timeInMarket: 0.6, meanExposure: 0.1 } }]),
    alternativeUniverse: ok({ symbols: 'SOL/EUR, ADA/EUR', sharpe: 0.3 }),
    withoutBestYear: { bestYear: '2020', years: 9, sharpeAnnualized: 0.6 },
    withoutBestAsset: ok({ asset: 'ETH/EUR', sharpe: 0.5 }),
    pbo: { family: pboOk, global: pboOk },
    smoke: { shifted: ok(shift()), randomWalk: ok(walk()) },
  };
}

function criterion(e: CriteriaEvidence, id: string): CriterionResult {
  const found = evaluateCriteria(e).criteria.find((c) => c.id === id);
  assert.ok(found !== undefined, `falta ${id}`);
  return found;
}

function expect(id: string, cases: readonly (readonly [CriterionStatus, Partial<CriteriaEvidence>])[]): void {
  assert.equal(criterion(passing(), id).status, 'PASS', `${id} debería pasar con la evidencia base`);
  for (const [status, change] of cases) assert.equal(criterion({ ...passing(), ...change }, id).status, status, `${id}: ${JSON.stringify(change)}`);
}

test('el informe recorre A.3.1 a A.3.15 en orden, con la huella de los documentos congelados y lo que no se evalúa', () => {
  const report = evaluateCriteria(passing());
  assert.deepEqual(report.criteria.map((c) => c.id), Array.from({ length: 15 }, (_, i) => `A.3.${String(i + 1)}`));
  assert.deepEqual(report.documents.map((d) => d.path), ['docs/PROMOTION_CRITERIA.md', 'docs/PRE_LIVE_GATE.md']);
  assert.equal(report.documents, FROZEN_DOCUMENTS);
  assert.ok(report.notEvaluated.some((n) => n.includes('A.5 y A.6')) && report.notEvaluated.some((n) => n.includes('PRE-LIVE GATE')));
  for (const c of report.criteria) assert.ok(c.threshold.length > 0, `${c.id} sin umbral`);
});

test('veredicto: todo en PASS da CANDIDATA A TEST FINAL; uno sin medir, NO CONCLUYENTE; un solo FAIL basta para RECHAZADA', () => {
  const report = evaluateCriteria(passing());
  assert.deepEqual(report.criteria.filter((c) => c.status !== 'PASS').map((c) => c.id), []);
  assert.equal(report.verdict, 'CANDIDATA A TEST FINAL');
  assert.equal(evaluateCriteria({ ...passing(), alternativeUniverse: missing('sin universo alternativo') }).verdict, 'NO CONCLUYENTE');
  assert.equal(evaluateCriteria({ ...passing(), maxDrawdown: 0.11 }).verdict, 'RECHAZADA');
  assert.equal(evaluateCriteria({ ...passing(), maxDrawdown: 0.11, randomControl: missing('x') }).verdict, 'RECHAZADA', 'el FAIL manda sobre lo que falta');
});

test('A.3.1: ≥ 3 tramos, Sharpe concatenado > 0 y positivo en al menos la mitad de los tramos', () => {
  expect('A.3.1', [
    ['FAIL', { foldSharpes: [1, 1] }],
    ['FAIL', { sharpe: -0.1 }],
    ['FAIL', { foldSharpes: [1, -1, -1, null] }],
    ['NO CONCLUYENTE', { sharpe: null }],
  ]);
  assert.equal(criterion({ ...passing(), foldSharpes: [1, 1, -1, -1] }, 'A.3.1').status, 'PASS', 'la mitad justa vale');
});

test('A.3.2: DSR ≥ 0,95 con la N de la familia y con la N global', () => {
  expect('A.3.2', [
    ['FAIL', { dsrFamily: dsr(0.94, 49) }],
    ['FAIL', { dsrGlobal: ok(dsr(0.5, 65)) }],
    ['NO CONCLUYENTE', { dsrGlobal: missing('el DSR global se calcula en la decisión') }],
  ]);
  assert.deepEqual(criterion(passing(), 'A.3.2').value, { dsr_familia: 0.97, n_familia: 49, dsr_global: 0.96, n_global: 65 });
});

test('A.3.3: con costes ×2, Sharpe y P&L neto > 0; ×3 solo se informa', () => {
  expect('A.3.3', [
    ['FAIL', { costs2: ok({ sharpe: -0.1, netPnl: 10 }) }],
    ['FAIL', { costs2: ok({ sharpe: 0.1, netPnl: -10 }) }],
    ['PASS', { costs3: ok({ sharpe: -1, netPnl: -100 }) }],
    ['NO CONCLUYENTE', { costs2: missing('falló la ejecución') }],
  ]);
});

test('A.3.4: caída máxima ≤ 10 % y límite superior de su IC ≤ 20 %', () => {
  expect('A.3.4', [
    ['FAIL', { maxDrawdown: 0.1000001 }],
    ['FAIL', { bootstrap: { ...passing().bootstrap, maxDrawdown: ci(0.05, 0.21) } }],
    ['NO CONCLUYENTE', { bootstrap: { ...passing().bootstrap, maxDrawdown: null } }],
  ]);
  assert.equal(criterion({ ...passing(), maxDrawdown: 0.1 }, 'A.3.4').status, 'PASS', 'el 10 % justo vale');
});

test('A.3.5: medido y sin llegar (operaciones, MinTRL) es FAIL; sin un bajista completo fuera de muestra no se mide', () => {
  expect('A.3.5', [
    ['FAIL', { closedTrades: 99 }],
    ['FAIL', { dsrFamily: dsr(0.97, 49, false) }],
    ['NO CONCLUYENTE', { bearEpisodes: [win('2018', -0.2, -0.7, 0.09, 'parcial'), win('2022', -0.1, -0.6, 0.08, 'fuera')] }],
    ['NO CONCLUYENTE', { dsrFamily: null }],
    ['FAIL', { closedTrades: 40, bearEpisodes: [win('2018', -0.2, -0.7, 0.09, 'fuera')] }],
  ]);
});

// Texto congelado de A.3.6 (auditoría Q-06): decide la matriz de toda la ronda; el PBO de la familia se informa y no decide.
// Con menos de 3 configuraciones, el PBO se informa y no decide (ADR 0041).
test('A.3.6: PBO < 0,20 con todas las configuraciones de la ronda; el de la familia no decide; con menos de 3, NO CONCLUYENTE', () => {
  const high: PboOutcome = { measured: true, result: { pbo: 0.2, combinations: 12_870, blocks: 16, configurations: 4 }, periods: 3000 };
  const single: PboOutcome = { measured: false, configurations: 1, reason: 'menos de dos configuraciones con serie de rendimientos' };
  const pending: PboOutcome = { measured: false, configurations: 4, reason: 'la matriz de la ronda se junta antes del paso 31' };
  const measured = (configurations: number, pbo: number): PboOutcome => ({ measured: true, result: { pbo, combinations: 12_870, blocks: 16, configurations }, periods: 3000 });
  expect('A.3.6', [
    ['PASS', { pbo: { family: high, global: pboOk } }], // el de la familia no rechaza
    ['FAIL', { pbo: { family: pboOk, global: high } }],
    ['NO CONCLUYENTE', { pbo: { family: high, global: pending } }], // hasta la matriz de la ronda
    ['NO CONCLUYENTE', { pbo: { family: pboOk, global: single } }],
    ['NO CONCLUYENTE', { pbo: { family: pboOk, global: measured(2, 0.1) } }],
    ['NO CONCLUYENTE', { pbo: { family: pboOk, global: measured(2, 0.9) } }], // tampoco rechaza
  ]);
  assert.equal(criterion({ ...passing(), pbo: { family: pboOk, global: measured(3, 0.1) } }, 'A.3.6').status, 'PASS', 'con 3 ya decide');
  assert.equal(criterion({ ...passing(), pbo: { family: pboOk, global: measured(3, 0.2) } }, 'A.3.6').status, 'FAIL');
  const two = criterion({ ...passing(), pbo: { family: pboOk, global: measured(2, 0.1) } }, 'A.3.6');
  assert.deepEqual([two.value['pbo_global'], two.value['configuraciones_global']], [0.1, 2], 'se informa');
  assert.match(two.note ?? '', /2 configuraciones, menos de 3/);
  assert.equal(criterion({ ...passing(), pbo: { family: high, global: pending } }, 'A.3.6').value['pbo_familia'], 0.2, 'se informa');
  assert.match(criterion({ ...passing(), pbo: { family: single, global: single } }, 'A.3.6').note ?? '', /menos de dos configuraciones/);
});

test('A.3.7: costes ×2, retraso de una vela, cada ventana de crisis en validación y peor caso dentro de la vela', () => {
  expect('A.3.7', [
    ['FAIL', { costs2: ok({ sharpe: 0.5, netPnl: -1 }) }],
    ['FAIL', { delay: ok({ sharpe: -0.01, netPnl: 100 }) }],
    ['FAIL', { crisisWindows: [win('2018-01-01/2018-12-31', -0.02, -0.7, 0.11)] }],
    ['FAIL', { crisisWindows: [win('2020-03-01/2020-04-30', -0.12, -0.1, 0.05)] }],
    ['FAIL', { intrabarPolicy: 'objetivo-primero' }],
    ['NO CONCLUYENTE', { delay: missing('falló la ejecución') }],
    ['NO CONCLUYENTE', { crisisWindows: [win('2018-01-01/2018-12-31', 0, 0, 0, 'parcial')] }],
    ['NO CONCLUYENTE', { crisisWindows: [win('2018-01-01/2018-12-31', 0, 0, 0, 'fuera')] }],
  ]);
  // Una ventana fuera de los tramos no cuenta si hay otras dentro.
  assert.equal(criterion({ ...passing(), crisisWindows: [...passing().crisisWindows, win('2021-05-01/2021-07-31', 0, 0, 0, 'fuera')] }, 'A.3.7').status, 'PASS');
});

test('A.3.8: ±25 % y ±50 % sin cambio de signo ni caída por debajo de la mitad, ≤ 3 cifras significativas y barrido estable', () => {
  expect('A.3.8', [
    ['FAIL', { sensitivity: ok([{ param: 'entryPeriod', step: -0.5, sharpe: ok(0.59) }]) }],
    ['FAIL', { sensitivity: ok([{ param: 'entryPeriod', step: 0.25, sharpe: ok(-0.2) }]) }],
    ['FAIL', { params: { entryPeriod: 55, stopAtr: 2.125 } }],
    ['FAIL', { sweep: [{ param: 'entryPeriod', stability: 0.5 }] }],
    ['FAIL', { sharpe: -0.3 }],
    ['NO CONCLUYENTE', { sensitivity: missing('la estrategia no declara cómo construir variantes') }],
    ['NO CONCLUYENTE', { sensitivity: ok([{ param: 'rsiPeriod', step: -0.5, sharpe: missing('RangeError: periodo inválido 1') }]) }],
    ['NO CONCLUYENTE', { sweep: [{ param: 'entryPeriod', stability: null }] }],
  ]);
  assert.equal(criterion({ ...passing(), sweep: [{ param: 'entryPeriod', stability: 2 / 3 }] }, 'A.3.8').status, 'PASS');
  assert.match(criterion(passing(), 'A.3.8').note ?? '', /sin barrido/);
});

test('A.3.9: perfil de la familia en cada bajista, en alcista y en lateral; sin perfil o fuera de muestra, NO CONCLUYENTE', () => {
  // Tendencia, en crecimiento logarítmico (ADR 0042): con el benchmark en −19 % en un bajista, ln(1 + s) ≥ ½ ln 0,81, es
  // decir, s ≥ −10 %; con el benchmark en +125 % en alcista, s ≥ √2,25 − 1 = +50 %. Lateral, pérdida ≤ 5 % anual.
  const bear2018 = (s: number, b = -0.19) => [win('2018', s, b, 0.09), win('2022', -0.01, -0.06, 0.08)];
  const bull = (s: number, b = 1.25) => ({ periods: 900, strategyReturn: s, benchmarkReturn: b, strategyAnnualized: 0.1 });
  expect('A.3.9', [
    ['FAIL', { bearEpisodes: bear2018(-0.101) }],
    ['FAIL', { bearEpisodes: bear2018(-0.001, 0.01) }], // si el benchmark no cae, no puede perder
    ['FAIL', { bull: bull(0.49) }],
    ['FAIL', { bull: bull(-0.001, -0.05) }], // si el benchmark no sube, no puede perder
    ['FAIL', { lateral: { periods: 600, strategyReturn: -0.1, benchmarkReturn: 0, strategyAnnualized: -0.051 } }],
    ['NO CONCLUYENTE', { family: 'familia-sin-perfil' }],
    ['NO CONCLUYENTE', { bearEpisodes: [win('2018', -0.02, -0.07, 0.09, 'parcial'), win('2022', -0.01, -0.06, 0.08)] }],
    ['NO CONCLUYENTE', { lateral: { periods: 0, strategyReturn: null, benchmarkReturn: null, strategyAnnualized: null } }],
    ['NO CONCLUYENTE', { regimeExposure: null }],
  ]);
  // +51 % pasa en logaritmos; la regla compuesta congelada pedía ½ · 125 % = +62,5 % (Q-02).
  for (const change of [{ bearEpisodes: bear2018(-0.099) }, { bearEpisodes: bear2018(0, 0.01) }, { bull: bull(0.51) }, { bull: bull(0, -0.05) }]) {
    assert.equal(criterion({ ...passing(), ...change }, 'A.3.9').status, 'PASS', JSON.stringify(change));
  }
  // Lo que no se compara sin exposición no tapa un FAIL que sí se mide (el lateral).
  assert.equal(criterion({ ...passing(), regimeExposure: null, lateral: { ...passing().lateral, strategyAnnualized: -0.06 } }, 'A.3.9').status, 'FAIL');
  const values = criterion(passing(), 'A.3.9').value;
  assert.equal(values.exposicion_benchmark, 0.1);
  assert.ok(Math.abs(Number(values.alcista_captura_log) - Math.log(1.3) / Math.log(1.45)) < 1e-12);
  assert.ok(Math.abs(Number(values.bajista_2018_fraccion_log) - Math.log(0.98) / Math.log(0.93)) < 1e-12);
  // Reversión a la media: más exigente en bajista (25 %: s ≥ 0,81^¼ − 1 ≈ −5,13 %) y en lateral (≥ 0 %).
  const reversion = { ...passing(), family: 'reversion-rsi2' };
  assert.equal(criterion(reversion, 'A.3.9').status, 'FAIL', 'lateral −2 % anual');
  const flat = { ...reversion, lateral: { ...passing().lateral, strategyAnnualized: 0 } };
  assert.equal(criterion({ ...flat, bearEpisodes: bear2018(-0.05) }, 'A.3.9').status, 'PASS');
  assert.equal(criterion({ ...flat, bearEpisodes: bear2018(-0.053) }, 'A.3.9').status, 'FAIL');
  assert.deepEqual([...FAMILY_PROFILES.keys()], ['tendencia-donchian-atr', 'regimen-btc-sma200', 'reversion-rsi2', 'ruptura-volatilidad-intradia']);
});

test('A.3.9, condición por régimen (ADR 0042): vale la más exigente de las dos comparaciones; sin posición en un régimen, decide la de toda la serie', () => {
  const own = passing().regimeOwn;
  const ownBear2018 = (result: WindowResult): CriteriaEvidence['regimeOwn'] => ({ ...own, bear: own.bear.map((b, k) => (k === 0 ? { exposure: 0.03, result } : b)) });
  expect('A.3.9', [
    // Pasa frente a la exposición de toda la serie, pero en el alcista tuvo posiciones más grandes: frente a BTC a su
    // tamaño, la captura es ln 1,3 / ln 2 ≈ 0,38 < 0,5.
    ['FAIL', { regimeOwn: { ...own, bull: { exposure: 0.3, result: { periods: 900, strategyReturn: 0.3, benchmarkReturn: 1, strategyAnnualized: 0.11 } } } }],
    // En 2018 tuvo posiciones pequeñas: frente a BTC a su tamaño, pierde casi lo mismo que él.
    ['FAIL', { regimeOwn: ownBear2018(win('2018', -0.02, -0.021, 0.09)) }],
    ['NO CONCLUYENTE', { regimeOwn: ownBear2018(win('2018', -0.02, -0.021, 0.09, 'parcial')) }],
  ]);
  assert.equal(criterion({ ...passing(), regimeOwn: { bull: null, bear: [null, null] } }, 'A.3.9').status, 'PASS', 'sin posición en esos periodos, no añade nada');
  assert.equal(criterion({ ...passing(), bull: { ...passing().bull, strategyReturn: 0.1 } }, 'A.3.9').status, 'FAIL', 'tampoco tapa un FAIL de la de toda la serie');
  const values = criterion(passing(), 'A.3.9').value;
  assert.deepEqual([values.alcista_exposicion, values.bajista_2018_exposicion, values.bajista_2022_exposicion], [0.15, 0.14, 0.14]);
  assert.ok(Math.abs(Number(values.alcista_captura_log_propia) - Math.log(1.3) / Math.log(1.5)) < 1e-12);
  assert.ok(Math.abs(Number(values.bajista_2018_fraccion_log_propia) - Math.log(0.98) / Math.log(0.9)) < 1e-12);
  assert.match(criterion(passing(), 'A.3.9').threshold, /por la que tuvo en cada régimen, sin polvo, y vale la más exigente/);
});

test('A.3.10: Sharpe y Calmar por encima de BTC y del equiponderado', () => {
  expect('A.3.10', [
    ['FAIL', { benchmarks: { btc: { sharpe: 1.3, calmar: 0.8 }, universe: ok({ sharpe: 0.8, calmar: 0.7 }) } }],
    ['FAIL', { calmar: 0.75 }],
    ['FAIL', { benchmarks: { btc: { sharpe: 0.9, calmar: 0.8 }, universe: ok({ sharpe: 0.8, calmar: 2.5 }) } }],
    ['NO CONCLUYENTE', { benchmarks: { btc: { sharpe: 0.9, calmar: 0.8 }, universe: missing('sin equiponderado') } }],
    ['NO CONCLUYENTE', { calmar: null }],
  ]);
});

test('A.3.11: límite inferior del IC al 95 % del Sharpe > 0, el menor del bootstrap y del de la varianza a largo plazo', () => {
  expect('A.3.11', [
    ['FAIL', { bootstrap: { ...passing().bootstrap, sharpe: ci(0, 2) } }],
    ['FAIL', { intervalLongRun: { lower: -0.01, upper: 2, lag: 15 } }], // el bootstrap pasa, la autocorrelación no
    ['NO CONCLUYENTE', { bootstrap: { ...passing().bootstrap, sharpe: null } }],
    ['NO CONCLUYENTE', { intervalLongRun: null }],
  ]);
  assert.equal(criterion(passing(), 'A.3.11').value['ic95_sharpe_inferior_que_decide'], 0.25);
});

test('A.3.12: Sharpe por encima del percentil 95 de al menos 1000 simulaciones; el simulador solo decide con la réplica a ≤ 10 %', () => {
  expect('A.3.12', [
    ['FAIL', { randomControl: ok(control({ p95: 1.2, percentile: 0.95 })) }],
    ['NO CONCLUYENTE', { randomControl: ok(control({ simulations: 999 })) }],
    ['NO CONCLUYENTE', { randomControl: missing('sin operaciones') }],
    // La réplica se aleja un 11 %: el simulador no decide, aunque su percentil 95 dé PASS.
    ['NO CONCLUYENTE', { randomControl: ok(control({ replica: 1.332, deviation: 0.11 })) }],
    ['NO CONCLUYENTE', { randomControl: ok(control({ deviation: null })) }],
    // Repetido con el backtester real: decide aunque la réplica estuviera lejos.
    ['PASS', { randomControl: ok(control({ method: 'backtester', deviation: 0.4, simulatorP95: 0.5 })) }],
    ['FAIL', { randomControl: ok(control({ method: 'backtester', deviation: 0.4, p95: 1.3 })) }],
  ]);
  assert.equal(controlUsable('simulador', 0.1), true, 'el 10 % justo vale');
  assert.equal(controlUsable('simulador', 0.1000001), false);
  assert.equal(controlUsable('backtester', null), true);
});

test('A.3.13: sin el mejor año y sin el mejor activo, Sharpe > 0', () => {
  expect('A.3.13', [
    ['FAIL', { withoutBestYear: { bestYear: '2017', years: 9, sharpeAnnualized: -0.1 } }],
    ['FAIL', { withoutBestAsset: ok({ asset: 'BTC/EUR', sharpe: 0 }) }],
    ['NO CONCLUYENTE', { withoutBestYear: { bestYear: null, years: 1, sharpeAnnualized: null } }],
    ['NO CONCLUYENTE', { withoutBestAsset: missing('universo de un solo activo') }],
  ]);
});

// Ablación con la exposición controlada (ADR 0037): cuenta el exceso de Sharpe sobre la mediana del control aleatorio, de
// las mismas operaciones y duraciones. Con el Sharpe base de 1,2 y la mediana de su control de 0,3, el exceso base es 0,9.
const without = (component: string, sharpe: number, excess: number) => ({ component, sharpe: ok(sharpe), excess: ok(excess), exposure: { timeInMarket: 0.9, meanExposure: 0.2 } });

test('A.3.14: quitar cada componente baja el exceso sobre su control aleatorio y, con activos no usados, Sharpe > 0', () => {
  expect('A.3.14', [
    ['PASS', { ablation: ok([without('salida-canal', 1.5, 0.5)]) }], // más Sharpe por más exposición, pero menos exceso: aporta
    ['FAIL', { ablation: ok([without('salida-canal', 0.8, 1.0)]) }], // menos Sharpe, pero más exceso sobre su control: no aporta
    ['FAIL', { ablation: ok([without('salida-canal', 1.2, 0.9)]) }], // igual exceso: no aporta
    ['FAIL', { ablation: ok([without('filtro-tendencia', 0.5, 0.3), without('salida-media', 0.9, 1.1)]) }],
    ['FAIL', { alternativeUniverse: ok({ symbols: 'SOL/EUR', sharpe: -0.1 }) }],
    ['NO CONCLUYENTE', { ablation: missing('la estrategia no declara su ablación') }],
    ['NO CONCLUYENTE', { ablation: ok([]) }],
    ['NO CONCLUYENTE', { ablation: ok([{ component: 'salida-canal', sharpe: missing('RangeError: x'), excess: missing('RangeError: x'), exposure: null }]) }],
    ['NO CONCLUYENTE', { ablation: ok([{ ...without('salida-canal', 0.4, 0.2), excess: missing('control sin medir') }]) }],
    ['NO CONCLUYENTE', { randomControl: missing('sin operaciones') }],
    ['NO CONCLUYENTE', { alternativeUniverse: missing('sin universo alternativo pre-registrado') }],
    ['NO CONCLUYENTE', { alternativeUniverse: ok({ symbols: 'SOL/EUR', sharpe: null }) }],
    ['NO CONCLUYENTE', { sharpe: null }],
  ]);
  const values = criterion(passing(), 'A.3.14').value;
  const rounded = (v: unknown): unknown => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v);
  assert.deepEqual([values['sharpe_sin_salida-canal'], values['exceso_base'], values['exceso_sin_salida-canal']].map(rounded), [0.4, 0.9, 0.2]);
  assert.deepEqual([values['tiempo_en_mercado_sin_salida-canal'], values['exposicion_media_sin_salida-canal']], [0.6, 0.1]);
});

test('A.3.15: con la señal desplazada y con un paseo aleatorio, nada por encima del percentil 95 del control', () => {
  expect('A.3.15', [
    ['FAIL', { smoke: { shifted: ok(shift({ median: 1 })), randomWalk: ok(walk()) } }],
    ['FAIL', { smoke: { shifted: ok(shift()), randomWalk: ok(walk({ sharpe: 0.81 })) } }],
    ['NO CONCLUYENTE', { smoke: { shifted: missing('sin operaciones'), randomWalk: ok(walk()) } }],
    ['NO CONCLUYENTE', { smoke: { shifted: ok(shift()), randomWalk: ok(walk({ sharpe: null })) } }],
    ['NO CONCLUYENTE', { smoke: { shifted: ok(shift({ deviation: 0.2 })), randomWalk: ok(walk()) } }],
    ['NO CONCLUYENTE', { smoke: { shifted: ok(shift()), randomWalk: ok(walk({ deviation: 0.15 })) } }],
    ['PASS', { smoke: { shifted: ok(shift({ method: 'backtester', deviation: 0.2 })), randomWalk: ok(walk({ method: 'backtester', deviation: 0.15 })) } }],
  ]);
});
