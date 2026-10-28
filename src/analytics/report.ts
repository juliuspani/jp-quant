// Informe de rendimiento de un run (paso 26, ADR 0029): junta los tramos fuera de muestra de un experimento y calcula,
// netas de costes y en EUR, las métricas de la concatenación de tramos (quant-research §4), el Deflated Sharpe con el N
// del Experiment Registry, los IC del bootstrap por bloques, alfa y beta frente al buy-and-hold de BTC y los desgloses
// por activo, año, estrategia y régimen. Funciones puras: los datos y el azar con semilla llegan de fuera.
//
// Cada tramo empieza con su capital. Su curva termina en el valor de liquidación: el último punto se sustituye por lo que
// se cobraría vendiendo lo abierto, en el mismo instante, así que la serie concatenada lleva todos los costes. El
// benchmark se trata igual. Los periodos se encadenan: la rentabilidad encadenada es la de pasar el capital de un tramo
// al siguiente.
import type { Rng } from '../kernel/random.ts';
import type { RegimeView } from '../kernel/regime.ts';
import type { Timeframe, UtcMillis } from '../shared/time.ts';
import type { BenchmarkCurve } from './benchmark.ts';
import {
  groupAssets, groupPeriods, groupTrades, periodInstant, utcYear, type AssetGroup, type FillRecord, type PeriodGroup, type PeriodRecord, type TradeGroup,
} from './breakdown.ts';
import {
  AnalyticsError, alphaBetaOf, cagrOf, drawdownOf, finite, periodReturns, periodsPerYear, sharpeOf, sortinoOf, tailLossesOf,
  type AlphaBeta, type EquitySample, type TailLosses,
} from './performance.ts';
import { regimeAt } from './regime.ts';
import {
  bootstrapIntervals, deflatedSharpe, meanBlockLength, minTrackRecordLength, moments, nullSharpeVariance, probabilisticSharpe, sharpeInterval,
  sharpeLongRunVariance, type ConfidenceInterval,
} from './statistics.ts';
import { tradeStats, type TradeRecord, type TradeStats } from './trades.ts';

export const REPORT_CURRENCY = 'EUR';
const NO_DATA = 'SIN_DATO';

export interface FoldData {
  readonly from: UtcMillis;
  readonly to: UtcMillis;
  readonly startEquity: number;
  readonly endEquity: number; // valor de liquidación al final, neto de costes
  readonly curve: readonly EquitySample[];
  readonly fills: readonly FillRecord[];
  readonly liquidationCost: number;
  readonly trades: readonly TradeRecord[];
  readonly benchmark: BenchmarkCurve; // buy-and-hold de BTC en los instantes de la curva
  readonly universeBenchmark: BenchmarkCurve | null; // equiponderado del universo, si tiene más de un símbolo
}

export interface RunAnalyticsInput {
  readonly currency: string; // todas las cifras en EUR
  readonly timeframe: Timeframe;
  readonly folds: readonly FoldData[];
  readonly regimeSymbol: string;
  readonly regimes: readonly RegimeView[]; // del símbolo de régimen (BTC), en orden
  readonly family: { readonly trials: number }; // N de la familia en el registro; el global se calcula al decidir (ADR 0039)
  readonly bootstrap: { readonly resamples: number; readonly rng: Rng; readonly seed: number };
}

export interface DeflatedSharpeReport {
  readonly trials: number; // N
  readonly sharpe: number; // por periodo
  readonly periods: number; // T
  readonly skewness: number;
  readonly kurtosis: number;
  readonly trialVariance: number; // V[SRₙ]: la del Sharpe estimado de una prueba sin habilidad como esta (ADR 0039)
  readonly varianceFactor: number; // varianza del Sharpe estimado por T − 1, con la autocorrelación (ADR 0038)
  readonly lag: number; // retardos de esa varianza: la longitud media de bloque del bootstrap
  readonly sr0: number;
  readonly dsr: number;
  readonly psr: number; // PSR frente a 0
  readonly minTrackRecord: number | null; // MinTRL al 95 %, en periodos
  readonly meetsMinTrackRecord: boolean;
}

