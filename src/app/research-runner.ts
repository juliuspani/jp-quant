// Ejecutor de experimentos del backtester (paso 23): todo run pasa por el Experiment Registry. runExperiment lo llama con
// la línea ya registrada y con los datos comprobados contra su hash (ADR 0024); el ejecutor hace un backtest por cada
// tramo de validación, fuera de muestra, y devuelve métricas netas de costes con la declaración del modelo de ejecución.
// Las métricas quedan en la línea de cierre del registro, también esa declaración y el sesgo de supervivencia si lo hay.
// Es el único código de src/ que llama a runBacktest (test/invariants/backtest-registry.test.ts, INV-14a).
//
// Desde el paso 26 (ADR 0029), el informe de analytics/ resume la concatenación de los tramos, en EUR: métricas de
// rendimiento, Deflated Sharpe con el N de la familia, IC del bootstrap por bloques, alfa y beta frente al buy-and-hold
// de BTC y desgloses por activo, año, estrategia y régimen de BTC. Va entero en la salida y sus cifras principales, en
// las métricas del cierre.
//
// Desde el paso 27B (ADR 0031), el ejecutor mide los criterios congelados del paso 27 (docs/PROMOTION_CRITERIA.md, A.3)
// y da el veredicto de quant-research §11: hace las variantes de robustez que el registro declara en «variantes» (cuentan
// en N), los controles (no cuentan) y la evaluación de analytics/criteria.ts. El informe de criterios va entero en la
// salida, con la huella de los documentos congelados, y el estado de cada criterio en las métricas.
//
// Desde el paso 28 (ADR 0032), un barrido pre-registrado (una rejilla de como mucho MAX_GRID_CONFIGURATIONS puntos) se
// resuelve con walk-forward: en cada tramo, cada punto se puntúa en su train, con el purging y el embargo registrados, y
// el mejor se mide en su validación. La serie fuera de muestra es la de lo elegido en cada tramo; además, cada punto se
// mide en todos los tramos de validación para el PBO de la familia (A.3.6) y la V[SRₙ] del DSR. Las variantes de
// robustez y los controles se aplican a lo elegido en cada tramo.
//
// Desde el paso 31 (ADR 0044), un experimento puede solo elegir en train: la elección de cada tramo, con el mismo código,
// sin medir ninguna validación ni dar veredicto. Así elige la comprobación hacia delante de A (ADR 0043) la configuración
// de su último tramo, que valida en el periodo del test final, con los datos registrados y sin leer ese periodo.
import type { BenchmarkCurve, PricePoint } from '../analytics/benchmark.ts';
import { buyAndHold } from '../analytics/benchmark.ts';
import { evaluateCriteria, type CriteriaReport } from '../analytics/criteria.ts';
import { periodsPerYear } from '../analytics/performance.ts';
import { priceRegime, regimeSeries } from '../analytics/regime.ts';
import { analyzeRun, runSeries, type FoldData, type RunReport } from '../analytics/report.ts';
import { sweepStability, type ConfigurationSeries } from '../analytics/robustness.ts';
import { chooseConfiguration, runPeriods, trainScore, trainWindows, type TrainWindow } from '../analytics/selection.ts';
import type { ConfidenceInterval } from '../analytics/statistics.ts';
import { executionCosts, type CostSpec } from '../backtest/costs.ts';
import type { HistoricalCandle } from '../historical/types.ts';
import { limitedUniverseAt } from '../historical/universe.ts';
import { seededRng } from '../kernel/random.ts';
import { FAMILY_SHARPE, runnerKey, type RunInput, type RunOutput, type Runner } from '../research/experiment.ts';
import { gridPoints, type Metricas } from '../research/registry.ts';
import { canonicalJson, sha256Hex } from '../shared/canonical.ts';
import { Decimal } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import { addMs, parseUtcIso, timeframeMs, toUtcIso, type Timeframe, type UtcMillis } from '../shared/time.ts';
import type { StrategyKit } from '../strategy/baselines.ts';
import { acceptedParams, literatureGrid, MAX_GRID_CONFIGURATIONS, STRATEGY_LIBRARY, variantParams, type LibraryEntry } from '../strategy/library.ts';
import type { Strategy } from '../strategy/types.ts';
import { journalText, runBacktest, type BacktestResult } from './backtest.ts';
import { controlCurves } from './control-curves.ts';
import {
  CONTROL_COUNTS, configurationSeries, criteriaEvidence, robustnessPlan,
  type AblationSpec, type FoldRun, type KitVariant, type RunOptions, type SensitivitySpec, type SweepStability,
} from './criteria-evidence.ts';
import { isMarketHistory, type MarketHistory } from './datasets.ts';

