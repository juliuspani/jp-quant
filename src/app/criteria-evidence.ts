// Evidencia de los criterios congelados de un experimento (docs/PROMOTION_CRITERIA.md, A.3; paso 27B, ADR 0031). A partir
// del run base, ejecuta las variantes de robustez pre-registradas y las pruebas de control, y junta lo que necesita el
// evaluador de analytics/criteria.ts:
// - variantes que cuentan en N («variantes» del registro): costes ×2 y ×3, retraso de una vela, cada parámetro numérico
//   a ±25 % y ±50 %, el universo sin su mejor activo si tiene más de uno, cada componente quitado (ablación) y el universo
//   alternativo si se registró;
// - controles, que no son estrategias candidatas y no cuentan en N: el control aleatorio de 1000 simulaciones, la señal
//   desplazada y el paseo aleatorio (velas barajadas, datos sintéticos).
// Los controles se evalúan con el simulador de operaciones si su réplica se aleja como mucho un 10 % del Sharpe del
// backtester; si no, las mismas colocaciones se repiten con el backtester real (una estrategia programada por colocación).
// Los backtests los hace el ejecutor (research-runner.ts, el único que llama a runBacktest) a través de `run`. Solo se
// recoge como «sin medir» lo que no se puede construir (una variante con un parámetro que la regla rechaza, o un control
// sin operaciones que imitar); cualquier otro error lanza y el experimento queda «fallido».
// Con un barrido (paso 28, ADR 0032), cada tramo tiene su configuración, la elegida en su train: todas las variantes y
// los controles se aplican a la de cada tramo, y el PBO de la familia se mide con todos los puntos de la rejilla.
import type { PricePoint } from '../analytics/benchmark.ts';
import type { AblationVariant, ControlMethod, CriteriaEvidence, Measured, SensitivityVariant, StressRun } from '../analytics/criteria.ts';
import { AnalyticsError, cagrOf, drawdownOf, periodReturns, periodsPerYear, sharpeOf } from '../analytics/performance.ts';
import {
  percentileOf, RANDOM_CONTROL_SIMULATIONS, randomPlacements, replicaDeviation, shiftedPlacements, SIGNAL_SHIFTS, simulatedSharpe, simulatorValid,
  summarizeControl, type ControlMarket, type ControlSummary, type ControlTrade,
} from '../analytics/random-control.ts';
import type { RunReport, RunSeries } from '../analytics/report.ts';
import {
  bestAsset, parameterVariants, pboAcross, perturbed, withoutBestYear, type ConfigurationSeries, type ParameterVariant, type PboOutcome,
} from '../analytics/robustness.ts';
import { CRISIS_WINDOWS, regimeMeasures, windowResult } from '../analytics/windows.ts';
import { INTRABAR_POLICY } from '../backtest/intrabar.ts';
import type { FeatureSet } from '../features/types.ts';
import type { HistoricalCandle } from '../historical/types.ts';
import type { RegimeView } from '../kernel/regime.ts';
import { seededRng } from '../kernel/random.ts';
import { Decimal } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { Timeframe, UtcMillis } from '../shared/time.ts';
import { delayed } from '../strategy/delay.ts';
import { scheduled } from '../strategy/scheduled.ts';
import type { Strategy } from '../strategy/types.ts';
import type { BacktestResult } from './backtest.ts';
import { shuffledCandles } from './smoke-data.ts';

/** Variantes de estrés de A.3.3 y A.3.7: costes ×2, costes ×3 y retraso de una vela. */
export const STRESS_VARIANTS = 3;
const SHIFT_BARS = 1;
// Stop de la estrategia programada del control con el backtester: lejano, para que casi nunca acorte una operación.
const CONTROL_STOP_FRACTION = 0.25;

export class EvidenceError extends Error {
  override readonly name = 'EvidenceError';
}