export interface RunSummary {
  readonly currency: string;
  readonly periods: number;
  readonly years: number;
  readonly startingCapital: number; // suma de los capitales iniciales de los tramos
  readonly netPnl: number;
  readonly chainedReturn: number;
  readonly cagr: number | null;
  readonly meanReturn: number;
  readonly volatilityAnnualized: number;
  readonly sharpe: number | null;
  readonly sharpeAnnualized: number | null;
  readonly sortinoAnnualized: number | null;
  readonly skewness: number | null;
  readonly kurtosis: number | null;
  readonly maxDrawdown: number;
  readonly maxDrawdownDuration: number; // en periodos
  readonly calmar: number | null;
  readonly tail: TailLosses | null;
  readonly timeInMarket: number;
  readonly meanExposure: number;
  readonly turnover: number; // importe negociado / capital inicial total
  readonly turnoverAnnual: number; // importe negociado / capital medio por tramo / años
  readonly feesPaid: number;
  readonly implicitCosts: number; // medio spread, slippage e impacto realizados
  readonly liquidationCosts: number;
  readonly totalCosts: number;
  readonly costReturn: number; // costes / capital inicial total
  readonly trades: TradeStats;
  readonly benchmark: {
    readonly symbol: string;
    readonly chainedReturn: number;
    readonly sharpeAnnualized: number | null;
    readonly maxDrawdown: number;
    readonly universeChainedReturn: number | null; // equiponderado, si el universo tiene más de un símbolo
  };
  readonly alphaBeta: AlphaBeta | null; // frente al buy-and-hold de BTC
  readonly excessSharpeAnnualized: number | null; // Sharpe anualizado de la estrategia menos el de BTC
}

export interface RunReport {
  readonly summary: RunSummary;
  readonly deflatedSharpe: DeflatedSharpeReport | null;
  readonly deflatedSharpeNote: string | null; // por qué no se calcula
  // IC al 95 % del Sharpe anualizado con la varianza a largo plazo de su estimación (ADR 0038); null sin Sharpe
  readonly sharpeIntervalLongRun: { readonly lower: number; readonly upper: number; readonly lag: number } | null;
  readonly pbo: null;
  readonly pboNote: string;
  readonly bootstrap: {
    readonly method: string;
    readonly seed: number;
    readonly resamples: number;
    readonly meanBlock: number;
    readonly sharpeAnnualized: ConfidenceInterval | null;
    readonly cagr: ConfidenceInterval | null;
    readonly maxDrawdown: ConfidenceInterval | null;
    readonly excessSharpeAnnualized: ConfidenceInterval | null;
  };
  readonly breakdown: {
    readonly byAsset: Readonly<Record<string, AssetGroup>>;
    readonly byYear: Readonly<Record<string, PeriodGroup>>;
    readonly tradesByYear: Readonly<Record<string, TradeGroup>>; // por año de cierre; las abiertas, aparte
    readonly byStrategy: Readonly<Record<string, TradeGroup>>;
    readonly regime: {
      readonly symbol: string;
      readonly classifierId: string | null;
      readonly volatility: Readonly<Record<string, PeriodGroup>>; // etiqueta conocida al empezar cada periodo
      readonly trend: Readonly<Record<string, PeriodGroup>>;
      readonly tradesByVolatility: Readonly<Record<string, TradeGroup>>; // etiqueta conocida al abrir
      readonly tradesByTrend: Readonly<Record<string, TradeGroup>>;
    };
  };
}

interface Path {
  readonly returns: number[];
  readonly benchmark: number[];
  readonly records: PeriodRecord[];
  readonly universe: number[] | null;
}

/** Series de la concatenación de tramos: lo que miden los criterios congelados (paso 27B), además del informe. */
export interface RunSeries {
  readonly returns: readonly number[]; // netas, por periodo, tramo tras tramo
  readonly benchmark: readonly number[]; // buy-and-hold de BTC en los mismos periodos
  readonly universe: readonly number[] | null; // equiponderado del universo, si todos los tramos lo tienen
  readonly records: readonly PeriodRecord[];
  readonly perFold: readonly (readonly number[])[]; // las netas de cada tramo
}