type Values = Readonly<Record<string, unknown>>;

/** Una estrategia dada de alta para investigar: valida sus parámetros registrados y monta la regla con ellos. */
export interface StrategyEntry<P> {
  readonly strategy: Strategy<P>; // identidad: nombre y versión del registro
  readonly configure: (values: Values) => KitVariant<P>; // lanza si los valores registrados no valen
  readonly grid?: (rejilla: Readonly<Record<string, readonly unknown[]>>) => void; // lanza si no admite la rejilla; sin esto, ningún barrido
  readonly sensitivity?: SensitivitySpec<P>; // variantes de A.3.8; sin esto, el criterio queda sin medir
  readonly ablation?: AblationSpec<P>; // componentes de A.3.14; sin esto, la ablación queda sin medir
}

/** Capital inicial de los experimentos: el tope de capital del bot (ADR 0017), en la moneda de cotización. */
export const RESEARCH_CAPITAL = '1000';
export const RESEARCH_QUOTE = 'EUR';
/** Símbolo del régimen de mercado y del benchmark (quant-research §6): BTC en EUR, del mismo dataset registrado. */
export const REGIME_SYMBOL = 'BTC/EUR';
/** Remuestreos del bootstrap: el mínimo de quant-research §8. */
export const BOOTSTRAP_RESAMPLES = 10_000;
// Antigüedad máxima del último cierre al marcar el benchmark, en velas: más es un hueco o una baja, y lanza.
const BENCHMARK_STALE_BARS = 3;
// Risk anota el commit en cada decisión; el de un experimento está en su línea del registro, no en RunInput.
const RISK_COMMIT = 'registro';

export class RunnerError extends Error {
  override readonly name = 'RunnerError';
}

function at<T>(list: readonly T[], i: number, what: string): T {
  const value = list[i];
  if (value === undefined) throw new RunnerError(`${what} ${String(i)} no existe`);
  return value;
}

function sum(values: readonly string[]): string {
  return values.reduce((total, value) => total.plus(Decimal.parse(value)), Decimal.parse('0')).toString();
}

function num(text: string): number {
  return Decimal.parse(text).toAnalysis();
}

function interval(prefix: string, ci: ConfidenceInterval | null): Record<string, number | null> {
  return { [`${prefix}_inferior`]: ci?.lower ?? null, [`${prefix}_superior`]: ci?.upper ?? null };
}

/** Cifras principales del informe para la línea de cierre: planas, finitas o null. */
function reportMetrics(report: RunReport): Metricas {
  const { summary: s, deflatedSharpe: dsr, bootstrap: b } = report;
  return {
    moneda: s.currency,
    periodos: s.periods,
    pnl_neto: s.netPnl,
    rentabilidad_encadenada: s.chainedReturn,
    cagr: s.cagr,
    volatilidad_anualizada: s.volatilityAnnualized,
    [FAMILY_SHARPE]: s.sharpe,
    sharpe_anualizado: s.sharpeAnnualized,
    sortino_anualizado: s.sortinoAnnualized,
    asimetria: s.skewness,
    curtosis: s.kurtosis,
    caida_maxima: s.maxDrawdown,
    duracion_caida_maxima: s.maxDrawdownDuration,
    calmar: s.calmar,
    var_95: s.tail?.valueAtRisk95 ?? null,
    expected_shortfall_95: s.tail?.expectedShortfall95 ?? null,
    peor_periodo: s.tail?.worstPeriod ?? null,
    tiempo_en_mercado: s.timeInMarket,
    exposicion_media: s.meanExposure,
    rotacion: s.turnover,
    rotacion_anual: s.turnoverAnnual,
    costes_implicitos: s.implicitCosts,
    costes_totales: s.totalCosts,
    profit_factor: s.trades.profitFactor,
    esperanza: s.trades.expectancy,
    tasa_acierto: s.trades.hitRate,
    ganancia_perdida: s.trades.winLossRatio,
    btc_rentabilidad_encadenada: s.benchmark.chainedReturn,
    btc_sharpe_anualizado: s.benchmark.sharpeAnnualized,
    universo_rentabilidad_encadenada: s.benchmark.universeChainedReturn,
    alfa_anual: s.alphaBeta?.alphaAnnualized ?? null,
    beta: s.alphaBeta?.beta ?? null,
    exceso_sharpe_anualizado: s.excessSharpeAnnualized,
    n_familia: dsr?.trials ?? null,
    dsr: dsr?.dsr ?? null,
    sr0: dsr?.sr0 ?? null,
    psr: dsr?.psr ?? null,
    mintrl: dsr?.minTrackRecord ?? null,
    bootstrap_bloque_medio: b.meanBlock,
    ...interval('ic95_sharpe_anualizado', b.sharpeAnnualized),
    ...interval('ic95_cagr', b.cagr),
    ...interval('ic95_caida_maxima', b.maxDrawdown),
    ...interval('ic95_exceso_sharpe', b.excessSharpeAnnualized),
  };
}