/** Un backtest por tramo de validación: lo que devuelve el ejecutor. */
export interface FoldRun {
  readonly from: UtcMillis;
  readonly to: UtcMillis;
  readonly result: BacktestResult;
  readonly survivorshipBias: string | null;
}

export interface KitVariant<P> {
  readonly strategy: Strategy<P>;
  readonly params: P;
  readonly featureSet: FeatureSet;
}

export interface RunOptions {
  readonly symbols: readonly SymbolId[];
  readonly multiplier: number;
  readonly candles?: readonly HistoricalCandle[]; // otras velas (el paseo aleatorio); por defecto, las registradas
}

/** Cómo construir las variantes de sensibilidad de una estrategia; sin esto, A.3.8 queda sin medir. */
export interface SensitivitySpec<P> {
  readonly integers: readonly string[];
  readonly build: (values: Readonly<Record<string, unknown>>) => KitVariant<P>; // lanza si un valor no vale
}

/** Componentes que la ablación puede quitar y cómo construir la regla sin cada uno; sin esto, A.3.14 queda sin medir. */
export interface AblationSpec<P> {
  readonly components: readonly string[];
  readonly build: (component: string, values: Readonly<Record<string, unknown>>) => KitVariant<P>; // con los parámetros del tramo
}

export interface RobustnessPlan {
  readonly sensitivity: readonly ParameterVariant[];
  readonly bestAsset: boolean;
  readonly ablation: readonly string[];
  readonly alternatives: readonly string[];
  readonly total: number; // las «variantes» que el registro tiene que declarar
}

export interface PlanInput {
  readonly values: Readonly<Record<string, unknown>>;
  readonly integers: readonly string[] | null; // null: sin constructor de variantes de sensibilidad
  readonly symbols: readonly string[];
  readonly components: readonly string[] | null; // null: sin ablación declarada
  readonly alternatives: readonly string[];
}

/** Ejecuciones de robustez que cuentan en N para estos parámetros, este universo, esta ablación y este universo alternativo. */
export function robustnessPlan(input: PlanInput): RobustnessPlan {
  const sensitivity = input.integers === null ? [] : parameterVariants(input.values, new Set(input.integers));
  const best = input.symbols.length > 1;
  const ablation = input.components ?? [];
  const total = STRESS_VARIANTS + sensitivity.length + (best ? 1 : 0) + ablation.length + (input.alternatives.length > 0 ? 1 : 0);
  return Object.freeze({ sensitivity: Object.freeze(sensitivity), bestAsset: best, ablation, alternatives: input.alternatives, total });
}

/** Estabilidad del parámetro elegido en train en un barrido (A.3.8), por parámetro con más de un valor en la rejilla. */
export interface SweepStability {
  readonly param: string;
  readonly stability: number | null;
}

export interface EvidenceContext<P> {
  readonly family: string;
  readonly seed: number;
  readonly symbols: readonly SymbolId[];
  readonly multiplier: number;
  readonly timeframe: Timeframe;
  readonly params: Readonly<Record<string, unknown>>; // los registrados, para las cifras significativas (con rejilla, todos sus valores)
  readonly chosen: readonly Readonly<Record<string, unknown>>[]; // los de cada tramo: los registrados, o los elegidos en su train
  readonly configuration: string; // id de la configuración en la matriz del PBO
  readonly base: { readonly kits: readonly KitVariant<P>[]; readonly folds: readonly FoldRun[]; readonly report: RunReport; readonly series: RunSeries };
  readonly grid: readonly ConfigurationSeries[]; // fuera de muestra, cada punto de la rejilla (vacía sin barrido)
  readonly sweep: readonly SweepStability[] | null; // null: sin barrido
  readonly candles: readonly HistoricalCandle[]; // las del universo
  readonly regimes: readonly RegimeView[];
  readonly regimeSymbol: string;
  readonly costRate: number; // por lado, con el multiplicador: el del control aleatorio
  readonly maxStaleMs: number;
  readonly sensitivity: SensitivitySpec<P> | null;
  readonly ablation: AblationSpec<P> | null;
  readonly plan: RobustnessPlan;
  readonly simulations: number; // del control aleatorio: RANDOM_CONTROL_SIMULATIONS en los experimentos
  readonly shifts: number; // de la señal desplazada: SIGNAL_SHIFTS en los experimentos
  readonly run: <Q>(kits: readonly KitVariant<Q>[], options: RunOptions) => readonly FoldRun[]; // una regla por tramo
}