export function runSeries(folds: readonly FoldData[]): RunSeries {
  const paths = folds.map(pathOf);
  return Object.freeze({
    returns: paths.flatMap((p) => p.returns),
    benchmark: paths.flatMap((p) => p.benchmark),
    universe: paths.every((p) => p.universe !== null) ? paths.flatMap((p) => p.universe ?? []) : null,
    records: paths.flatMap((p) => p.records),
    perFold: paths.map((p) => p.returns),
  });
}

function pathOf(fold: FoldData, index: number): Path {
  const { curve, benchmark } = fold;
  const last = curve.length - 1;
  if (last < 0) throw new AnalyticsError(`tramo ${String(index)}: sin curva de patrimonio`);
  if (benchmark.equity.length !== curve.length) throw new AnalyticsError(`tramo ${String(index)}: el benchmark no tiene un punto por cada uno de la curva`);
  // El último punto, a valor de liquidación: lo que se cobraría vendiendo lo abierto en ese mismo instante.
  const equity = [fold.startEquity, ...curve.slice(0, last).map((p) => p.equity), fold.endEquity];
  const bench = [fold.startEquity, ...benchmark.equity.slice(0, last), benchmark.end];
  const returns = periodReturns(equity);
  const benchmarkReturns = periodReturns(bench);
  const records = returns.map((ret, k) => {
    const mark = curve[k];
    const exposure = mark !== undefined && mark.equity > 0 ? finite('exposición sin polvo', mark.exposureWithoutDust) / mark.equity : 0;
    return {
      start: k === 0 ? fold.from : (curve[k - 1]?.at ?? fold.from),
      end: mark?.at ?? fold.to,
      ret,
      benchmark: benchmarkReturns[k] ?? 0,
      inMarket: exposure > 0,
      exposure,
    };
  });
  const universe = fold.universeBenchmark === null
    ? null
    : periodReturns([fold.startEquity, ...fold.universeBenchmark.equity.slice(0, last), fold.universeBenchmark.end]);
  return { returns, benchmark: benchmarkReturns, records, universe };
}

function compound(returns: Iterable<number>): number {
  let total = 1;
  for (const r of returns) total *= 1 + r;
  return total - 1;
}

function chainedEquity(returns: readonly number[]): number[] {
  const path = [1];
  for (const r of returns) path.push((path.at(-1) ?? 1) * (1 + r));
  return path;
}

function label(value: string | null | undefined): string {
  return value ?? NO_DATA;
}

/**
 * DSR con N pruebas (ADR 0039): V[SRₙ] es la varianza del Sharpe estimado de una prueba sin habilidad con la misma
 * longitud y dependencia, y no depende de ninguna otra prueba. `lag`: los retardos de las varianzas a largo plazo, la
 * longitud media de bloque del bootstrap (ADR 0038). Lo usan el DSR de la familia al cerrar y el global al decidir.
 */
export function deflatedSharpeOf(returns: readonly number[], trials: number, lag: number): { report: DeflatedSharpeReport | null; note: string | null } {
  if (!Number.isSafeInteger(trials) || trials < 1) throw new AnalyticsError(`N inválido: ${String(trials)}`);
  if (returns.length < 3) return { report: null, note: 'menos de tres periodos' };
  const m = moments(returns);
  if (m.skewness === null || m.kurtosis === null || !(m.std > 0)) return { report: null, note: 'rentabilidades sin variación: no hay Sharpe' };
  const sharpe = m.mean / m.std;
  const varianceFactor = sharpeLongRunVariance(returns, lag);
  const sample = { sharpe, periods: returns.length, skewness: m.skewness, kurtosis: m.kurtosis, varianceFactor };
  const trialVariance = nullSharpeVariance(returns, lag);
  const { sr0, dsr } = deflatedSharpe(sample, trials, trialVariance);
  const minTrackRecord = minTrackRecordLength(sample);
  return {
    report: Object.freeze({
      trials,
      sharpe,
      periods: returns.length,
      skewness: m.skewness,
      kurtosis: m.kurtosis,
      varianceFactor,
      lag,
      trialVariance,
      sr0,
      dsr,
      psr: probabilisticSharpe(sample, 0),
      minTrackRecord,
      meetsMinTrackRecord: minTrackRecord !== null && returns.length >= minTrackRecord,
    }),
    note: null,
  };
}