/** Estado de cada criterio y el PBO para la línea de cierre; el informe entero va en la salida. */
function criteriaMetrics(criteria: CriteriaReport): Metricas {
  const out: Metricas = {};
  for (const c of criteria.criteria) out[`criterio_${c.id}`] = c.status;
  const pbo = criteria.criteria.find((c) => c.id === 'A.3.6')?.value['pbo_familia'];
  out['pbo'] = typeof pbo === 'number' ? pbo : null;
  return out;
}

/** Lo elegido en el train de un tramo: los parámetros y su Sharpe en train (dentro de muestra: se informa, no decide). */
interface Chosen {
  readonly values: Values;
  readonly trainSharpe: number | null;
}

function metrics(input: RunInput, folds: readonly FoldRun[], report: RunReport, criteria: CriteriaReport, configurations: number, selected: readonly Chosen[] | null): Metricas {
  const results = folds.map((f) => f.result);
  const biases = [...new Set(folds.flatMap((f) => (f.survivorshipBias === null ? [] : [f.survivorshipBias])))];
  const halted = results.find((r) => r.halted !== null)?.halted ?? null;
  const declaration = results[0]?.execution.declaration ?? null;
  const perFold: Record<string, string | number | null> = {};
  folds.forEach((fold, i) => {
    perFold[`tramo_${String(i)}_rentabilidad_neta`] = fold.result.metrics.netReturn;
    perFold[`tramo_${String(i)}_caida_maxima`] = fold.result.metrics.maxDrawdown;
    perFold[`tramo_${String(i)}_operaciones_cerradas`] = fold.result.metrics.closedTrades;
    perFold[`tramo_${String(i)}_sharpe_anualizado`] = fold.result.performance.sharpeAnnualized;
    perFold[`tramo_${String(i)}_costes_sobre_capital`] = fold.result.performance.costReturn;
    const choice = selected?.[i];
    if (choice !== undefined) {
      perFold[`tramo_${String(i)}_elegida`] = canonicalJson(choice.values);
      perFold[`tramo_${String(i)}_sharpe_train`] = choice.trainSharpe;
    }
  });
  return {
    capital_inicial: RESEARCH_CAPITAL,
    comision: input.costes.comision,
    medio_spread: input.costes.spread,
    slippage_minimo: input.costes.slippage,
    multiplicador_costes: input.costes.multiplicador,
    tramos: folds.length,
    configuraciones: configurations,
    variantes: input.variantes,
    operaciones_cerradas: results.reduce((n, r) => n + r.metrics.closedTrades, 0),
    operaciones_ganadoras: results.reduce((n, r) => n + r.metrics.winningTrades, 0),
    comisiones_pagadas: sum(results.map((r) => r.metrics.feesPaid)),
    libro_de_ordenes: results.some((r) => r.execution.bookData) ? 'real' : 'sintético',
    modelo_de_ejecucion: declaration,
    sesgo_de_supervivencia: biases.length === 0 ? null : biases.join(' '),
    detenido: halted,
    ...perFold,
    ...reportMetrics(report),
    ...criteriaMetrics(criteria),
  };
}

function pricesOf(candles: readonly HistoricalCandle[], symbols: readonly SymbolId[]): Map<string, PricePoint[]> {
  const prices = new Map<string, PricePoint[]>(symbols.map((s) => [s, []]));
  for (const c of [...candles].sort((a, b) => a.closeTime - b.closeTime)) prices.get(c.symbol)?.push({ at: c.closeTime, close: c.close.toAnalysis() });
  return prices;
}