/** Por qué A.3.6 entre familias no se mide en un experimento con barrido: la matriz de la ronda se junta aparte. */
export const GLOBAL_DSR_AT_DECISION = 'el DSR global se calcula en la decisión, con todas las pruebas del registro (ADR 0039)';
export const ROUND_MATRIX_PENDING = 'la matriz de la ronda, con las configuraciones de todas las familias, se junta con las salidas guardadas antes del paso 31';

/** Lo que el ejecutor fija de un control; las pruebas pueden bajar los números para ir deprisa. */
export const CONTROL_COUNTS = Object.freeze({ simulations: RANDOM_CONTROL_SIMULATIONS, shifts: SIGNAL_SHIFTS });

const ok = <T>(value: T): Measured<T> => ({ ok: true, value });
const missing = <T>(reason: string): Measured<T> => ({ ok: false, reason });

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function num(text: string): number {
  return Decimal.parse(text).toAnalysis();
}

/** Rentabilidades netas por periodo de los tramos, con la liquidación en el último punto, como el informe. */
function foldReturns(fold: FoldRun): number[] {
  const { result } = fold;
  const curve = result.analysis.curve;
  return periodReturns([num(result.metrics.startEquity), ...curve.slice(0, -1).map((p) => p.equity), num(result.metrics.endEquity)]);
}

function annualSharpe(returns: readonly number[], perYear: number): number | null {
  const { sharpe } = sharpeOf(returns);
  return sharpe === null ? null : sharpe * Math.sqrt(perYear);
}

/** Sharpe anualizado y P&L neto de un run de robustez. */
export function stressRun(folds: readonly FoldRun[], perYear: number): StressRun {
  return Object.freeze({
    sharpe: annualSharpe(folds.flatMap(foldReturns), perYear),
    netPnl: folds.reduce((total, f) => total + num(f.result.metrics.endEquity) - num(f.result.metrics.startEquity), 0),
  });
}

function chained(returns: readonly number[]): number[] {
  const path = [1];
  for (const r of returns) path.push((path.at(-1) ?? 1) * (1 + r));
  return path;
}

/** Sharpe anualizado y Calmar de una serie de rentabilidades por periodo. */
function riskAdjusted(returns: readonly number[], perYear: number): { readonly sharpe: number | null; readonly calmar: number | null } {
  const path = chained(returns);
  const { maxDrawdown } = drawdownOf(path);
  const cagr = cagrOf(1, path.at(-1) ?? 1, returns.length, perYear);
  return Object.freeze({ sharpe: annualSharpe(returns, perYear), calmar: cagr === null || maxDrawdown === 0 ? null : cagr / maxDrawdown });
}

function lastAtOrBefore<T extends { readonly at: UtcMillis }>(points: readonly T[], t: UtcMillis): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid]?.at ?? Number.POSITIVE_INFINITY) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export interface ControlInputs {
  readonly market: ControlMarket;
  readonly trades: readonly ControlTrade[];
  readonly marks: readonly (readonly UtcMillis[])[]; // instante de cada marca de cada tramo
}

