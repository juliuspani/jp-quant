// Matriz del PBO de la ronda (docs/PROMOTION_CRITERIA.md A.3.6; ADR 0031, decisión 10; ADR 0032, decisión 5; ADR 0034).
// A.3.6 pide el CSCV con todas las configuraciones que compiten por la decisión: todas las de la ronda, de todas las
// familias, y todos los puntos de cada rejilla. Un experimento solo tiene los de su familia; la matriz de la ronda se junta
// después con las salidas guardadas (`series_rejilla`, o `serie_configuracion` sin barrido). También el DSR global de cada
// candidato, que solo se calcula en la decisión, con la N de todo el registro (A.3.2, ADR 0039). Solo mide: no ejecuta nada
// ni mira datos nuevos. Puro: sin E/S.
import { deflatedSharpeOf, type DeflatedSharpeReport } from '../analytics/report.ts';
import { pboAcross, type ConfigurationSeries, type PboOutcome } from '../analytics/robustness.ts';

export class RoundMatrixError extends Error {
  override readonly name = 'RoundMatrixError';
}

function record(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RoundMatrixError(`${where}: no es un objeto`);
  return value as Readonly<Record<string, unknown>>;
}

function numbers(value: unknown, where: string): number[] {
  if (!Array.isArray(value) || !value.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) {
    throw new RoundMatrixError(`${where}: no es una lista de números finitos`);
  }
  return value;
}

function series(value: unknown, where: string): ConfigurationSeries {
  const s = record(value, where);
  const { id, familia } = s;
  if (typeof id !== 'string' || id === '' || typeof familia !== 'string' || familia === '') throw new RoundMatrixError(`${where}: sin id o sin familia`);
  const times = numbers(s['fines'], `${where} ${id} fines`);
  const returns = numbers(s['rendimientos'], `${where} ${id} rendimientos`);
  if (times.length !== returns.length) throw new RoundMatrixError(`${where} ${id}: ${String(times.length)} instantes y ${String(returns.length)} rendimientos`);
  if (times.some((t, i) => i > 0 && t <= (times[i - 1] ?? t))) throw new RoundMatrixError(`${where} ${id}: instantes desordenados o repetidos`);
  return Object.freeze({ id, family: familia, times: Object.freeze(times), returns: Object.freeze(returns) });
}

/**
 * Configuraciones de la salida guardada de un experimento: cada punto de su rejilla, o su única configuración si no hubo
 * barrido. Lanza si la salida no tiene la forma del ejecutor (research-runner.ts).
 */
export function outputConfigurations(experiment: string, salida: unknown): ConfigurationSeries[] {
  const out = record(salida, experiment);
  const grid = out['series_rejilla'];
  if (!Array.isArray(grid)) throw new RoundMatrixError(`${experiment}: la salida no tiene series_rejilla`);
  if (grid.length > 0) return grid.map((s, i) => series(s, `${experiment} series_rejilla[${String(i)}]`));
  return [series(out['serie_configuracion'], `${experiment} serie_configuracion`)];
}

export interface RoundMatrix {
  readonly configurations: readonly { readonly id: string; readonly family: string; readonly periods: number }[];
  readonly families: readonly { readonly family: string; readonly outcome: PboOutcome }[]; // dentro de cada familia
  readonly round: PboOutcome; // entre familias: todas las configuraciones de la ronda
}

/** PBO por CSCV (S = 16) dentro de cada familia y con todas las configuraciones de la ronda. */
export function roundMatrix(configurations: readonly ConfigurationSeries[]): RoundMatrix {
  const families = [...new Set(configurations.map((c) => c.family))].sort();
  return Object.freeze({
    configurations: Object.freeze(configurations.map((c) => Object.freeze({ id: c.id, family: c.family, periods: c.returns.length }))),
    families: Object.freeze(families.map((family) => Object.freeze({ family, outcome: pboAcross(configurations.filter((c) => c.family === family)) }))),
    round: pboAcross(configurations),
  });
}

/**
 * DSR global de un candidato en la decisión (A.3.2, ADR 0039): su serie de lo elegido (`serie_configuracion`), con la N de
 * todo el registro en ese momento, la misma para todos, y su V[SRₙ] de una prueba sin habilidad. `lag` son los retardos de
 * sus varianzas a largo plazo, la longitud media de bloque de su bootstrap (ADR 0038).
 */
export function roundDeflatedSharpe(experiment: string, salida: unknown, trials: number, lag: number): { readonly report: DeflatedSharpeReport | null; readonly note: string | null } {
  if (!Number.isSafeInteger(lag) || lag < 1) throw new RoundMatrixError(`${experiment}: retardos inválidos (${String(lag)})`);
  const own = series(record(salida, experiment)['serie_configuracion'], `${experiment} serie_configuracion`);
  return deflatedSharpeOf(own.returns, trials, lag);
}