interface BenchmarkPrices {
  readonly btc: ReadonlyMap<string, readonly PricePoint[]>;
  readonly universe: ReadonlyMap<string, readonly PricePoint[]> | null;
  readonly costRate: number;
  readonly maxStaleMs: number;
}

function foldData(fold: FoldRun, strategy: string, prices: BenchmarkPrices): FoldData {
  const { result } = fold;
  const capital = num(result.metrics.startEquity);
  const samples = result.analysis.curve.map((p) => p.at);
  const bench = (series: ReadonlyMap<string, readonly PricePoint[]>): BenchmarkCurve =>
    buyAndHold({ prices: series, from: fold.from, samples, capital, costRate: prices.costRate, maxStaleMs: prices.maxStaleMs });
  return {
    from: fold.from,
    to: fold.to,
    startEquity: capital,
    endEquity: num(result.metrics.endEquity),
    curve: result.analysis.curve,
    fills: result.analysis.fills,
    liquidationCost: result.analysis.liquidationCost,
    trades: result.roundTrips.map((t) => ({
      symbol: t.symbol, strategy, openedAt: t.openedAt, closedAt: t.closedAt, invested: num(t.cost), pnl: t.pnl === null ? null : num(t.pnl),
    })),
    benchmark: bench(prices.btc),
    universeBenchmark: prices.universe === null ? null : bench(prices.universe),
  };
}

function benchmarkPrices(candles: readonly HistoricalCandle[], symbols: readonly SymbolId[], costs: CostSpec, timeframe: Timeframe): BenchmarkPrices {
  const effective = executionCosts(costs);
  return {
    btc: pricesOf(candles, [REGIME_SYMBOL]),
    universe: symbols.length > 1 ? pricesOf(candles, symbols) : null,
    costRate: effective.commission.plus(effective.halfSpread).plus(effective.minSlippage).toAnalysis(),
    maxStaleMs: BENCHMARK_STALE_BARS * timeframeMs(timeframe),
  };
}

/** Un backtest de una regla en [from, to), con un universo, un multiplicador de costes y unas velas. */
function windowRun<P>(input: RunInput, history: MarketHistory, candles: readonly HistoricalCandle[], kit: KitVariant<P>, options: RunOptions, from: UtcMillis, to: UtcMillis, label: string): BacktestResult {
  const { costes, estrategia } = input;
  const symbols = options.symbols;
  const own = (options.candles ?? candles).filter((c) => symbols.includes(c.symbol));
  const listings = new Map(
    history.listings.listings.filter((l) => symbols.includes(l.symbol)).map((l) => [l.symbol, { listedAt: l.listedAt, delistedAt: l.delistedAt }]),
  );
  // El calentamiento sale de los datos registrados: si empezara antes del rango, la ventana no estaría bien definida.
  const warmupFrom = addMs(from, -kit.strategy.warmupBars * timeframeMs(kit.featureSet.timeframe));
  if (warmupFrom < history.from) {
    throw new RunnerError(`${label}: el calentamiento empieza el ${toUtcIso(warmupFrom)}, antes del rango de datos (${toUtcIso(history.from)})`);
  }
  return runBacktest({
    runId: `${estrategia.nombre}@${estrategia.version}/${label}`,
    seed: input.semilla,
    commit: RISK_COMMIT,
    candles: own,
    listings,
    from,
    to,
    featureSet: kit.featureSet,
    strategy: kit.strategy,
    params: kit.params,
    costs: { commission: costes.comision, halfSpread: costes.spread, minSlippage: costes.slippage, multiplier: options.multiplier },
    startingCash: Decimal.parse(RESEARCH_CAPITAL),
    quoteCurrency: RESEARCH_QUOTE,
  });
}

/** Un backtest por tramo de validación, cada uno con su regla (la elegida en su train, o la misma en todos). */
function foldsOf<P>(input: RunInput, history: MarketHistory, candles: readonly HistoricalCandle[], kits: readonly KitVariant<P>[], options: RunOptions): FoldRun[] {
  const { tramos } = input.particiones;
  if (kits.length !== tramos.length) throw new RunnerError(`${String(kits.length)} reglas para ${String(tramos.length)} tramos`);
  return tramos.map((fold, i) => {
    const from = parseUtcIso(fold.validation.desde);
    const to = parseUtcIso(fold.validation.hasta);
    const kit = kits[i];
    if (kit === undefined) throw new RunnerError(`tramo ${String(i)} sin regla`);
    const result = windowRun(input, history, candles, kit, options, from, to, `tramo-${String(i)}`);
    return { from, to, result, survivorshipBias: limitedUniverseAt(history.listings, options.symbols, from).survivorshipBias };
  });
}