/** Mercado, operaciones y marcas del control aleatorio, desde los tramos de un run y sus velas. */
export function controlInputs(folds: readonly FoldRun[], candles: readonly HistoricalCandle[], symbols: readonly SymbolId[], costRate: number, perYear: number, maxStaleMs: number): ControlInputs {
  const closes = new Map<string, PricePoint[]>(symbols.map((s) => [s, []]));
  for (const c of [...candles].sort((a, b) => a.closeTime - b.closeTime)) closes.get(c.symbol)?.push({ at: c.closeTime, close: c.close.toAnalysis() });
  const trades: ControlTrade[] = [];
  const marketFolds = folds.map((fold, f) => {
    const curve = fold.result.analysis.curve;
    const prices = new Map<string, (number | null)[]>();
    for (const [symbol, points] of closes) {
      prices.set(symbol, curve.map((p) => {
        const point = points[lastAtOrBefore(points, p.at)];
        return point !== undefined && p.at - point.at <= maxStaleMs ? point.close : null;
      }));
    }
    for (const trip of fold.result.roundTrips) {
      const start = Math.max(0, lastAtOrBefore(curve, trip.openedAt));
      const end = trip.closedAt === null ? curve.length - 1 : lastAtOrBefore(curve, trip.closedAt);
      const bars = Math.min(Math.max(1, end - start), curve.length - 1 - start);
      const equity = curve[start]?.equity ?? 0;
      if (bars < 1 || !(equity > 0)) continue; // abierta en la última marca del tramo: no ocupa ningún periodo
      trades.push({ symbol: trip.symbol, fold: f, start, bars, fraction: num(trip.cost) / equity });
    }
    return { bars: curve.length, prices };
  });
  return { market: { folds: marketFolds, costRate, perYear }, trades, marks: folds.map((f) => f.result.analysis.curve.map((p) => p.at)) };
}

/** Sharpe de cada colocación con el backtester real: una estrategia programada que entra y sale en sus marcas. */
function backtestSharpes(ctx: Pick<EvidenceContext<unknown>, 'timeframe' | 'run'>, placements: readonly (readonly ControlTrade[])[], marks: ControlInputs['marks'], options: RunOptions): (number | null)[] {
  const perYear = periodsPerYear(ctx.timeframe);
  return placements.map((placement) => {
    const trades = placement.map((t) => {
      const at = marks[t.fold] ?? [];
      const enterAt = at[t.start];
      const exitAt = at[t.start + t.bars];
      if (enterAt === undefined || exitAt === undefined) throw new EvidenceError(`colocación fuera de las marcas del tramo ${String(t.fold)}`);
      return { symbol: t.symbol, enterAt, exitAt };
    });
    const kit = scheduled({ trades, stopFraction: CONTROL_STOP_FRACTION }, ctx.timeframe);
    return stressRun(ctx.run(marks.map(() => kit), options), perYear).sharpe;
  });
}

export type ControlContext = Pick<EvidenceContext<unknown>, 'seed' | 'symbols' | 'costRate' | 'timeframe' | 'maxStaleMs' | 'simulations' | 'run'>;

/** Flujo de azar del control aleatorio de A.3.12; las curvas que se guardan para el dashboard (control-curves.ts) usan el mismo. */
export const RANDOM_CONTROL_STREAM = 'control-aleatorio';

export interface ControlOutcome {
  readonly inputs: ControlInputs;
  readonly method: ControlMethod;
  readonly summary: ControlSummary;
  readonly replica: number | null;
  readonly deviation: number | null;
  readonly simulatorP95: number;
}

/**
 * Control aleatorio de un run: colocaciones al azar evaluadas con el simulador; si su réplica se aleja más de un 10 % del
 * Sharpe del backtester (`actual`), las mismas colocaciones se evalúan con el backtester real.
 */