export function analyzeRun(input: RunAnalyticsInput): RunReport {
  if (input.currency !== REPORT_CURRENCY) throw new AnalyticsError(`todas las métricas van en ${REPORT_CURRENCY}, no en ${input.currency}`);
  if (input.folds.length === 0) throw new AnalyticsError('run sin tramos');
  const perYear = periodsPerYear(input.timeframe);
  const annual = Math.sqrt(perYear);
  const paths = input.folds.map(pathOf);
  const returns = paths.flatMap((p) => p.returns);
  const bench = paths.flatMap((p) => p.benchmark);
  const records = paths.flatMap((p) => p.records);
  const trades = input.folds.flatMap((f) => f.trades);
  const fills = input.folds.flatMap((f) => f.fills);
  const samples = input.folds.flatMap((f) => f.curve);
  const capital = input.folds.reduce((a, f) => a + finite('capital inicial', f.startEquity), 0);
  if (!(capital > 0)) throw new AnalyticsError('capital inicial no positivo');

  const periods = returns.length;
  const years = periods / perYear;
  const chainedReturn = compound(returns);
  const m = periods >= 2 ? moments(returns) : null;
  const { sharpe } = sharpeOf(returns);
  const sortino = sortinoOf(returns);
  const { maxDrawdown, maxDuration } = drawdownOf(chainedEquity(returns));
  const cagr = cagrOf(1, 1 + chainedReturn, periods, perYear);
  const traded = fills.reduce((a, f) => a + finite('importe', f.notional), 0);
  const feesPaid = fills.reduce((a, f) => a + finite('comisión', f.fee), 0);
  const implicitCosts = fills.reduce((a, f) => a + finite('coste implícito', f.implicit), 0);
  const liquidationCosts = input.folds.reduce((a, f) => a + finite('coste de liquidación', f.liquidationCost), 0);
  const totalCosts = feesPaid + implicitCosts + liquidationCosts;
  const stats = tradeStats(trades, input.timeframe);
  const benchSharpe = sharpeOf(bench).sharpe;
  const universe = paths.every((p) => p.universe !== null) ? compound(paths.flatMap((p) => p.universe ?? [])) : null;
  const exposures = samples.filter((p) => p.equity > 0).map((p) => p.exposureWithoutDust / p.equity); // sin polvo, como A.3.9
  const capitalPerFold = capital / input.folds.length;

  const summary: RunSummary = Object.freeze({
    currency: REPORT_CURRENCY,
    periods,
    years,
    startingCapital: capital,
    netPnl: input.folds.reduce((a, f) => a + (finite('patrimonio final', f.endEquity) - f.startEquity), 0),
    chainedReturn,
    cagr,
    meanReturn: m?.mean ?? returns[0] ?? 0,
    volatilityAnnualized: (m?.std ?? 0) * annual,
    sharpe,
    sharpeAnnualized: sharpe === null ? null : sharpe * annual,
    sortinoAnnualized: sortino === null ? null : sortino * annual,
    skewness: m?.skewness ?? null,
    kurtosis: m?.kurtosis ?? null,
    maxDrawdown,
    maxDrawdownDuration: maxDuration,
    calmar: cagr === null || maxDrawdown === 0 ? null : cagr / maxDrawdown,
    tail: tailLossesOf(returns),
    timeInMarket: samples.filter((p) => p.exposureWithoutDust > 0).length / samples.length,
    meanExposure: exposures.length === 0 ? 0 : exposures.reduce((a, b) => a + b, 0) / exposures.length,
    turnover: traded / capital,
    turnoverAnnual: years > 0 ? traded / capitalPerFold / years : 0,
    feesPaid,
    implicitCosts,
    liquidationCosts,
    totalCosts,
    costReturn: totalCosts / capital,
    trades: stats,
    benchmark: Object.freeze({
      symbol: input.regimeSymbol,
      chainedReturn: compound(bench),
      sharpeAnnualized: benchSharpe === null ? null : benchSharpe * annual,
      maxDrawdown: drawdownOf(chainedEquity(bench)).maxDrawdown,
      universeChainedReturn: universe,
    }),
    alphaBeta: alphaBetaOf(returns, bench, perYear),
    excessSharpeAnnualized: sharpe === null || benchSharpe === null ? null : (sharpe - benchSharpe) * annual,
  });

  // El horizonte de dependencia del bootstrap es también el de la varianza a largo plazo del Sharpe (ADR 0038).
  const meanBlock = meanBlockLength(periods, stats.meanBars);
  const { report: dsr, note: dsrNote } = deflatedSharpeOf(returns, input.family.trials, meanBlock);
  const longRun = dsr === null ? null : sharpeInterval(dsr.sharpe, dsr.periods, dsr.varianceFactor);

  // Bootstrap estacionario sobre la serie concatenada; el exceso remuestrea los mismos periodos en ambas series.
  const pick = (series: readonly number[], idx: Int32Array): number[] => Array.from(idx, (i) => series[i] ?? 0);
  const annualSharpe = (series: readonly number[]): number | null => {
    const s = sharpeOf(series).sharpe;
    return s === null ? null : s * annual;
  };
  const intervals = bootstrapIntervals(
    periods,
    {
      sharpeAnnualized: (idx) => annualSharpe(pick(returns, idx)),
      cagr: (idx) => cagrOf(1, 1 + compound(pick(returns, idx)), periods, perYear),
      maxDrawdown: (idx) => drawdownOf(chainedEquity(pick(returns, idx))).maxDrawdown,
      excessSharpeAnnualized: (idx) => {
        const a = annualSharpe(pick(returns, idx));
        const b = annualSharpe(pick(bench, idx));
        return a === null || b === null ? null : a - b;
      },
    },
    { resamples: input.bootstrap.resamples, meanBlock, rng: input.bootstrap.rng },
  );

  const regimeOf = (t: UtcMillis): RegimeView | null => regimeAt(input.regimes, t);
  return Object.freeze({
    summary,
    deflatedSharpe: dsr,
    deflatedSharpeNote: dsrNote,
    sharpeIntervalLongRun: longRun === null ? null : Object.freeze({ lower: longRun.lower * annual, upper: longRun.upper * annual, lag: meanBlock }),
    pbo: null,
    pboNote: 'una sola configuración: el PBO por CSCV exige comparar varias (barridos con elección en train)',
    bootstrap: Object.freeze({
      method: 'estacionario de Politis y Romano, IC por percentiles al 95 %',
      seed: input.bootstrap.seed,
      resamples: input.bootstrap.resamples,
      meanBlock,
      ...intervals,
    }),
    breakdown: Object.freeze({
      byAsset: groupAssets(trades, fills, capital, input.timeframe),
      // Por la fecha de su punto medio: la vela del 31 de diciembre cuenta en su año aunque se reciba el 1 de enero.
      byYear: groupPeriods(records, (r) => utcYear(periodInstant(r)), perYear),
      tradesByYear: groupTrades(trades, (t) => (t.closedAt === null ? 'abiertas' : utcYear(t.closedAt)), input.timeframe),
      byStrategy: groupTrades(trades, (t) => t.strategy, input.timeframe),
      regime: Object.freeze({
        symbol: input.regimeSymbol,
        classifierId: input.regimes[0]?.classifierId ?? null,
        volatility: groupPeriods(records, (r) => label(regimeOf(r.start)?.volatility), perYear),
        trend: groupPeriods(records, (r) => label(regimeOf(r.start)?.trend), perYear),
        tradesByVolatility: groupTrades(trades, (t) => label(regimeOf(t.openedAt)?.volatility), input.timeframe),
        tradesByTrend: groupTrades(trades, (t) => label(regimeOf(t.openedAt)?.trend), input.timeframe),
      }),
    }),
  });
}