/** Elección en train de cada tramo de un barrido: ventanas con purging y embargo, Sharpe de cada punto y el elegido. */
interface Selection {
  readonly windows: readonly TrainWindow[];
  readonly scores: readonly (readonly (number | null)[])[]; // por tramo y punto de la rejilla
  readonly chosen: readonly number[]; // índice del punto elegido en cada tramo
}

function runPeriodsOf(from: UtcMillis, result: BacktestResult): ReturnType<typeof runPeriods> {
  return runPeriods({ from, startEquity: num(result.metrics.startEquity), endEquity: num(result.metrics.endEquity), curve: result.analysis.curve });
}

function selectInTrain<P>(input: RunInput, history: MarketHistory, candles: readonly HistoricalCandle[], kits: readonly KitVariant<P>[], options: RunOptions): Selection {
  const { particiones } = input;
  const bar = timeframeMs(history.timeframe);
  const range = (r: { readonly desde: string; readonly hasta: string }): { from: UtcMillis; to: UtcMillis } => ({ from: parseUtcIso(r.desde), to: parseUtcIso(r.hasta) });
  const windows = trainWindows(
    particiones.tramos.map((t) => ({ train: range(t.train), validation: range(t.validation) })),
    particiones.purging_velas * bar,
    particiones.embargo_velas * bar,
  );
  const perYear = periodsPerYear(history.timeframe);
  const scores = windows.map((w, i) => kits.map((kit, c) => {
    const result = windowRun(input, history, candles, kit, options, w.from, w.to, `train-${String(i)}-punto-${String(c)}`);
    return trainScore(runPeriodsOf(w.from, result), w, perYear);
  }));
  return { windows, scores, chosen: scores.map(chooseConfiguration) };
}

/** Serie fuera de muestra de una configuración en todos los tramos, como la del informe. */
function seriesOf(id: string, family: string, folds: readonly FoldRun[]): ConfigurationSeries {
  const periods = folds.flatMap((f) => runPeriodsOf(f.from, f.result));
  return Object.freeze({ id, family, times: periods.map((p) => p.end), returns: periods.map((p) => p.ret) });
}

/** Configuraciones del registro: la única con valores, o los puntos de una rejilla que la estrategia admite. */
function configurationsOf<P>(entry: StrategyEntry<P>, parametros: RunInput['parametros']): Values[] {
  if (parametros.tipo === 'rejilla') {
    if (entry.grid === undefined) throw new RunnerError(`${entry.strategy.id}@${entry.strategy.version} no admite barridos`);
    entry.grid(parametros.rejilla);
  }
  const points = gridPoints(parametros);
  if (points.length > MAX_GRID_CONFIGURATIONS) throw new RunnerError(`${String(points.length)} configuraciones: como mucho ${String(MAX_GRID_CONFIGURATIONS)} por estrategia`);
  return points;
}

/** Los parámetros registrados para las cifras significativas de A.3.8: con rejilla, cada uno de sus valores. */
function registeredParams(parametros: RunInput['parametros']): Values {
  if (parametros.tipo === 'valores') return parametros.valores;
  const flat: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(parametros.rejilla)) for (const v of values) flat[`${key}=${String(v)}`] = v;
  return flat;
}

/** Estabilidad del elegido en train (A.3.8) en cada parámetro con más de un valor; null sin barrido. */
function sweepOf(parametros: RunInput['parametros'], chosen: readonly Values[]): SweepStability[] | null {
  if (parametros.tipo !== 'rejilla') return null;
  const rejilla = parametros.rejilla;
  return Object.keys(rejilla).sort().filter((k) => (rejilla[k]?.length ?? 0) > 1).map((param) => {
    const values = rejilla[param] ?? [];
    // «Un punto de la rejilla» se mide sobre los valores en orden: numérico si todos son números.
    const grid = values.every((v) => typeof v === 'number') ? [...values].sort((a, b) => (a as number) - (b as number)) : values;
    return Object.freeze({ param, stability: sweepStability(chosen.map((v) => v[param]), grid) });
  });
}

