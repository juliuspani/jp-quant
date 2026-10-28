// Robustez de los criterios congelados (docs/PROMOTION_CRITERIA.md; paso 27B, ADR 0031): variantes de parámetros a
// ±25 % y ±50 % (A.3.8), cifras significativas, estabilidad del parámetro elegido en un barrido, la serie sin el mejor
// año y el mejor activo (A.3.13) y la matriz del PBO entre configuraciones de una familia o de varias (A.3.6). Solo
// miden; los umbrales están en criteria.ts. Funciones puras.
import type { UtcMillis } from '../shared/time.ts';
import type { AssetGroup, PeriodRecord } from './breakdown.ts';
import { periodInstant, utcYear } from './breakdown.ts';
import { AnalyticsError, sharpeOf } from './performance.ts';
import { probabilityOfBacktestOverfitting, type PboResult } from './statistics.ts';

/** Cambios de A.3.8, de uno en uno: −50 %, −25 %, +25 % y +50 %. */
export const SENSITIVITY_STEPS: readonly number[] = Object.freeze([-0.5, -0.25, 0.25, 0.5]);

export interface ParameterVariant {
  readonly param: string;
  readonly step: number; // fracción del cambio: −0,5, −0,25, 0,25 o 0,5
  readonly values: Readonly<Record<string, unknown>>; // los parámetros con ese único cambio
}

/**
 * Variantes de sensibilidad: cada parámetro numérico, de uno en uno, por (1 + paso). Un parámetro entero se redondea
 * hacia fuera (hacia abajo al bajar y hacia arriba al subir), para que el cambio no desaparezca al redondear. Los
 * parámetros que no son números (una elección discreta) no tienen variantes de este tipo.
 */
export function parameterVariants(values: Readonly<Record<string, unknown>>, integers: ReadonlySet<string>): ParameterVariant[] {
  const variants: ParameterVariant[] = [];
  for (const param of Object.keys(values).sort()) {
    if (typeof values[param] !== 'number') continue;
    for (const step of SENSITIVITY_STEPS) variants.push(Object.freeze({ param, step, values: perturbed(values, param, step, integers) }));
  }
  return variants;
}

/**
 * Los parámetros con `param` multiplicado por (1 + `step`), redondeado hacia fuera si es entero. En un barrido (paso 28,
 * ADR 0032) se aplica a los elegidos en cada tramo.
 */
export function perturbed(values: Readonly<Record<string, unknown>>, param: string, step: number, integers: ReadonlySet<string>): Readonly<Record<string, unknown>> {
  const base = values[param];
  if (typeof base !== 'number' || !Number.isFinite(base)) throw new AnalyticsError(`${param}: no es un valor numérico finito`);
  if (integers.has(param) && !Number.isSafeInteger(base)) throw new AnalyticsError(`${param} se declara entero y vale ${String(base)}`);
  const raw = base * (1 + step);
  const value = integers.has(param) ? (step < 0 ? Math.floor(raw) : Math.ceil(raw)) : raw;
  return Object.freeze({ ...values, [param]: value });
}

/** Parámetros numéricos de un conjunto de valores registrados: los que tienen variantes de sensibilidad. */
export function numericParams(values: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(values).filter((k) => typeof values[k] === 'number').sort();
}

/**
 * Cifras significativas de un valor tal como se escribe (A.3.8: más de 3 indica sobreajuste). Los ceros a la izquierda
 * no cuentan; los de la derecha de un entero tampoco (1000 tiene 1), y los de la derecha tras la coma no existen en la
 * representación más corta de un número.
 */
export function significantDigits(value: number): number {
  if (!Number.isFinite(value)) throw new AnalyticsError(`cifras significativas de un valor no finito: ${String(value)}`);
  if (value === 0) return 1;
  const [mantissa = ''] = Math.abs(value).toString().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  return (fraction === '' ? digits.replace(/0+$/, '') : digits).length || 1;
}

/**
 * Estabilidad del parámetro elegido en train (A.3.8): fracción de los cambios de tramo en que el índice del valor elegido
 * en la rejilla se mueve como mucho un punto. null con menos de dos tramos.
 */
