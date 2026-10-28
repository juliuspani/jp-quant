// Estadística de la validación (quant-research §8; paso 26, ADR 0029): momentos, normal estándar, Probabilistic y
// Deflated Sharpe Ratio, longitud mínima de historial, Probability of Backtest Overfitting por CSCV y bootstrap
// estacionario por bloques. Funciones puras en float, sin E/S; el azar llega de fuera con su semilla (kernel/random.ts).
//
// Los Sharpe de estas fórmulas son por periodo, sin anualizar. La curtosis es la no exceso (3 en una normal). La varianza
// del Sharpe estimado lleva la autocorrelación (sharpeLongRunVariance, ADR 0038).
import type { Rng } from '../kernel/random.ts';

const EULER_GAMMA = 0.5772156649015329;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const MAX_CSCV_BLOCKS = 20;

export class StatisticsError extends Error {
  override readonly name = 'StatisticsError';
}

function checkFinite(values: readonly number[], what: string): void {
  for (const [i, v] of values.entries()) {
    if (!Number.isFinite(v)) throw new StatisticsError(`${what}: valor no finito en la posición ${String(i)}`);
  }
}

export interface Moments {
  readonly n: number;
  readonly mean: number;
  readonly std: number; // muestral (n − 1)
  readonly skewness: number | null; // γ₃ con momentos centrales; null sin variación
  readonly kurtosis: number | null; // γ₄ no exceso; null sin variación
}

/** Media, desviación típica muestral, asimetría y curtosis no exceso. Lanza con menos de dos valores. */
export function moments(values: readonly number[]): Moments {
  checkFinite(values, 'momentos');
  const n = values.length;
  if (n < 2) throw new StatisticsError(`momentos con ${String(n)} valores: hacen falta al menos 2`);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  const std = Math.sqrt(m2 / (n - 1));
  if (m2 === 0) return Object.freeze({ n, mean, std, skewness: null, kurtosis: null });
  m2 /= n;
  m3 /= n;
  m4 /= n;
  return Object.freeze({ n, mean, std, skewness: m3 / m2 ** 1.5, kurtosis: m4 / (m2 * m2) });
}

/** Φ: normal estándar acumulada (algoritmo 5666 de Hart, según West 2005), con precisión de doble. */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) throw new StatisticsError('normalCdf de NaN');
  const x = Math.abs(z);
  let tail = 0;
  if (x <= 37) {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let num = 3.52624965998911e-2 * x + 0.700383064443688;
      num = num * x + 6.37396220353165;
      num = num * x + 33.912866078383;
      num = num * x + 112.079291497871;
      num = num * x + 221.213596169931;
      num = num * x + 220.206867912376;
      let den = 8.83883476483184e-2 * x + 1.75566716318264;
      den = den * x + 16.064177579207;
      den = den * x + 86.7807322029461;
      den = den * x + 296.564248779674;
      den = den * x + 637.333633378831;
      den = den * x + 793.826512519948;
      den = den * x + 440.413735824752;
      tail = (e * num) / den;
    } else {
      let b = x + 0.65;
      b = x + 4 / b;
      b = x + 3 / b;
      b = x + 2 / b;
      b = x + 1 / b;
      tail = e / b / 2.506628274631;
    }
  }
  return z > 0 ? 1 - tail : tail;
}

const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239] as const;
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1] as const;
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783] as const;
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416] as const;

function tailQuantile(q: number): number {
  return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
}

/** Φ⁻¹: cuantil de la normal estándar (Acklam, con un paso de Halley sobre normalCdf). p en (0, 1). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new StatisticsError(`normalQuantile fuera de (0, 1): ${String(p)}`);
  const low = 0.02425;
  let x: number;
  if (p < low) x = tailQuantile(Math.sqrt(-2 * Math.log(p)));
  else if (p > 1 - low) x = -tailQuantile(Math.sqrt(-2 * Math.log(1 - p)));
  else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  }
  const u = (normalCdf(x) - p) * SQRT_2PI * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** 1 − γ₃·SR + ((γ₄ − 1)/4)·SR²: el factor de la varianza del Sharpe estimado. Lanza si no es positivo. */