function selectionOutput(input: RunInput, selection: Selection | null, configurations: readonly Values[]): unknown {
  if (selection === null) return null;
  return {
    purging_velas: input.particiones.purging_velas,
    embargo_velas: input.particiones.embargo_velas,
    configuraciones: configurations,
    tramos: selection.windows.map((w, i) => ({
      train_desde: toUtcIso(w.from),
      train_hasta: toUtcIso(w.to),
      embargos: w.embargoed.map((e) => ({ desde: toUtcIso(e.from), hasta: toUtcIso(e.to) })),
      sharpe_train: selection.scores[i] ?? [],
      elegida: selection.chosen[i] ?? null,
    })),
  };
}

/** Lo que comparten el barrido y la solo elección: el registro comprobado, los datos del DatasetPort y una regla por punto. */
interface Prepared<P> {
  readonly history: MarketHistory;
  readonly symbols: readonly SymbolId[];
  readonly alternatives: readonly SymbolId[];
  readonly configurations: readonly Values[];
  readonly kits: readonly KitVariant<P>[];
}

function prepare<P>(entry: StrategyEntry<P>, input: RunInput): Prepared<P> {
  const { parametros, universo, estrategia } = input;
  if (estrategia.nombre !== entry.strategy.id || estrategia.version !== entry.strategy.version) {
    throw new RunnerError(`ejecutor de ${entry.strategy.id}@${entry.strategy.version} llamado para ${estrategia.nombre}@${estrategia.version}`);
  }
  if (!isMarketHistory(input.data)) throw new RunnerError('los datos no vienen del DatasetPort de app/datasets.ts');
  const history = input.data;
  if (history.timeframe !== input.datos.timeframe) throw new RunnerError(`datos de ${history.timeframe}, el registro dice ${input.datos.timeframe}`);
  const symbols = universo.simbolos;
  const alternatives = universo.alternativos ?? [];
  const foreign = [...symbols, ...alternatives].filter((s) => !s.endsWith(`/${RESEARCH_QUOTE}`));
  if (foreign.length > 0) throw new RunnerError(`todas las métricas van en ${RESEARCH_QUOTE}: ${foreign.join(', ')} cotiza en otra moneda`);
  const configurations = configurationsOf(entry, parametros);
  const kits = configurations.map((values) => entry.configure(values));
  for (const kit of kits) {
    if (kit.featureSet.timeframe !== history.timeframe) throw new RunnerError(`features de ${kit.featureSet.timeframe} sobre datos de ${history.timeframe}`);
  }
  return { history, symbols, alternatives, configurations, kits };
}

/**
 * Un experimento que solo elige en train (ADR 0044): la elección de cada tramo con el mismo código que el barrido, sin
 * medir ninguna validación ni dar veredicto. Lee las mismas velas registradas que el barrido.
 */
async function selectionOnly<P>(input: RunInput, prepared: Prepared<P>): Promise<RunOutput> {
  const { history, symbols, alternatives, configurations, kits } = prepared;
  if (kits.length < 2) throw new RunnerError('solo se elige en train con un barrido');
  if (input.variantes !== 0) throw new RunnerError(`un experimento que solo elige no hace variantes, y el registro declara ${String(input.variantes)}`);
  const loaded = await history.candles([...symbols, ...alternatives]);
  const selection = selectInTrain(input, history, loaded, kits, { symbols, multiplier: input.costes.multiplicador });
  const metricas: Metricas = { configuraciones: configurations.length, tramos: selection.windows.length };
  for (const [i, c] of selection.chosen.entries()) {
    metricas[`tramo_${String(i)}_elegida`] = canonicalJson(at(configurations, c, 'punto'));
    metricas[`tramo_${String(i)}_sharpe_train`] = selection.scores[i]?.[c] ?? null;
  }
  return { metricas, salida: { seleccion: selectionOutput(input, selection, configurations) }, veredicto: null };
}

/**
 * Ejecutor `nombre@versión` de una estrategia: un backtest por tramo de validación, netos de costes, con lo registrado o
 * con lo elegido en el train de cada tramo si es un barrido; su informe y sus criterios. Si el registro dice que solo
 * elige en train, solo hace eso (ADR 0044).
 *
 * `controls` fija las simulaciones del control aleatorio y los desplazamientos de la señal. En los experimentos son los de
 * CONTROL_COUNTS (1000 y 100); las pruebas pueden bajarlos para ir deprisa, y entonces A.3.12 da NO CONCLUYENTE: el
 * evaluador exige al menos 1000.
 */