export function sweepStability(chosen: readonly unknown[], grid: readonly unknown[]): number | null {
  if (chosen.length < 2) return null;
  const index = chosen.map((v) => {
    const i = grid.findIndex((g) => Object.is(g, v));
    if (i < 0) throw new AnalyticsError(`el valor elegido ${String(v)} no está en la rejilla`);
    return i;
  });
  let steady = 0;
  for (let k = 1; k < index.length; k++) if (Math.abs((index[k] ?? 0) - (index[k - 1] ?? 0)) <= 1) steady++;
  return steady / (index.length - 1);
}

export interface WithoutBestYear {
  readonly bestYear: string | null;
  readonly years: number;
  readonly sharpeAnnualized: number | null; // de la serie sin los periodos del mejor año
}

/** La serie sin su mejor año UTC (el de mayor rentabilidad compuesta), por la fecha de cada periodo. */
export function withoutBestYear(records: readonly PeriodRecord[], perYear: number): WithoutBestYear {
  const byYear = new Map<string, number[]>();
  for (const r of records) {
    const year = utcYear(periodInstant(r));
    byYear.set(year, [...(byYear.get(year) ?? []), r.ret]);
  }
  if (byYear.size < 2) return Object.freeze({ bestYear: null, years: byYear.size, sharpeAnnualized: null });
  const compounded = [...byYear.entries()].map(([year, rets]) => ({ year, total: rets.reduce((t, r) => t * (1 + r), 1) - 1 }));
  compounded.sort((a, b) => b.total - a.total || (a.year < b.year ? -1 : 1));
  const best = compounded[0]?.year ?? null;
  const rest = records.filter((r) => utcYear(periodInstant(r)) !== best).map((r) => r.ret);
  const { sharpe } = sharpeOf(rest);
  return Object.freeze({ bestYear: best, years: byYear.size, sharpeAnnualized: sharpe === null ? null : sharpe * Math.sqrt(perYear) });
}

/** El activo con más P&L neto cerrado; null sin operaciones cerradas. Con empate, el primero por nombre. */
export function bestAsset(byAsset: Readonly<Record<string, AssetGroup>>): string | null {
  let best: string | null = null;
  let bestPnl = Number.NEGATIVE_INFINITY;
  for (const symbol of Object.keys(byAsset).sort()) {
    const group = byAsset[symbol];
    if (group === undefined || group.closed === 0) continue;
    if (group.netPnl > bestPnl) {
      best = symbol;
      bestPnl = group.netPnl;
    }
  }
  return best;
}

/** Serie fuera de muestra de una configuración que compite por la decisión, con la familia a la que pertenece. */
export interface ConfigurationSeries {
  readonly id: string;
  readonly family: string;
  readonly times: readonly UtcMillis[]; // final de cada periodo, en orden
  readonly returns: readonly number[];
}

export type PboOutcome =
  | { readonly measured: true; readonly result: PboResult; readonly periods: number }
  | { readonly measured: false; readonly configurations: number; readonly reason: string };

/**
 * PBO por CSCV entre configuraciones (A.3.6): las series se alinean en los instantes comunes a todas y se parten en `S`
 * bloques. Con menos de dos configuraciones, o sin periodos suficientes en común, no se mide.
 */
export function pboAcross(configs: readonly ConfigurationSeries[], blocks = 16): PboOutcome {
  if (configs.length < 2) return { measured: false, configurations: configs.length, reason: 'menos de dos configuraciones con serie de rendimientos' };
  const ids = new Set<string>();
  for (const c of configs) {
    if (ids.has(c.id)) throw new AnalyticsError(`configuración repetida: ${c.id}`);
    ids.add(c.id);
    if (c.times.length !== c.returns.length) throw new AnalyticsError(`${c.id}: ${String(c.times.length)} instantes y ${String(c.returns.length)} rendimientos`);
  }
  const maps = configs.map((c) => new Map(c.times.map((t, i) => [t, c.returns[i] ?? Number.NaN])));
  const common = (configs[0]?.times ?? []).filter((t) => maps.every((m) => m.has(t)));
  if (common.length < 2 * blocks) {
    return { measured: false, configurations: configs.length, reason: `${String(common.length)} periodos en común: CSCV con S = ${String(blocks)} necesita al menos ${String(2 * blocks)}` };
  }
  const matrix = maps.map((m) => common.map((t) => m.get(t) ?? Number.NaN));
  return { measured: true, result: probabilityOfBacktestOverfitting(matrix, blocks), periods: common.length };
}