function sharpeVarianceFactor(sharpe: number, skewness: number, kurtosis: number): number {
  const factor = 1 - skewness * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe;
  if (!(factor > 0) || !Number.isFinite(factor)) throw new StatisticsError(`varianza del Sharpe no positiva (${String(factor)})`);
  return factor;
}

export interface SharpeSample {
  readonly sharpe: number; // por periodo
  readonly periods: number; // T
  readonly skewness: number;
  readonly kurtosis: number; // no exceso
  // Varianza del Sharpe estimado, por T − 1: la de sharpeLongRunVariance, con autocorrelación (ADR 0038). Sin ella, la de
  // rentabilidades independientes, 1 − γ₃·SR + ((γ₄ − 1)/4)·SR².
  readonly varianceFactor?: number;
}

function varianceOf(sample: Omit<SharpeSample, 'periods'>): number {
  const factor = sample.varianceFactor ?? sharpeVarianceFactor(sample.sharpe, sample.skewness, sample.kurtosis);
  if (!(factor > 0) || !Number.isFinite(factor)) throw new StatisticsError(`varianza del Sharpe no positiva (${String(factor)})`);
  return factor;
}

/** PSR(SR*) = Φ((SR − SR*)·√(T − 1) / √v), con v la varianza del Sharpe estimado (varianceFactor). */
export function probabilisticSharpe(sample: SharpeSample, benchmark: number): number {
  const { sharpe, periods, skewness, kurtosis } = sample;
  checkFinite([sharpe, skewness, kurtosis, benchmark], 'PSR');
  if (!Number.isSafeInteger(periods) || periods < 2) throw new StatisticsError(`PSR con T = ${String(periods)}`);
  return normalCdf(((sharpe - benchmark) * Math.sqrt(periods - 1)) / Math.sqrt(varianceOf(sample)));
}

/**
 * Varianza del Sharpe estimado con autocorrelación (ADR 0038; Lo, 2002): la varianza a largo plazo de su función de
 * influencia, ψ_t = z_t − (SR/2)·(z_t² − 1) con z_t = (r_t − μ)/σ. El término sin retardo es el de rentabilidades
 * independientes, 1 − γ₃·SR + ((γ₄ − 1)/4)·SR², y se le suman las autocovarianzas de ψ hasta `lag` retardos con los
 * pesos de Bartlett de Newey y West (1987). Nunca baja del término sin retardo: corregir no puede hacer más fácil pasar.
 */
export function sharpeLongRunVariance(returns: readonly number[], lag: number): number {
  checkFinite(returns, 'varianza a largo plazo del Sharpe');
  if (!Number.isSafeInteger(lag) || lag < 0) throw new StatisticsError(`retardos inválidos: ${String(lag)}`);
  const m = moments(returns);
  if (m.skewness === null || m.kurtosis === null || !(m.std > 0)) throw new StatisticsError('rentabilidades sin variación: no hay Sharpe');
  const sharpe = m.mean / m.std;
  const independent = sharpeVarianceFactor(sharpe, m.skewness, m.kurtosis);
  const psi = returns.map((r) => {
    const z = (r - m.mean) / m.std;
    return z - (sharpe / 2) * (z * z - 1);
  });
  return Math.max(independent, independent + bartlettSerial(psi, lag));
}

/** IC del Sharpe por periodo con la varianza de su estimación: SR ± z·√(v/(T − 1)) (ADR 0038). */
export function sharpeInterval(sharpe: number, periods: number, varianceFactor: number, confidence = 0.95): { readonly lower: number; readonly upper: number } {
  checkFinite([sharpe, varianceFactor, confidence], 'IC del Sharpe');
  if (!Number.isSafeInteger(periods) || periods < 2) throw new StatisticsError(`IC del Sharpe con T = ${String(periods)}`);
  if (!(varianceFactor > 0)) throw new StatisticsError(`varianza del Sharpe no positiva (${String(varianceFactor)})`);
  const half = normalQuantile(1 - (1 - confidence) / 2) * Math.sqrt(varianceFactor / (periods - 1));
  return Object.freeze({ lower: sharpe - half, upper: sharpe + half });
}