export function randomControlOf(ctx: ControlContext, folds: readonly FoldRun[], candles: readonly HistoricalCandle[], stream: string, actual: number | null, options: RunOptions): Measured<ControlOutcome> {
  const perYear = periodsPerYear(ctx.timeframe);
  const inputs = controlInputs(folds, candles, ctx.symbols, ctx.costRate, perYear, ctx.maxStaleMs);
  try {
    const placements = randomPlacements(inputs.market, inputs.trades, ctx.simulations, seededRng(ctx.seed, stream));
    const simulator = summarizeControl(placements.map((p) => simulatedSharpe(inputs.market, p)));
    const replica = simulatedSharpe(inputs.market, inputs.trades);
    const deviation = replicaDeviation(replica, actual);
    if (simulatorValid(replica, actual)) return ok({ inputs, method: 'simulador', summary: simulator, replica, deviation, simulatorP95: simulator.p95 });
    const summary = summarizeControl(backtestSharpes(ctx, placements, inputs.marks, options));
    return ok({ inputs, method: 'backtester', summary, replica, deviation, simulatorP95: simulator.p95 });
  } catch (e) {
    if (e instanceof AnalyticsError) return missing(errorText(e));
    throw e;
  }
}

/** Corre una variante (una regla por tramo) que puede no construirse: lo que lanza al construirla queda como «sin medir». */
function variant<P>(ctx: EvidenceContext<P>, build: () => readonly KitVariant<P>[], options: RunOptions): Measured<StressRun> {
  let kits: readonly KitVariant<P>[];
  try {
    kits = build();
  } catch (e) {
    return missing(errorText(e));
  }
  return ok(stressRun(ctx.run(kits, options), periodsPerYear(ctx.timeframe)));
}

function median(values: readonly number[]): number {
  return summarizeControl(values).median;
}

/** Tiempo en mercado y exposición media (posiciones que no son polvo entre patrimonio) de los tramos de un run. */
function exposureOf(folds: readonly FoldRun[]): NonNullable<AblationVariant['exposure']> {
  const samples = folds.flatMap((f) => f.result.analysis.curve).filter((p) => p.equity > 0);
  if (samples.length === 0) return { timeInMarket: null, meanExposure: null };
  return {
    timeInMarket: samples.filter((p) => p.exposureWithoutDust > 0).length / samples.length,
    meanExposure: samples.reduce((total, p) => total + p.exposureWithoutDust / p.equity, 0) / samples.length,
  };
}

/**
 * Ablación con la exposición controlada (ADR 0037): la regla sin el componente, con su propio control aleatorio de sus
 * mismas operaciones y duraciones. Cuenta su exceso de Sharpe sobre la mediana de ese control, que descuenta lo que gana
 * cualquier colocación al azar con esa exposición. Si la regla no se puede construir sin él, queda «sin medir».
 */
function ablationVariant<P>(ctx: EvidenceContext<P>, component: string, options: RunOptions): AblationVariant {
  const spec = ctx.ablation;
  let kits: readonly KitVariant<P>[];
  try {
    if (spec === null) throw new EvidenceError('sin constructor de la ablación');
    kits = ctx.chosen.map((values) => spec.build(component, values));
  } catch (e) {
    return { component, sharpe: missing(errorText(e)), excess: missing(errorText(e)), exposure: null };
  }
  const folds = ctx.run(kits, options);
  const { sharpe } = stressRun(folds, periodsPerYear(ctx.timeframe));
  const control = randomControlOf(ctx as EvidenceContext<unknown>, folds, ctx.candles, `control-ablacion-${component}`, sharpe, options);
  let excess: Measured<number | null>;
  if (sharpe === null) excess = ok(null);
  else excess = control.ok ? ok(sharpe - control.value.summary.median) : missing(`control sin medir: ${control.reason}`);
  return { component, sharpe: ok(sharpe), excess, exposure: exposureOf(folds) };
}

/** PBO dentro de la familia y entre familias: sin barrido, una sola configuración; con barrido, todos sus puntos. */
function pboOf(ctx: Pick<EvidenceContext<unknown>, 'grid'>, own: ConfigurationSeries): CriteriaEvidence['pbo'] {
  if (ctx.grid.length < 2) return { family: pboAcross([own]), global: pboAcross([own]) };
  const global: PboOutcome = { measured: false, configurations: ctx.grid.length, reason: ROUND_MATRIX_PENDING };
  return { family: pboAcross(ctx.grid), global };
}