export function backtestRunner<P>(entry: StrategyEntry<P>, controls: { readonly simulations: number; readonly shifts: number } = CONTROL_COUNTS): Runner {
  return async (input: RunInput): Promise<RunOutput> => {
    const prepared = prepare(entry, input);
    if (input.solo_eleccion === true) return selectionOnly(input, prepared);
    const { parametros, costes, estrategia } = input;
    const { history, symbols, alternatives, configurations, kits } = prepared;
    // Las variantes que se van a ejecutar son exactamente las registradas, que ya cuentan en N. Todos los puntos de una
    // rejilla tienen las mismas claves: el plan no depende del elegido.
    const plan = robustnessPlan({
      values: configurations[0] ?? {},
      integers: entry.sensitivity?.integers ?? null,
      symbols,
      components: entry.ablation?.components ?? null,
      alternatives,
    });
    if (plan.total !== input.variantes) {
      throw new RunnerError(`el registro declara ${String(input.variantes)} variantes de robustez y el ejecutor hará ${String(plan.total)} (ADR 0031)`);
    }
    // Las del universo alternativo también vienen del dataset registrado: su hash ya las cubre.
    const loaded = await history.candles([...symbols, ...alternatives]);
    const candles = loaded.filter((c) => symbols.includes(c.symbol));
    // BTC para el régimen y el benchmark, del mismo dataset registrado (su hash ya cubre todos los pares).
    const btc = symbols.includes(REGIME_SYMBOL) ? candles.filter((c) => c.symbol === REGIME_SYMBOL) : await history.candles([REGIME_SYMBOL]);
    const run = <Q>(variant: readonly KitVariant<Q>[], options: RunOptions): FoldRun[] => foldsOf(input, history, loaded, variant, options);
    const full = { symbols, multiplier: costes.multiplicador };
    const tramos = input.particiones.tramos;
    // Cada punto de la rejilla en todos los tramos de validación: la matriz del PBO y la V[SRₙ]. Sin barrido, es el run base.
    const perPoint = kits.map((kit) => run(tramos.map(() => kit), full));
    const selection = kits.length > 1 ? selectInTrain(input, history, loaded, kits, full) : null;
    const chosenIndex = selection?.chosen ?? tramos.map(() => 0);
    const folds = chosenIndex.map((c, i) => at(at(perPoint, c, 'punto'), i, 'tramo'));
    const baseKits = chosenIndex.map((c) => at(kits, c, 'punto'));
    const chosen = chosenIndex.map((c) => at(configurations, c, 'punto'));
    const strategy = runnerKey(estrategia.nombre, estrategia.version);
    const grid = kits.length > 1 ? perPoint.map((runs, c) => seriesOf(`${strategy} ${canonicalJson(at(configurations, c, 'punto'))}`, input.familia, runs)) : [];
    const costSpec = { commission: costes.comision, halfSpread: costes.spread, minSlippage: costes.slippage, multiplier: costes.multiplicador };
    const prices = benchmarkPrices([...candles.filter((c) => c.symbol !== REGIME_SYMBOL), ...btc], symbols, costSpec, history.timeframe);
    const byOpen = (a: HistoricalCandle, b: HistoricalCandle): number => a.openTime - b.openTime;
    const regimes = regimeSeries([...btc].sort(byOpen), priceRegime(), history.timeframe);
    const fullFolds = folds.map((f) => foldData(f, strategy, prices));
    const report = analyzeRun({
      currency: RESEARCH_QUOTE,
      timeframe: history.timeframe,
      folds: fullFolds,
      regimeSymbol: REGIME_SYMBOL,
      regimes,
      family: { trials: input.pruebas_familia.n },
      bootstrap: { resamples: BOOTSTRAP_RESAMPLES, rng: seededRng(input.semilla, 'bootstrap'), seed: input.semilla },
    });
    const context = {
      family: input.familia,
      seed: input.semilla,
      symbols,
      multiplier: costes.multiplicador,
      timeframe: history.timeframe,
      params: registeredParams(parametros),
      chosen,
      configuration: `${strategy} ${canonicalJson(parametros.tipo === 'valores' ? parametros.valores : { rejilla: parametros.rejilla })}`,
      base: { kits: baseKits, folds, report, series: runSeries(fullFolds) },
      grid,
      sweep: sweepOf(parametros, chosen),
      candles,
      regimes,
      regimeSymbol: REGIME_SYMBOL,
      costRate: prices.costRate,
      maxStaleMs: prices.maxStaleMs,
      sensitivity: entry.sensitivity ?? null,
      ablation: entry.ablation ?? null,
      plan,
      simulations: controls.simulations,
      shifts: controls.shifts,
      run,
    };
    const criteria = evaluateCriteria(criteriaEvidence(context));
    const series = configurationSeries(context);
    const selected = selection === null ? null : selection.chosen.map((c, i) => ({ values: at(configurations, c, 'punto'), trainSharpe: selection.scores[i]?.[c] ?? null }));
    // Paso 41C (ADR 0047): las curvas del control de A.3.12 y el diario de cada tramo se guardan aparte; su huella va aquí.
    const curves = controlCurves({
      folds, candles, symbols, costRate: prices.costRate, timeframe: history.timeframe, maxStaleMs: prices.maxStaleMs,
      seed: input.semilla, simulations: controls.simulations, actualSharpe: report.summary.sharpeAnnualized,
    });
    const journals = folds.map((fold, i) => journalText(`${strategy}/tramo-${String(i)}`, input.semilla, fold.result));
    return {
      metricas: metrics(input, folds, report, criteria, configurations.length, selected),
      salida: {
        tramos: folds.map((fold) => ({
          desde: toUtcIso(fold.from),
          hasta: toUtcIso(fold.to),
          calentamiento_desde: toUtcIso(fold.result.warmupFrom),
          diario_sha256: fold.result.journalSha256,
          metricas: fold.result.metrics,
          rendimiento: fold.result.performance,
          curva: fold.result.equityCurve,
          operaciones: fold.result.roundTrips,
          ejecucion: fold.result.execution,
          detenido: fold.result.halted,
          sesgo_de_supervivencia: fold.survivorshipBias,
        })),
        // Con barrido: ventanas de train, Sharpe de cada punto en train (dentro de muestra: no decide el veredicto) y el elegido.
        seleccion: selectionOutput(input, selection, configurations),
        analitica: report,
        criterios: criteria,
        // La serie fuera de muestra de lo elegido y la de cada punto de la rejilla: la matriz del PBO de la ronda se junta
        // con ellas antes del paso 31.
        serie_configuracion: { id: series.id, familia: series.family, fines: series.times, rendimientos: series.returns },
        series_rejilla: grid.map((s) => ({ id: s.id, familia: s.family, fines: s.times, rendimientos: s.returns })),
        supuestos: folds[0]?.result.assumptions ?? [],
        periodos_por_ano: periodsPerYear(history.timeframe),
        archivos: {
          controles: { sha256: curves.curvas === null ? null : sha256Hex(canonicalJson(curves.curvas)), motivo: curves.motivo },
          diarios_sha256: journals.map((text) => sha256Hex(text)),
        },
      },
      veredicto: criteria.verdict,
      artefactos: { controles: curves.curvas, diarios: journals.map((texto, i) => ({ texto, parametros: at(chosen, i, 'tramo') })) },
    };
  };
}

