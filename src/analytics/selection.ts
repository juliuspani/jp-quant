// Elección de parámetros en train del walk-forward (quant-research §4; paso 28, ADR 0032). Cada configuración de una
// rejilla se puntúa con su Sharpe en train, neto de costes, sin los periodos purgados ni los embargados, y se elige la
// mejor. Lo elegido solo se mide fuera de muestra, en el tramo de validación de ese mismo tramo. Funciones puras.
// - Purging (h velas): la ventana de train termina h velas antes de su final; lo abierto en ese punto se valora como si
//   se vendiera, así que su resultado posterior no puntúa.
// - Embargo (e velas, e ≥ h): tras cada tramo de evaluación que cae dentro de una ventana de train, sus e velas
//   siguientes no puntúan.
import type { UtcMillis } from '../shared/time.ts';
import { periodInstant } from './breakdown.ts';
import { AnalyticsError, periodReturns, sharpeOf } from './performance.ts';

/** [from, to) en milisegundos UTC. */
export interface Interval {
  readonly from: UtcMillis;
  readonly to: UtcMillis;
}

/** Ventana de train de un tramo, con el purging aplicado y los intervalos embargados dentro de ella. */
export interface TrainWindow {
  readonly from: UtcMillis;
  readonly to: UtcMillis; // excluido: el final de train menos h velas
  readonly embargoed: readonly Interval[];
}

export interface Fold {
  readonly train: Interval;
  readonly validation: Interval;
}

/** Ventanas de train de los tramos de un walk-forward, con `purgeMs` = h velas y `embargoMs` = e velas. */
export function trainWindows(folds: readonly Fold[], purgeMs: number, embargoMs: number): TrainWindow[] {
  if (!(purgeMs >= 0) || !(embargoMs >= purgeMs)) throw new AnalyticsError(`purging ${String(purgeMs)} y embargo ${String(embargoMs)}: hace falta 0 ≤ h ≤ e`);
  return folds.map((fold, i) => {
    const from = fold.train.from;
    const to = fold.train.to - purgeMs;
    if (to <= from) throw new AnalyticsError(`tramo ${String(i)}: el purging deja la ventana de train vacía`);
    const embargoed: Interval[] = [];
    for (const { validation } of folds) {
      const end = validation.to;
      if (embargoMs > 0 && end > from && end < to) embargoed.push(Object.freeze({ from: end, to: Math.min(end + embargoMs, to) }));
    }
    return Object.freeze({ from, to, embargoed: Object.freeze(embargoed) });
  });
}

export interface ScoredPeriod {
  readonly start: UtcMillis;
  readonly end: UtcMillis;
  readonly ret: number;
}

/** Periodos netos de un run, como los del informe: el último cierra a valor de liquidación. */
export function runPeriods(run: { readonly from: UtcMillis; readonly startEquity: number; readonly endEquity: number; readonly curve: readonly { readonly at: UtcMillis; readonly equity: number }[] }): ScoredPeriod[] {
  const { curve } = run;
  const last = curve.length - 1;
  if (last < 0) return [];
  const returns = periodReturns([run.startEquity, ...curve.slice(0, last).map((p) => p.equity), run.endEquity]);
  return returns.map((ret, k) => ({ start: k === 0 ? run.from : (curve[k - 1]?.at ?? run.from), end: curve[k]?.at ?? run.from, ret }));
}

function embargoedAt(at: UtcMillis, intervals: readonly Interval[]): boolean {
  return intervals.some((i) => at >= i.from && at < i.to);
}

/** Sharpe anualizado de train sin los periodos embargados (por su punto medio); null si no hay variación. */
export function trainScore(periods: readonly ScoredPeriod[], window: TrainWindow, perYear: number): number | null {
  const kept = periods.filter((p) => !embargoedAt(periodInstant(p), window.embargoed)).map((p) => p.ret);
  const { sharpe } = sharpeOf(kept);
  return sharpe === null ? null : sharpe * Math.sqrt(perYear);
}

/**
 * Índice de la configuración con mejor puntuación. Sin variación (sin operaciones, curva plana) puntúa 0, que es lo que
 * gana; con empate gana la primera de la rejilla. Así la elección es determinista.
 */
export function chooseConfiguration(scores: readonly (number | null)[]): number {
  if (scores.length === 0) throw new AnalyticsError('sin configuraciones que elegir');
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  scores.forEach((s, i) => {
    const score = s ?? 0;
    if (!Number.isFinite(score)) throw new AnalyticsError(`puntuación no finita en la configuración ${String(i)}`);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}