export function criteriaEvidence<P>(ctx: EvidenceContext<P>): CriteriaEvidence {
  const perYear = periodsPerYear(ctx.timeframe);
  const { kits, folds, report, series } = ctx.base;
  if (kits.length !== folds.length || ctx.chosen.length !== folds.length) throw new EvidenceError('hace falta una regla y unos parámetros por tramo');
  const full = { symbols: ctx.symbols, multiplier: ctx.multiplier };
  const ranges = folds.map((f) => ({ from: f.from, to: f.to }));
  const loose = ctx as EvidenceContext<unknown>;

  const integers = new Set(ctx.sensitivity?.integers ?? []);
  const sensitivity: SensitivityVariant[] = ctx.sensitivity === null ? [] : ctx.plan.sensitivity.map((v) => {
    const spec = ctx.sensitivity;
    const measured = spec === null
      ? missing<StressRun>('sin constructor de variantes')
      : variant(ctx, () => ctx.chosen.map((values) => spec.build(perturbed(values, v.param, v.step, integers))), full);
    return { param: v.param, step: v.step, sharpe: measured.ok ? ok(measured.value.sharpe) : missing(measured.reason) };
  });
  if (sensitivity.length !== ctx.plan.sensitivity.length) throw new EvidenceError('las variantes de sensibilidad no son las del plan');

  const ablation: AblationVariant[] = ctx.plan.ablation.map((component) => ablationVariant(ctx, component, full));

  const best = bestAsset(report.breakdown.byAsset);
  let withoutBest: CriteriaEvidence['withoutBestAsset'];
  if (!ctx.plan.bestAsset) withoutBest = missing('universo de un solo activo');
  else if (best === null) withoutBest = missing('sin operaciones cerradas: no hay mejor activo');
  else withoutBest = ok({ asset: best, sharpe: stressRun(ctx.run(kits, { ...full, symbols: ctx.symbols.filter((s) => s !== best) }), perYear).sharpe });

  const alternatives = ctx.plan.alternatives;
  const alternativeUniverse: CriteriaEvidence['alternativeUniverse'] = alternatives.length === 0
    ? missing('sin universo alternativo pre-registrado (universo.alternativos)')
    : ok({ symbols: alternatives.join(', '), sharpe: stressRun(ctx.run(kits, { ...full, symbols: alternatives }), perYear).sharpe });

  const sharpe = report.summary.sharpeAnnualized;
  const real = randomControlOf(loose, folds, ctx.candles, RANDOM_CONTROL_STREAM, sharpe, full);
  let shifted: CriteriaEvidence['smoke']['shifted'];
  if (!real.ok) shifted = missing(real.reason);
  else {
    const { inputs, method, deviation, summary } = real.value;
    const placements = shiftedPlacements(inputs.market, inputs.trades, ctx.shifts, seededRng(ctx.seed, 'senal-desplazada'));
    const values = method === 'simulador' ? placements.map((p) => simulatedSharpe(inputs.market, p)) : backtestSharpes(loose, placements, inputs.marks, full);
    shifted = ok({ method, deviation, median: median(values.map((v) => v ?? 0)), p95: summary.p95 });
  }

  const walkCandles = shuffledCandles(ctx.candles, seededRng(ctx.seed, 'paseo-aleatorio'));
  const walkOptions = { ...full, candles: walkCandles };
  const walkFolds = ctx.run(kits, walkOptions);
  const walkSharpe = stressRun(walkFolds, perYear).sharpe;
  const walk = randomControlOf(loose, walkFolds, walkCandles, 'control-paseo-aleatorio', walkSharpe, walkOptions);

  // A.3.9, frente a BTC escalado por la exposición de la estrategia, sin polvo, en toda la serie y en cada régimen (ADR
  // 0042); A.3.7, con el buy-and-hold de todo el capital.
  const regime = regimeMeasures({ records: series.records, regimes: ctx.regimes, folds: ranges, perYear });

  const own = configurationSeries(ctx);
  const universe = series.universe === null
    ? (ctx.symbols.length === 1 && ctx.symbols[0] === ctx.regimeSymbol ? ok(riskAdjusted(series.benchmark, perYear)) : missing<{ sharpe: number | null; calmar: number | null }>('sin buy-and-hold equiponderado del universo'))
    : ok(riskAdjusted(series.universe, perYear));

  const evidence: CriteriaEvidence = {
    family: ctx.family,
    sharpe,
    netPnl: report.summary.netPnl,
    calmar: report.summary.calmar,
    foldSharpes: series.perFold.map((r) => annualSharpe(r, perYear)),
    maxDrawdown: report.summary.maxDrawdown,
    bootstrap: { sharpe: report.bootstrap.sharpeAnnualized, maxDrawdown: report.bootstrap.maxDrawdown, excessSharpe: report.bootstrap.excessSharpeAnnualized },
    intervalLongRun: report.sharpeIntervalLongRun,
    closedTrades: report.summary.trades.closed,
    dsrFamily: report.deflatedSharpe,
    dsrGlobal: missing(GLOBAL_DSR_AT_DECISION),
    bearEpisodes: regime.bearEpisodes,
    crisisWindows: CRISIS_WINDOWS.map((w) => windowResult(w, series.records, ranges)),
    bull: regime.bull,
    lateral: regime.lateral,
    regimeExposure: regime.regimeExposure,
    regimeOwn: regime.own,
    costs2: variant(ctx, () => kits, { ...full, multiplier: ctx.multiplier * 2 }),
    costs3: variant(ctx, () => kits, { ...full, multiplier: ctx.multiplier * 3 }),
    delay: variant(ctx, () => kits.map((k) => ({ ...delayed(k.strategy, k.featureSet, SHIFT_BARS), params: k.params })), full),
    intrabarPolicy: INTRABAR_POLICY,
    params: ctx.params,
    sensitivity: ctx.sensitivity === null ? missing('la estrategia no declara cómo construir sus variantes de parámetros') : ok(sensitivity),
    sweep: ctx.sweep,
    benchmarks: { btc: riskAdjusted(series.benchmark, perYear), universe },
    randomControl: real.ok
      ? ok({
        method: real.value.method,
        simulations: real.value.summary.simulations,
        p95: real.value.summary.p95,
        median: real.value.summary.median,
        percentile: sharpe === null ? null : percentileOf(real.value.summary.sharpes, sharpe),
        replica: real.value.replica,
        deviation: real.value.deviation,
        simulatorP95: real.value.method === 'backtester' ? real.value.simulatorP95 : null,
      })
      : missing(real.reason),
    ablation: ctx.ablation === null ? missing('la estrategia no declara su ablación') : ok(ablation),
    alternativeUniverse,
    withoutBestYear: withoutBestYear(series.records, perYear),
    withoutBestAsset: withoutBest,
    pbo: pboOf(loose, own),
    smoke: {
      shifted,
      randomWalk: walk.ok
        ? ok({ method: walk.value.method, deviation: walk.value.deviation, replica: walk.value.replica, sharpe: walkSharpe, p95: walk.value.summary.p95 })
        : missing(`paseo aleatorio: ${walk.reason}`),
    },
  };
  return Object.freeze(evidence);
}

/** Serie fuera de muestra de la configuración: la de la matriz del PBO (A.3.6), que la decisión del paso 31 junta por ronda. */
export function configurationSeries(ctx: { readonly configuration: string; readonly family: string; readonly base: { readonly series: RunSeries } }): ConfigurationSeries {
  return Object.freeze({ id: ctx.configuration, family: ctx.family, times: ctx.base.series.records.map((r) => r.end), returns: ctx.base.series.returns });
}
