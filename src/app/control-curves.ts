// Curvas del control aleatorio de un experimento (paso 41C, ADR 0047, decisión 6; aprobado por la persona el 2026-10-27),
// para la vista «¿suerte o ventaja?» del dashboard. Solo para experimentos nuevos: los ya registrados no se tocan.
// - Son las mismas colocaciones al azar que mide A.3.12: misma semilla y mismo flujo (RANDOM_CONTROL_STREAM) sobre las
//   mismas operaciones, evaluadas con el simulador y convertidas en curvas de patrimonio en base 100.
// - Si el simulador no es válido para ese run (su réplica se aleja más de un 10 % del backtester), A.3.12 usa el
//   backtester y estas curvas no lo representarían: no se guardan y queda el motivo.
// - El percentil es el de la réplica de la estrategia entre los Sharpe de las colocaciones: el de la curva que se pinta.
// - Los percentiles 5 y 95 se calculan con todas las colocaciones; después las curvas se reducen a CURVE_POINTS puntos (con
//   el primero y el último) y se guardan las CURVE_SAMPLES primeras colocaciones como muestra del abanico.
import { AnalyticsError, periodsPerYear } from '../analytics/performance.ts';
import { percentileOf, randomPlacements, simulatedSharpe, simulateTrades, simulatorValid, summarizeControl } from '../analytics/random-control.ts';
import { sortedQuantile } from '../analytics/statistics.ts';
import type { HistoricalCandle } from '../historical/types.ts';
import { seededRng } from '../kernel/random.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { Timeframe } from '../shared/time.ts';
import { controlInputs, RANDOM_CONTROL_STREAM, type FoldRun } from './criteria-evidence.ts';

export const CURVE_POINTS = 400;
export const CURVE_SAMPLES = 48;

/** Una entrada del formato inversor-controles/1, sin el id del experimento (el ejecutor no lo conoce). */
export interface ControlCurves {
  readonly simulaciones: number;
  readonly percentil: number;
  readonly estrategia: readonly number[];
  readonly p05: readonly number[];
  readonly p95: readonly number[];
  readonly muestras: readonly (readonly number[])[];
}

export interface ControlCurvesInput {
  readonly folds: readonly FoldRun[];
  readonly candles: readonly HistoricalCandle[];
  readonly symbols: readonly SymbolId[];
  readonly costRate: number;
  readonly timeframe: Timeframe;
  readonly maxStaleMs: number;
  readonly seed: number;
  readonly simulations: number;
  readonly actualSharpe: number | null; // el del backtester, para saber si el simulador es válido
}

const round = (v: number): number => Math.round(v * 100) / 100;

/** Patrimonio en base 100 a partir de las rentabilidades por periodo. */
function equity(returns: readonly number[]): number[] {
  const out = [100];
  for (const r of returns) out.push((out.at(-1) ?? 100) * (1 + r));
  return out;
}

/** Índices de como mucho CURVE_POINTS puntos repartidos por igual, con el primero y el último. */
function sampleIndices(length: number): number[] {
  if (length <= CURVE_POINTS) return Array.from({ length }, (_, i) => i);
  return Array.from({ length: CURVE_POINTS }, (_, k) => Math.round((k * (length - 1)) / (CURVE_POINTS - 1)));
}

/** Las curvas, o null con el motivo si no representarían el control de A.3.12. */
export function controlCurves(input: ControlCurvesInput): { readonly curvas: ControlCurves | null; readonly motivo: string | null } {
  const perYear = periodsPerYear(input.timeframe);
  try {
    const inputs = controlInputs(input.folds, input.candles, input.symbols, input.costRate, perYear, input.maxStaleMs);
    const placements = randomPlacements(inputs.market, inputs.trades, input.simulations, seededRng(input.seed, RANDOM_CONTROL_STREAM));
    const replica = simulatedSharpe(inputs.market, inputs.trades);
    if (!simulatorValid(replica, input.actualSharpe)) {
      return { curvas: null, motivo: 'el simulador se aleja más de un 10 % del backtester: A.3.12 usa el backtester y las curvas del simulador no lo representarían' };
    }
    if (replica === null) return { curvas: null, motivo: 'la estrategia no tiene Sharpe en el simulador' };
    const sharpes = summarizeControl(placements.map((p) => simulatedSharpe(inputs.market, p))).sharpes;
    const controls = placements.map((p) => equity(simulateTrades(inputs.market, p)));
    const strategy = equity(simulateTrades(inputs.market, inputs.trades));
    const keep = sampleIndices(strategy.length);
    const band = (q: number): number[] => keep.map((i) => round(sortedQuantile(controls.map((c) => c[i] ?? 100).sort((a, b) => a - b), q)));
    return {
      curvas: {
        simulaciones: placements.length,
        percentil: round(100 * percentileOf(sharpes, replica)),
        estrategia: keep.map((i) => round(strategy[i] ?? 100)),
        p05: band(0.05),
        p95: band(0.95),
        muestras: controls.slice(0, CURVE_SAMPLES).map((c) => keep.map((i) => round(c[i] ?? 100))),
      },
      motivo: null,
    };
  } catch (e) {
    if (e instanceof AnalyticsError) return { curvas: null, motivo: `sin control aleatorio: ${e.message}` };
    throw e;
  }
}
