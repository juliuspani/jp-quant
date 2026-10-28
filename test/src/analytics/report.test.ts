// Informe de rendimiento de un run (paso 26, ADR 0029) con tramos sintéticos de resultado conocido: concatenación de
// tramos con la liquidación final, costes en EUR, alfa y beta frente al buy-and-hold, DSR con el N de la familia,
// bootstrap determinista por semilla y desgloses por activo, año, estrategia y régimen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsError } from '../../../src/analytics/performance.ts';
import { analyzeRun, runSeries, type FoldData, type RunAnalyticsInput } from '../../../src/analytics/report.ts';
import { deflatedSharpe, moments, nullSharpeVariance, probabilisticSharpe } from '../../../src/analytics/statistics.ts';
import type { RegimeView } from '../../../src/kernel/regime.ts';
import { seededRng } from '../../../src/kernel/random.ts';

const DAY = 86_400_000;
const Y2020 = Date.UTC(2020, 0, 1);
const Y2021 = Date.UTC(2021, 0, 1);

function near(actual: number | null | undefined, expected: number, tolerance = 1e-9): void {
  assert.ok(actual !== null && actual !== undefined, `se esperaba ${String(expected)} y es null`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${String(actual)} ≠ ${String(expected)}`);
}

/** Tramo cuya serie neta (con la liquidación en el último punto) tiene justo las rentabilidades `strategy`, y su benchmark las `bench`. */
function fold(from: number, strategy: readonly number[], bench: readonly number[], extra: Partial<FoldData> = {}): FoldData {
  const equity = [1000];
  const benchmark = [1000];
  for (const [k, r] of strategy.entries()) {
    equity.push((equity.at(-1) ?? 0) * (1 + r));
    benchmark.push((benchmark.at(-1) ?? 0) * (1 + (bench[k] ?? 0)));
  }
  const curve = equity.slice(1).map((e, k) => {
    const exposure = k % 2 === 0 ? e / 2 : 0;
    return { at: from + (k + 1) * DAY, equity: e, exposure, exposureWithoutDust: exposure };
  });
  const last = curve.length - 1;
  return {
    from,
    to: from + (strategy.length + 1) * DAY,
    startEquity: 1000,
    endEquity: equity.at(-1) ?? 0,
    // El último punto de la curva es el marcado a mercado, más alto que la liquidación: se sustituye por endEquity.
    curve: curve.map((p, k) => (k === last ? { ...p, equity: p.equity * 1.01 } : p)),
    fills: [],
    liquidationCost: 0,
    trades: [],
    benchmark: { symbols: ['BTC/EUR'], equity: benchmark.slice(1).map((b, k) => (k === last ? b * 1.01 : b)), end: benchmark.at(-1) ?? 0 },
    universeBenchmark: null,
    ...extra,
  };
}

function benchSeries(n: number, seed: number): number[] {
  const rng = seededRng(seed, 'benchmark');
  return Array.from({ length: n }, () => 0.04 * (rng.next() - 0.5));
}

function input(folds: readonly FoldData[], extra: Partial<RunAnalyticsInput> = {}): RunAnalyticsInput {
  return {
    currency: 'EUR',
    timeframe: '1d',
    folds,
    regimeSymbol: 'BTC/EUR',
    regimes: [],
    family: { trials: 1 },
    bootstrap: { resamples: 500, rng: seededRng(9, 'bootstrap'), seed: 9 },
    ...extra,
  };
}

test('concatenación de tramos: encadena las rentabilidades netas, con la liquidación en lugar del último marcado', () => {
  const report = analyzeRun(input([fold(Y2020, [0.1, -0.05], [0, 0]), fold(Y2021, [0.02, 0.03], [0, 0])]));
  const s = report.summary;
  assert.equal(s.currency, 'EUR');
  assert.equal(s.periods, 4);
  near(s.chainedReturn, 1.1 * 0.95 * 1.02 * 1.03 - 1, 1e-12);
  near(s.netPnl, 1000 * (1.1 * 0.95 - 1) + 1000 * (1.02 * 1.03 - 1), 1e-9);
  assert.equal(s.startingCapital, 2000);
  near(s.maxDrawdown, 0.05, 1e-12);
  near(s.benchmark.chainedReturn, 0, 1e-12);
  near(s.timeInMarket, 0.5, 1e-12);
});

test('ADR 0042: cada periodo lleva la exposición sin polvo de la marca que lo cierra, y con ella si está en mercado', () => {
  const base = fold(Date.UTC(2020, 0, 1), [0.01, 0.02, -0.01, 0.03], [0, 0, 0, 0]);
  // La mitad del patrimonio en posiciones; en la segunda marca, todo es polvo.
  const curve = base.curve.map((p, k) => ({ ...p, exposure: p.equity / 2, exposureWithoutDust: k === 1 ? 0 : p.equity / 2 }));
  const { records } = runSeries([{ ...base, curve }]);
  assert.deepEqual(records.map((r) => r.exposure), [0.5, 0, 0.5, 0.5]);
  // El primer periodo ya está en mercado (la posición se abrió dentro de él) y el del polvo no.
  assert.deepEqual(records.map((r) => r.inMarket), [true, false, true, true]);
  const summary = analyzeRun(input([{ ...base, curve }])).summary;
  assert.equal(summary.timeInMarket, 3 / 4, 'el resumen tampoco cuenta el polvo');
  assert.equal(summary.meanExposure, (3 * 0.5) / 4);
});

test('alfa y beta frente al buy-and-hold de BTC: una estrategia que es 0,5 veces BTC más 0,001 al día', () => {
  const b1 = benchSeries(120, 1);
  const b2 = benchSeries(120, 2);
  const report = analyzeRun(input([fold(Y2020, b1.map((r) => 0.5 * r + 0.001), b1), fold(Y2021, b2.map((r) => 0.5 * r + 0.001), b2)]));
  const ab = report.summary.alphaBeta;
  near(ab?.beta, 0.5, 1e-9);
  near(ab?.alpha, 0.001, 1e-9);
  near(ab?.alphaAnnualized, 0.365, 1e-6);
  const sharpe = report.summary.sharpeAnnualized ?? 0;
  near(report.summary.excessSharpeAnnualized, sharpe - (report.summary.benchmark.sharpeAnnualized ?? 0), 1e-12);
});

test('DSR con el N del registro: con N = 1 es el PSR frente a 0; con N = 49, SR₀ > 0 y el DSR baja', () => {
  const b = benchSeries(400, 3);
  const strategy = b.map((r) => 0.3 * r + 0.002);
  const one = analyzeRun(input([fold(Y2020, strategy, b)]));
  const m = moments(strategy);
  const sample = { sharpe: m.mean / m.std, periods: 400, skewness: m.skewness ?? 0, kurtosis: m.kurtosis ?? 0 };
  assert.ok(one.deflatedSharpe !== null);
  assert.equal(one.deflatedSharpe.trials, 1);
  assert.equal(one.deflatedSharpe.sr0, 0);
  near(one.deflatedSharpe.dsr, probabilisticSharpe(sample, 0), 1e-12);
  const many = analyzeRun(input([fold(Y2020, strategy, b)], { family: { trials: 49 } }));
  assert.ok(many.deflatedSharpe !== null);
  // V[SRₙ], la de un Sharpe sin habilidad como este (ADR 0039): nunca por debajo de 1/(T − 1).
  const variance = nullSharpeVariance(strategy, many.bootstrap.meanBlock);
  assert.ok(variance >= 1 / 399);
  near(many.deflatedSharpe.trialVariance, variance, 1e-15);
  near(many.deflatedSharpe.dsr, deflatedSharpe(sample, 49, variance).dsr, 1e-12);
  assert.ok(many.deflatedSharpe.sr0 > 0 && many.deflatedSharpe.dsr < one.deflatedSharpe.dsr);
  assert.equal(many.pbo, null, 'con una configuración no hay PBO');
  assert.match(many.pboNote, /una sola configuración/);
});

test('autocorrelación (ADR 0038): con rentabilidades autocorrelacionadas, el DSR, el MinTRL y el IC usan la varianza a largo plazo', () => {
  // Media de 0,0002 más un ruido AR(1) con coeficiente 0,5: autocorrelación positiva, como la de una estrategia que mantiene posiciones.
  const rng = seededRng(38, 'ar1');
  const strategy: number[] = [];
  let x = 0;
  for (let t = 0; t < 1000; t++) {
    x = 0.5 * x + 0.01 * (rng.next() - 0.5);
    strategy.push(0.0002 + x);
  }
  const report = analyzeRun(input([fold(Y2020, strategy, benchSeries(1000, 3))]));
  assert.ok(report.deflatedSharpe !== null && report.sharpeIntervalLongRun !== null);
  const m = moments(strategy);
  const sample = { sharpe: m.mean / m.std, periods: 1000, skewness: m.skewness ?? 0, kurtosis: m.kurtosis ?? 0 };
  const independent = 1 - sample.skewness * sample.sharpe + ((sample.kurtosis - 1) / 4) * sample.sharpe ** 2;
  assert.equal(report.deflatedSharpe.lag, report.bootstrap.meanBlock, 'los retardos son el bloque del bootstrap');
  assert.ok(report.deflatedSharpe.varianceFactor > 1.5 * independent, 'la autocorrelación agranda la varianza del Sharpe');
  const corrected = { ...sample, varianceFactor: report.deflatedSharpe.varianceFactor };
  near(report.deflatedSharpe.psr, probabilisticSharpe(corrected, 0), 1e-12);
  assert.ok(report.deflatedSharpe.psr < probabilisticSharpe(sample, 0), 'más exigente que con rentabilidades independientes');
  near(report.deflatedSharpe.minTrackRecord, 1 + report.deflatedSharpe.varianceFactor * (1.6448536269514722 / sample.sharpe) ** 2, 1e-6);
  const width = report.sharpeIntervalLongRun.upper - report.sharpeIntervalLongRun.lower;
  near(width, 2 * 1.959963984540054 * Math.sqrt(report.deflatedSharpe.varianceFactor / 999) * Math.sqrt(365), 1e-9);
});

test('bootstrap: determinista por semilla, con IC que contienen la estimación y bloque de al menos ⌈T^(1/3)⌉', () => {
  const b = benchSeries(300, 4);
  const folds = [fold(Y2020, b.map((r) => 0.5 * r + 0.003), b)];
  const a = analyzeRun(input(folds, { bootstrap: { resamples: 800, rng: seededRng(5, 'bootstrap'), seed: 5 } }));
  const again = analyzeRun(input(folds, { bootstrap: { resamples: 800, rng: seededRng(5, 'bootstrap'), seed: 5 } }));
  assert.deepEqual(a.bootstrap, again.bootstrap);
  assert.equal(a.bootstrap.meanBlock, 7);
  const sharpe = a.summary.sharpeAnnualized ?? 0;
  const ci = a.bootstrap.sharpeAnnualized;
  assert.ok(ci !== null && ci.lower < sharpe && sharpe < ci.upper, `${String(sharpe)} fuera de [${String(ci?.lower)}, ${String(ci?.upper)}]`);
  assert.ok(ci.lower > 0, 'con una deriva de 0,003 al día y poco ruido, el IC del Sharpe queda por encima de 0');
  assert.ok(a.bootstrap.maxDrawdown !== null && a.bootstrap.cagr !== null && a.bootstrap.excessSharpeAnnualized !== null);
});

test('desgloses: por año, por activo con sus costes, por estrategia y por régimen point-in-time', () => {
  const strategy = [0.01, 0.02, -0.01, 0.03];
  const trades = [
    { symbol: 'BTC/EUR', strategy: 'prueba@1', openedAt: Y2020 + DAY, closedAt: Y2020 + 3 * DAY, invested: 100, pnl: 5 },
    { symbol: 'ETH/EUR', strategy: 'prueba@1', openedAt: Y2020 + 3 * DAY, closedAt: Y2021 + DAY, invested: 100, pnl: -2 },
    { symbol: 'ETH/EUR', strategy: 'prueba@1', openedAt: Y2021 + 2 * DAY, closedAt: null, invested: 100, pnl: null },
  ];
  const fills = [
    { symbol: 'BTC/EUR', notional: 100, fee: 0.25, implicit: 0.1 },
    { symbol: 'BTC/EUR', notional: 105, fee: 0.26, implicit: 0.1 },
    { symbol: 'ETH/EUR', notional: 100, fee: 0.25, implicit: 0.2 },
  ];
  // Régimen conocido al cierre del 1 y del 3 de enero de 2020: BAJA y ALCISTA, después ALTA y BAJISTA.
  const view = (at: number, volatility: RegimeView['volatility'], trend: RegimeView['trend']): RegimeView =>
    ({ scope: 'BTC/EUR', timeframe: '1d', asOf: at, volatility, trend, classifierId: 'regimen-precio@1' });
  const regimes = [view(Y2020 + DAY, 'BAJA', 'ALCISTA'), view(Y2020 + 3 * DAY, 'ALTA', 'BAJISTA')];
  const report = analyzeRun(input([fold(Y2020, strategy, [0, 0, 0, 0], { trades, fills, liquidationCost: 0.5 })], { regimes }));
  const { breakdown, summary } = report;

  near(summary.feesPaid, 0.76, 1e-12);
  near(summary.implicitCosts, 0.4, 1e-12);
  near(summary.totalCosts, 1.66, 1e-12);
  near(summary.costReturn, 1.66 / 1000, 1e-15);
  near(summary.turnover, 0.305, 1e-12);
  assert.equal(summary.trades.closed, 2);

  assert.deepEqual(Object.keys(breakdown.byYear), ['2020']);
  near(breakdown.byYear['2020']?.compoundedReturn, 1.01 * 1.02 * 0.99 * 1.03 - 1, 1e-12);
  assert.deepEqual(Object.keys(breakdown.tradesByYear), ['2020', '2021', 'abiertas']);

  near(breakdown.byAsset['BTC/EUR']?.netPnl, 5);
  near(breakdown.byAsset['BTC/EUR']?.turnover, 0.205, 1e-12);
  near(breakdown.byAsset['ETH/EUR']?.implicitCosts, 0.2, 1e-12);
  assert.equal(breakdown.byAsset['ETH/EUR']?.open, 1);
  assert.equal(breakdown.byStrategy['prueba@1']?.closed, 2);

  // Periodos: [Y, Y+1d] sin régimen aún; (Y+1d, Y+2d] y (Y+2d, Y+3d] con BAJA; (Y+3d, Y+4d] con ALTA.
  const vol = breakdown.regime.volatility;
  assert.deepEqual(Object.keys(vol), ['ALTA', 'BAJA', 'SIN_DATO']);
  assert.equal(vol['SIN_DATO']?.periods, 1);
  assert.equal(vol['BAJA']?.periods, 2);
  near(vol['BAJA']?.compoundedReturn, 1.02 * 0.99 - 1, 1e-12);
  near(vol['ALTA']?.compoundedReturn, 0.03, 1e-12);
  assert.equal(breakdown.regime.trend['BAJISTA']?.periods, 1);
  // Operaciones, por el régimen que se conocía al abrir: la primera, BAJA; las dos de ETH, ALTA.
  assert.equal(breakdown.regime.tradesByVolatility['BAJA']?.closed, 1);
  assert.equal(breakdown.regime.tradesByVolatility['ALTA']?.closed, 1);
  assert.equal(breakdown.regime.tradesByVolatility['ALTA']?.open, 1);
  assert.equal(breakdown.regime.classifierId, 'regimen-precio@1');
});

test('fail closed: otra moneda, un tramo sin curva o un benchmark desalineado lanzan', () => {
  const ok = fold(Y2020, [0.01, 0.02, 0.03], [0, 0, 0]);
  assert.throws(() => analyzeRun(input([ok], { currency: 'USD' })), AnalyticsError);
  assert.throws(() => analyzeRun(input([{ ...ok, curve: [] }])), AnalyticsError);
  assert.throws(() => analyzeRun(input([{ ...ok, benchmark: { ...ok.benchmark, equity: ok.benchmark.equity.slice(1) } }])), AnalyticsError);
  assert.throws(() => analyzeRun(input([ok], { family: { trials: 0 } })), AnalyticsError);
  assert.throws(() => analyzeRun(input([])), AnalyticsError);
});

test('ADR 0039: V[SRₙ] no depende de otras pruebas ni de N; con más pruebas sube SR₀ y baja el DSR; el global no se calcula al cerrar', () => {
  const b = benchSeries(400, 3);
  const strategy = b.map((r) => 0.3 * r + 0.002);
  const few = analyzeRun(input([fold(Y2020, strategy, b)], { family: { trials: 4 } }));
  const many = analyzeRun(input([fold(Y2020, strategy, b)], { family: { trials: 65 } }));
  assert.ok(few.deflatedSharpe !== null && many.deflatedSharpe !== null);
  assert.equal(few.deflatedSharpe.trialVariance, many.deflatedSharpe.trialVariance, 'la misma V con cualquier N');
  near(few.deflatedSharpe.trialVariance, nullSharpeVariance(strategy, few.bootstrap.meanBlock), 1e-15);
  assert.ok(many.deflatedSharpe.sr0 > few.deflatedSharpe.sr0 && many.deflatedSharpe.dsr < few.deflatedSharpe.dsr);
  assert.equal('deflatedSharpeGlobal' in many, false, 'el DSR global es de la decisión (round-matrix.ts)');
});

test('paso 27B: la vela del 31 de diciembre cuenta en su año aunque se reciba el 1 de enero (marcas al cierre más la latencia)', () => {
  const from = Date.UTC(2020, 11, 30);
  // Velas diarias del 30 y 31 de diciembre y del 1 de enero; cada marca, al recibir la vela: cierre + 1 minuto.
  const base = fold(from, [0.01, 0.02, 0.03], [0, 0, 0]);
  const curve = base.curve.map((p, k) => ({ ...p, at: from + (k + 1) * DAY - 1 + 60_000 }));
  const report = analyzeRun(input([{ ...base, curve }]));
  assert.deepEqual(Object.fromEntries(Object.entries(report.breakdown.byYear).map(([year, g]) => [year, g.periods])), { '2020': 2, '2021': 1 });
  near(report.breakdown.byYear['2020']?.compoundedReturn, 1.01 * 1.02 - 1, 1e-12);
});
