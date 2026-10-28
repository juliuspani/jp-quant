// Distribución de referencia de las etapas 2 y 3 (docs/PROMOTION_CRITERIA.md A.5 y A.6.1): bootstrap estacionario de la
// serie fuera de muestra de un experimento, con remuestreos de la longitud del periodo hacia delante. Da el percentil 5
// de la rentabilidad neta (A.5.1), el percentil 95 de la caída máxima (A.5.2) y el intervalo de la frecuencia (A.5.3).
// La comprobación hacia delante de A (ADR 0043) fija con ella sus umbrales antes de que existan los datos. Funciones
// puras en float, sin E/S; el azar llega de fuera con su semilla (kernel/random.ts).
import type { Rng } from '../kernel/random.ts';
import { drawdownOf } from './performance.ts';
import { sortedQuantile, stationaryBootstrapIndices, StatisticsError } from './statistics.ts';

const MAX_POISSON_MEAN = 700; // e^(−700) aún es un float normal; por encima, la primera probabilidad se va a 0

export interface ForwardReferenceOptions {
  readonly length: number; // periodos del periodo hacia delante
  readonly meanBlock: number; // la longitud media de bloque del informe del experimento
  readonly resamples: number;
  readonly rng: Rng;
}

export interface ForwardReference {
  readonly returnP5: number; // A.5.1: percentil 5 de la rentabilidad neta compuesta de cada remuestreo
  readonly drawdownP95: number; // A.5.2: percentil 95 de su caída máxima
  readonly resamples: number;
}

/**
 * Percentiles de A.5.1 y A.5.2. Cada remuestreo encadena sus rentabilidades por periodo desde un patrimonio de 1, como un
 * tramo que empieza sin posiciones, y da su rentabilidad compuesta y la caída máxima de ese camino.
 */
export function forwardReference(returns: readonly number[], options: ForwardReferenceOptions): ForwardReference {
  if (returns.length === 0) throw new StatisticsError('la serie de referencia está vacía');
  for (const [i, r] of returns.entries()) {
    if (!(Number.isFinite(r) && r > -1)) throw new StatisticsError(`rentabilidad inválida en la posición ${String(i)}: ${String(r)}`);
  }
  if (!Number.isSafeInteger(options.length) || options.length < 1) throw new StatisticsError(`longitud del remuestreo inválida: ${String(options.length)}`);
  if (!Number.isSafeInteger(options.resamples) || options.resamples < 1) throw new StatisticsError(`remuestreos inválidos: ${String(options.resamples)}`);
  const compounded: number[] = [];
  const drawdowns: number[] = [];
  const equity = new Array<number>(options.length + 1).fill(1);
  for (let k = 0; k < options.resamples; k++) {
    const indices = stationaryBootstrapIndices(returns.length, options.meanBlock, options.rng, options.length);
    for (let t = 0; t < options.length; t++) {
      equity[t + 1] = (equity[t] ?? Number.NaN) * (1 + (returns[indices[t] ?? -1] ?? Number.NaN));
    }
    compounded.push((equity[options.length] ?? Number.NaN) - 1);
    drawdowns.push(drawdownOf(equity).maxDrawdown);
  }
  compounded.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  return Object.freeze({
    returnP5: sortedQuantile(compounded, 0.05),
    drawdownP95: sortedQuantile(drawdowns, 0.95),
    resamples: options.resamples,
  });
}

/**
 * A.5.3: intervalo central de una Poisson de media `mean` al nivel `level`. `lower` es el menor k con P(X ≤ k) > (1 − level)/2
 * y `upper`, el menor k con P(X ≤ k) ≥ 1 − (1 − level)/2: fuera queda como mucho (1 − level)/2 por cada lado.
 */
export function poissonCentralInterval(mean: number, level = 0.95): { readonly lower: number; readonly upper: number } {
  if (!(Number.isFinite(mean) && mean > 0 && mean <= MAX_POISSON_MEAN)) throw new StatisticsError(`media de la Poisson inválida: ${String(mean)}`);
  if (!(level > 0 && level < 1)) throw new StatisticsError(`nivel inválido: ${String(level)}`);
  const tail = (1 - level) / 2;
  const limit = Math.ceil(mean + 50 * Math.sqrt(mean) + 100); // muy por encima de cualquier cuantil razonable
  let k = 0;
  let p = Math.exp(-mean);
  let cdf = p;
  let lower = cdf > tail ? 0 : null;
  while (cdf < 1 - tail) {
    if (k >= limit) throw new StatisticsError(`la Poisson de media ${String(mean)} no llega al nivel ${String(level)}`);
    k++;
    p *= mean / k;
    cdf += p;
    if (lower === null && cdf > tail) lower = k;
  }
  return Object.freeze({ lower: lower ?? k, upper: k });
}