/** SR₀ = √V·((1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))): máximo esperado de N Sharpe sin habilidad. Con N = 1, 0. */
export function expectedMaxSharpe(trials: number, variance: number): number {
  if (!Number.isSafeInteger(trials) || trials < 1) throw new StatisticsError(`N inválido: ${String(trials)}`);
  if (!(variance >= 0) || !Number.isFinite(variance)) throw new StatisticsError(`V[SR] inválida: ${String(variance)}`);
  if (trials === 1) return 0;
  return Math.sqrt(variance) * ((1 - EULER_GAMMA) * normalQuantile(1 - 1 / trials) + EULER_GAMMA * normalQuantile(1 - 1 / (trials * Math.E)));
}

/** DSR = PSR(SR₀), con N pruebas de la familia y V[SRₙ] la varianza de sus Sharpe por periodo. */
export function deflatedSharpe(sample: SharpeSample, trials: number, variance: number): { readonly sr0: number; readonly dsr: number } {
  const sr0 = expectedMaxSharpe(trials, variance);
  return Object.freeze({ sr0, dsr: probabilisticSharpe(sample, sr0) });
}

/** 2·Σ (1 − k/(L + 1))·γ(k) para k = 1…L: la parte serial de la varianza a largo plazo con los pesos de Bartlett. */
function bartlettSerial(series: readonly number[], lag: number): number {
  const n = series.length;
  const center = series.reduce((a, b) => a + b, 0) / n;
  const centred = series.map((x) => x - center);
  const maxLag = Math.min(lag, n - 1);
  let serial = 0;
  for (let k = 1; k <= maxLag; k++) {
    let covariance = 0;
    for (let t = k; t < n; t++) covariance += (centred[t] ?? 0) * (centred[t - k] ?? 0);
    serial += 2 * (1 - k / (maxLag + 1)) * (covariance / n);
  }
  return serial;
}

/**
 * V[SRₙ] del DSR (ADR 0039): la varianza del Sharpe estimado de una prueba sin habilidad con la misma longitud y la misma
 * dependencia que esta. Es la varianza a largo plazo de sus rentabilidades estandarizadas (la función de influencia del
 * Sharpe con SR = 0), con `lag` retardos de Bartlett, por T − 1. Nunca baja de 1/(T − 1), la de rentabilidades
 * independientes. No depende de ninguna otra prueba, así que no depende del orden del registro.
 */
export function nullSharpeVariance(returns: readonly number[], lag: number): number {
  checkFinite(returns, 'varianza nula del Sharpe');
  if (!Number.isSafeInteger(lag) || lag < 0) throw new StatisticsError(`retardos inválidos: ${String(lag)}`);
  if (returns.length < 2) throw new StatisticsError(`T inválido: ${String(returns.length)}`);
  const m = moments(returns);
  if (!(m.std > 0)) throw new StatisticsError('rentabilidades sin variación: no hay Sharpe');
  const standardized = returns.map((r) => (r - m.mean) / m.std);
  return Math.max(1, 1 + bartlettSerial(standardized, lag)) / (returns.length - 1);
}

/** MinTRL = 1 + v·(z/(SR − SR*))², en periodos, con v la varianza del Sharpe estimado (varianceFactor); null si SR ≤ SR*. */
export function minTrackRecordLength(sample: Omit<SharpeSample, 'periods'>, benchmark = 0, confidence = 0.95): number | null {
  const { sharpe, skewness, kurtosis } = sample;
  checkFinite([sharpe, skewness, kurtosis, benchmark], 'MinTRL');
  if (sharpe <= benchmark) return null;
  const z = normalQuantile(confidence);
  return 1 + varianceOf(sample) * (z / (sharpe - benchmark)) ** 2;
}

/** Cuantil de tipo 7 (interpolación lineal) de valores ya ordenados. */
export function sortedQuantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new StatisticsError('cuantil de una lista vacía');
  if (!(p >= 0 && p <= 1)) throw new StatisticsError(`cuantil fuera de [0, 1]: ${String(p)}`);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const a = sorted[lo] ?? Number.NaN;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)] ?? Number.NaN;
  return a + (h - lo) * (b - a);
}

