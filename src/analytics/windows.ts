// Ventanas de calendario y regímenes de los criterios congelados (docs/PROMOTION_CRITERIA.md; paso 27B, ADR 0031): las
// ventanas de crisis de A.3.7, los episodios bajistas de A.3.9 y la rentabilidad en los periodos alcistas y laterales de
// BTC. Solo miden; los umbrales están en criteria.ts. Funciones puras sobre los periodos de la serie concatenada.
//
// Cada periodo se asigna a la fecha de su punto medio (periodInstant, en breakdown.ts). A.3.9 compara con BTC escalado
// por la exposición de la estrategia en toda la serie y, además, por la que tuvo en cada régimen (ADR 0042); A.3.7, con
// el buy-and-hold de todo el capital.
import type { RegimeView } from '../kernel/regime.ts';
import { parseUtcIso, type UtcMillis } from '../shared/time.ts';
import { periodInstant, type PeriodRecord } from './breakdown.ts';
import { AnalyticsError, drawdownOf, finite } from './performance.ts';
import { regimeAt } from './regime.ts';

/** Ventana de fechas UTC, [from, to). */
export interface DateWindow {
  readonly id: string;
  readonly from: UtcMillis;
  readonly to: UtcMillis;
}

function window(id: string, from: string, to: string): DateWindow {
  return Object.freeze({ id, from: parseUtcIso(from), to: parseUtcIso(to) });
}

/** Ventanas de crisis de la tabla A.3.7, con el extremo final incluido (el día siguiente, excluido). */
export const CRISIS_WINDOWS: readonly DateWindow[] = Object.freeze([
  window('2018-01-01/2018-12-31', '2018-01-01T00:00:00Z', '2019-01-01T00:00:00Z'),
  window('2020-03-01/2020-04-30', '2020-03-01T00:00:00Z', '2020-05-01T00:00:00Z'),
  window('2021-05-01/2021-07-31', '2021-05-01T00:00:00Z', '2021-08-01T00:00:00Z'),
  window('2022-01-01/2022-12-31', '2022-01-01T00:00:00Z', '2023-01-01T00:00:00Z'),
]);

/** Episodios bajistas de A.3.9: 2018 y 2022 completos. */
export const BEAR_EPISODES: readonly DateWindow[] = Object.freeze([
  window('2018', '2018-01-01T00:00:00Z', '2019-01-01T00:00:00Z'),
  window('2022', '2022-01-01T00:00:00Z', '2023-01-01T00:00:00Z'),
]);

export type Coverage = 'dentro' | 'parcial' | 'fuera';

/** Si los tramos de validación ([from, to), sin solaparse) cubren la ventana entera, una parte o nada. */
export function coverage(w: DateWindow, folds: readonly { readonly from: UtcMillis; readonly to: UtcMillis }[]): Coverage {
  const inside = folds
    .map((f) => ({ from: Math.max(f.from, w.from), to: Math.min(f.to, w.to) }))
    .filter((f) => f.to > f.from)
    .sort((a, b) => a.from - b.from);
  if (inside.length === 0) return 'fuera';
  let reached = w.from;
  for (const f of inside) {
    if (f.from > reached) return 'parcial';
    reached = Math.max(reached, f.to);
  }
  return reached >= w.to ? 'dentro' : 'parcial';
}

function compound(returns: readonly number[]): number {
  return returns.reduce((total, r) => total * (1 + r), 1) - 1;
}

function chained(returns: readonly number[]): number[] {
  const path = [1];
  for (const r of returns) path.push((path.at(-1) ?? 1) * (1 + r));
  return path;
}

export interface WindowResult {
  readonly id: string;
  readonly coverage: Coverage;
  readonly periods: number;
  readonly strategyReturn: number | null; // compuesta, neta; null si la ventana no está entera en validación
  readonly benchmarkReturn: number | null; // buy-and-hold de BTC en los mismos periodos
  readonly maxDrawdown: number | null; // de la estrategia dentro de la ventana
}

/** Rentabilidad, la de BTC y la caída máxima de la estrategia en una ventana; solo si los tramos la cubren entera. */
export function windowResult(w: DateWindow, records: readonly PeriodRecord[], folds: readonly { readonly from: UtcMillis; readonly to: UtcMillis }[]): WindowResult {
  const cover = coverage(w, folds);
  const own = records.filter((r) => {
    const t = periodInstant(r);
    return t >= w.from && t < w.to;
  });
  if (cover !== 'dentro' || own.length === 0) {
    return Object.freeze({ id: w.id, coverage: cover, periods: own.length, strategyReturn: null, benchmarkReturn: null, maxDrawdown: null });
  }
  const returns = own.map((r) => r.ret);
  return Object.freeze({
    id: w.id,
    coverage: cover,
    periods: own.length,
    strategyReturn: compound(returns),
    benchmarkReturn: compound(own.map((r) => r.benchmark)),
    maxDrawdown: drawdownOf(chained(returns)).maxDrawdown,
  });
}

export interface RegimeReturns {
  readonly periods: number;
  readonly strategyReturn: number | null; // compuesta, neta; null sin periodos
  readonly benchmarkReturn: number | null; // buy-and-hold de BTC en esos mismos periodos
  readonly strategyAnnualized: number | null; // compuesta anualizada con 365 días
}

/**
 * Rentabilidad de la estrategia y de BTC en los periodos con la tendencia `trend` según el régimen de BTC conocido al
 * empezar cada periodo (point-in-time). Los periodos sin etiqueta (SIN_DATO) no cuentan.
 */