function kitOf<P>(kit: StrategyKit<P>): KitVariant<P> {
  return { strategy: kit.strategy, params: kit.params, featureSet: kit.featureSet };
}

/**
 * Ejecutor de una estrategia de la biblioteca (paso 25, ADR 0028): con los parámetros de la literatura o, desde el paso 28
 * (ADR 0032), con su rejilla de la literatura. Las variantes de sensibilidad y la ablación, sobre los de cada tramo.
 */
export function libraryRunner<P extends object>(entry: LibraryEntry<P>): Runner {
  return backtestRunner({
    strategy: entry.build(entry.literatura, entry.timeframe).strategy,
    configure: (values) => kitOf(entry.build(acceptedParams(entry, values), entry.timeframe)),
    grid: (rejilla) => literatureGrid(entry, rejilla),
    ablation: { components: entry.componentes, build: (component, values) => kitOf(entry.build(variantParams(entry, values), entry.timeframe, [component])) },
    sensitivity: { integers: entry.enteros, build: (values) => kitOf(entry.build(variantParams(entry, values), entry.timeframe)) },
  });
}

/** Estrategias de la biblioteca que se pueden investigar, por runnerKey: todas, en estado RESEARCH. */
export function libraryRunners(): ReadonlyMap<string, Runner> {
  const { trendFollowing, meanReversion } = STRATEGY_LIBRARY;
  return new Map([
    [runnerKey(trendFollowing.id, trendFollowing.version), libraryRunner(trendFollowing)],
    [runnerKey(meanReversion.id, meanReversion.version), libraryRunner(meanReversion)],
  ]);
}