function blockSharpe(sum: number, sumSq: number, n: number): number {
  const mean = sum / n;
  const variance = (sumSq - n * mean * mean) / (n - 1);
  if (variance > 0) return mean / Math.sqrt(variance);
  return mean === 0 ? 0 : mean > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

export interface PboResult {
  readonly pbo: number;
  readonly combinations: number;
  readonly blocks: number;
  readonly configurations: number;
}

/**
 * Probability of Backtest Overfitting por CSCV (quant-research §8). `returns[n]` son los T rendimientos por periodo de la
 * configuración n, alineados. Se parten en S bloques contiguos (los primeros T mod S, con una observación más) y, en cada
 * combinación de S/2 bloques dentro de muestra, se mira el rango fuera de muestra de la mejor dentro de muestra, por
 * Sharpe: ω = rango/(N + 1), con rango 1 la peor y empates al rango medio; PBO es la proporción con ln(ω/(1 − ω)) ≤ 0.
 * Con varias mejores dentro de muestra empatadas, la primera.
 */
export function probabilityOfBacktestOverfitting(returns: readonly (readonly number[])[], blocks = 16): PboResult {
  const configurations = returns.length;
  if (configurations < 2) throw new StatisticsError('PBO con menos de dos configuraciones');
  const periods = returns[0]?.length ?? 0;
  if (!Number.isSafeInteger(blocks) || blocks < 2 || blocks % 2 !== 0 || blocks > MAX_CSCV_BLOCKS) {
    throw new StatisticsError(`S debe ser par, entre 2 y ${String(MAX_CSCV_BLOCKS)}: ${String(blocks)}`);
  }
  if (periods < 2 * blocks) throw new StatisticsError(`T = ${String(periods)} no llega a dos observaciones por bloque (S = ${String(blocks)})`);
  const sizes = Array.from({ length: blocks }, (_, b) => Math.floor(periods / blocks) + (b < periods % blocks ? 1 : 0));
  // Sumas y sumas de cuadrados por bloque y configuración.
  const sums = returns.map((series, n) => {
    if (series.length !== periods) throw new StatisticsError(`la configuración ${String(n)} tiene ${String(series.length)} periodos, no ${String(periods)}`);
    checkFinite(series, `configuración ${String(n)}`);
    let start = 0;
    return sizes.map((size) => {
      let s = 0;
      let q = 0;
      for (let t = start; t < start + size; t++) {
        const v = series[t] ?? 0;
        s += v;
        q += v * v;
      }
      start += size;
      return { s, q };
    });
  });
  let combinations = 0;
  let overfit = 0;
  const half = blocks / 2;
  for (let mask = 0; mask < 2 ** blocks; mask++) {
    let bits = 0;
    for (let m = mask; m > 0; m >>= 1) bits += m & 1;
    if (bits !== half) continue;
    combinations++;
    const perf = (n: number, inSample: boolean): number => {
      let s = 0;
      let q = 0;
      let count = 0;
      for (let b = 0; b < blocks; b++) {
        const inside = ((mask >> b) & 1) === 1;
        if (inside !== inSample) continue;
        const block = sums[n]?.[b] ?? { s: 0, q: 0 };
        s += block.s;
        q += block.q;
        count += sizes[b] ?? 0;
      }
      return blockSharpe(s, q, count);
    };
    let best = 0;
    let bestIs = Number.NEGATIVE_INFINITY;
    for (let n = 0; n < configurations; n++) {
      const p = perf(n, true);
      if (p > bestIs) {
        bestIs = p;
        best = n;
      }
    }
    const oos = Array.from({ length: configurations }, (_, n) => perf(n, false));
    const target = oos[best] ?? 0;
    const below = oos.filter((p) => p < target).length;
    const equal = oos.filter((p) => p === target).length;
    const omega = (below + (equal + 1) / 2) / (configurations + 1);
    if (Math.log(omega / (1 - omega)) <= 0) overfit++;
  }
  return Object.freeze({ pbo: overfit / combinations, combinations, blocks, configurations });
}

/** Longitud media de bloque del bootstrap: al menos la duración media de una operación y ⌈T^(1/3)⌉ (quant-research §8). */
export function meanBlockLength(periods: number, meanTradeBars: number | null): number {
  if (!Number.isSafeInteger(periods) || periods < 1) throw new StatisticsError(`T inválido: ${String(periods)}`);
  return Math.max(1, Math.ceil(Math.cbrt(periods)), Math.ceil(meanTradeBars ?? 0));
}

/**
 * Índices de un remuestreo del bootstrap estacionario de Politis y Romano (1994): cada paso empieza un bloque nuevo en
 * un índice al azar con probabilidad 1/L y, si no, sigue con el siguiente, dando la vuelta al final. El remuestreo tiene
 * `length` periodos: por defecto, los de la serie; la referencia de las etapas 2 y 3 los pide de otra longitud (A.5).
 */
export function stationaryBootstrapIndices(periods: number, meanBlock: number, rng: Rng, length = periods): Int32Array {
  if (!Number.isSafeInteger(periods) || periods < 1) throw new StatisticsError(`T inválido: ${String(periods)}`);
  if (!(meanBlock >= 1) || !Number.isFinite(meanBlock)) throw new StatisticsError(`longitud media de bloque inválida: ${String(meanBlock)}`);
  if (!Number.isSafeInteger(length) || length < 1) throw new StatisticsError(`longitud del remuestreo inválida: ${String(length)}`);
  const restart = 1 / meanBlock;
  const indices = new Int32Array(length);
  let i = Math.floor(rng.next() * periods);
  indices[0] = i;
  for (let t = 1; t < length; t++) {
    i = rng.next() < restart ? Math.floor(rng.next() * periods) : (i + 1) % periods;
    indices[t] = i;
  }
  return indices;
}

export interface ConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
  readonly level: number;
  readonly resamples: number; // remuestreos con estadístico definido
  readonly discarded: number; // remuestreos en que el estadístico no está definido (null)
}