export function regimeReturns(records: readonly PeriodRecord[], regimes: readonly RegimeView[], trend: 'ALCISTA' | 'LATERAL', perYear: number): RegimeReturns {
  if (!(perYear > 0)) throw new AnalyticsError(`periodos por año inválidos: ${String(perYear)}`);
  const own = records.filter((r) => regimeAt(regimes, r.start)?.trend === trend);
  if (own.length === 0) return Object.freeze({ periods: 0, strategyReturn: null, benchmarkReturn: null, strategyAnnualized: null });
  const total = compound(own.map((r) => r.ret));
  return Object.freeze({
    periods: own.length,
    strategyReturn: total,
    benchmarkReturn: compound(own.map((r) => r.benchmark)),
    strategyAnnualized: total <= -1 ? -1 : (1 + total) ** (perYear / own.length) - 1,
  });
}

/**
 * Exposición del benchmark de A.3.9 (ADR 0042): la de cada periodo (posiciones que no son polvo entre patrimonio), con
 * la media ponderada por la propia exposición. Con posiciones de tamaño fijo es ese tamaño; los periodos sin posición no
 * pesan. null si no hay ninguna posición.
 */
export function benchmarkExposure(exposures: readonly number[]): number | null {
  let sum = 0;
  let squares = 0;
  for (const x of exposures) {
    if (!(finite('exposición', x) > 0)) continue;
    sum += x;
    squares += x * x;
  }
  return sum > 0 ? squares / sum : null;
}

/**
 * Los mismos periodos frente a BTC con la exposición `exposure` en cada uno (ADR 0042): la rentabilidad de cada periodo
 * del buy-and-hold de todo el capital, por `exposure`, con su compra y su venta en el primero y el último de cada tramo.
 * Es la cartera que mantiene siempre esa fracción en BTC y el resto en liquidez. Un buy-and-hold que compra esa fracción
 * al empezar el tramo y no la toca subiría su exposición en los alcistas y la bajaría en los bajistas.
 */
export function scaledBenchmark(records: readonly PeriodRecord[], exposure: number): PeriodRecord[] {
  if (!(exposure > 0 && exposure <= 1)) throw new AnalyticsError(`exposición del benchmark fuera de (0, 1]: ${String(exposure)}`);
  return records.map((r) => ({ ...r, benchmark: exposure * r.benchmark }));
}

/** Una comparación de la condición por régimen: frente a BTC con la exposición que la estrategia tuvo en esos periodos. */
export interface OwnExposure<T> {
  readonly exposure: number;
  readonly result: T;
}

/** Lo que compara A.3.9: cada episodio bajista, los periodos alcistas y los laterales, frente al benchmark de ADR 0042. */
export interface RegimeMeasures {
  readonly regimeExposure: number | null; // la de toda la serie; null: la estrategia nunca tiene posición
  readonly bearEpisodes: readonly WindowResult[]; // frente a BTC con la exposición de toda la serie
  readonly bull: RegimeReturns; // como los episodios bajistas
  readonly lateral: RegimeReturns;
  // La condición por régimen: el alcista y cada episodio bajista, también frente a BTC con la exposición que la estrategia
  // tuvo en esos mismos periodos; null si en ellos no tuvo ninguna posición que no fuera polvo.
  readonly own: { readonly bull: OwnExposure<RegimeReturns> | null; readonly bear: readonly (OwnExposure<WindowResult> | null)[] };
}

export interface RegimeInput {
  readonly records: readonly PeriodRecord[]; // con el buy-and-hold de BTC de todo el capital y la exposición de cada periodo
  readonly regimes: readonly RegimeView[]; // de BTC
  readonly folds: readonly { readonly from: UtcMillis; readonly to: UtcMillis }[];
  readonly perYear: number;
}

/** Sin exposición, los periodos llevan el buy-and-hold de todo el capital y el evaluador no compara (NO CONCLUYENTE). */
export function regimeMeasures(input: RegimeInput): RegimeMeasures {
  const { records, regimes, folds, perYear } = input;
  const exposureOf = (selected: readonly PeriodRecord[]): number | null => benchmarkExposure(selected.map((r) => r.exposure));
  const scaled = (exposure: number | null): readonly PeriodRecord[] => (exposure === null ? records : scaledBenchmark(records, exposure));
  const exposure = exposureOf(records);
  const all = scaled(exposure);
  const inBull = exposureOf(records.filter((r) => regimeAt(regimes, r.start)?.trend === 'ALCISTA'));
  const inEpisode = (w: DateWindow): number | null => exposureOf(records.filter((r) => periodInstant(r) >= w.from && periodInstant(r) < w.to));
  return Object.freeze({
    regimeExposure: exposure,
    bearEpisodes: Object.freeze(BEAR_EPISODES.map((w) => windowResult(w, all, folds))),
    bull: regimeReturns(all, regimes, 'ALCISTA', perYear),
    lateral: regimeReturns(all, regimes, 'LATERAL', perYear),
    own: Object.freeze({
      bull: inBull === null ? null : Object.freeze({ exposure: inBull, result: regimeReturns(scaled(inBull), regimes, 'ALCISTA', perYear) }),
      bear: Object.freeze(BEAR_EPISODES.map((w) => {
        const e = inEpisode(w);
        return e === null ? null : Object.freeze({ exposure: e, result: windowResult(w, scaled(e), folds) });
      })),
    }),
  });
}