export interface BootstrapOptions {
  readonly resamples: number;
  readonly meanBlock: number;
  readonly rng: Rng;
  readonly level?: number; // 0,95 por defecto
}

/**
 * IC por percentiles del bootstrap estacionario. `statistic` recibe los índices de cada remuestreo y los aplica a sus
 * series (así un estadístico emparejado, como el exceso sobre el benchmark, remuestrea los mismos periodos en ambas).
 * Devuelve null si ningún remuestreo da un estadístico definido.
 */
export function bootstrapInterval(periods: number, statistic: (indices: Int32Array) => number | null, options: BootstrapOptions): ConfidenceInterval | null {
  return bootstrapIntervals(periods, { value: statistic }, options).value ?? null;
}

/** Como bootstrapInterval, con varios estadísticos calculados sobre los mismos remuestreos. */
export function bootstrapIntervals<K extends string>(
  periods: number,
  statistics: Readonly<Record<K, (indices: Int32Array) => number | null>>,
  options: BootstrapOptions,
): Readonly<Record<K, ConfidenceInterval | null>> {
  const level = options.level ?? 0.95;
  if (!Number.isSafeInteger(options.resamples) || options.resamples < 1) throw new StatisticsError(`remuestreos inválidos: ${String(options.resamples)}`);
  if (!(level > 0 && level < 1)) throw new StatisticsError(`nivel inválido: ${String(level)}`);
  const names = Object.keys(statistics) as K[];
  const values = new Map<K, number[]>(names.map((name) => [name, []]));
  for (let k = 0; k < options.resamples; k++) {
    const indices = stationaryBootstrapIndices(periods, options.meanBlock, options.rng);
    for (const name of names) {
      const value = statistics[name](indices);
      if (value === null) continue;
      if (Number.isNaN(value)) throw new StatisticsError(`el estadístico ${name} del bootstrap dio NaN`);
      values.get(name)?.push(value);
    }
  }
  const tail = (1 - level) / 2;
  const result = {} as Record<K, ConfidenceInterval | null>;
  for (const name of names) {
    const sorted = (values.get(name) ?? []).sort((a, b) => a - b);
    result[name] =
      sorted.length === 0
        ? null
        : Object.freeze({
            lower: sortedQuantile(sorted, tail),
            upper: sortedQuantile(sorted, 1 - tail),
            level,
            resamples: sorted.length,
            discarded: options.resamples - sorted.length,
          });
  }
  return Object.freeze(result);
}
