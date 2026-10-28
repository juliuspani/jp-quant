// Catálogo de features (ADR 0025). Cada una fija fórmula, ventana, calentamiento y política de datos que faltan; el
// timestamp es el mismo para todas y lo pone el motor. Sobre velas cerradas: la vela t es la última cerrada y
// recibida en el instante del cálculo. Ningún periodo tiene valor por defecto: los elige el pre-registro (paso 25).
import type { CandleWindow, FeatureDefinition } from './types.ts';

// quant-research §3: los indicadores recursivos se calientan con 3 a 5 veces su periodo. Se toma el más exigente.
export const RECURSIVE_WARMUP_FACTOR = 5;

const NO_DATA = 'null sin warmupBars velas observadas o si les faltan más de ⌊√window / 2⌋; la que falta se excluye, nunca se rellena (ADR 0036)';

function checkPeriod(feature: string, period: number, min: number): void {
  if (!Number.isSafeInteger(period) || period < min) throw new RangeError(`${feature}: periodo inválido ${String(period)} (entero ≥ ${String(min)})`);
}

function last(values: readonly number[], offset = 0): number {
  const value = values[values.length - 1 - offset];
  if (value === undefined) throw new RangeError(`ventana demasiado corta: falta el valor ${String(offset)} desde el final`);
  return value;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** EMA con α = 2/(n+1), sembrada con la media simple de los n primeros valores de la ventana. */
function emaOf(values: readonly number[], period: number): number {
  const alpha = 2 / (period + 1);
  let ema = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) ema = alpha * (values[i] ?? Number.NaN) + (1 - alpha) * ema;
  return ema;
}

/** Suavizado de Wilder (α = 1/n), sembrado con la media simple de los n primeros valores. */
function wilderOf(values: readonly number[], period: number): number {
  let avg = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) avg = (avg * (period - 1) + (values[i] ?? Number.NaN)) / period;
  return avg;
}

/** Cambios de cierre a cierre: c[i] − c[i−1]. */
function changes(close: readonly number[]): number[] {
  return close.slice(1).map((c, i) => c - (close[i] ?? Number.NaN));
}

/** Rentabilidad logarítmica a k velas. */
export function logReturn(k: number): FeatureDefinition {
  checkPeriod('logReturn', k, 1);
  return {
    id: `logret_${String(k)}`,
    version: 1,
    formula: `ln(C[t] / C[t−${String(k)}])`,
    window: k + 1,
    warmupBars: k + 1,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => Math.log(last(w.close) / last(w.close, k)),
  };
}

/** Momentum como tasa de cambio simple a n velas. */
export function momentum(n: number): FeatureDefinition {
  checkPeriod('momentum', n, 1);
  return {
    id: `mom_${String(n)}`,
    version: 1,
    formula: `C[t] / C[t−${String(n)}] − 1`,
    window: n + 1,
    warmupBars: n + 1,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => last(w.close) / last(w.close, n) - 1,
  };
}

/** Volatilidad realizada: desviación típica muestral de las n últimas rentabilidades logarítmicas, por vela. */
export function realizedVolatility(n: number): FeatureDefinition {
  checkPeriod('realizedVolatility', n, 2);
  return {
    id: `realvol_${String(n)}`,
    version: 1,
    formula: `√( Σ (r[i] − r̄)² / (${String(n)} − 1) ), r[i] = ln(C[i] / C[i−1]), i = t−${String(n - 1)}…t; sin anualizar`,
    window: n + 1,
    warmupBars: n + 1,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => {
      const returns = w.close.slice(1).map((c, i) => Math.log(c / (w.close[i] ?? Number.NaN)));
      const m = mean(returns);
      let squares = 0;
      for (const r of returns) squares += (r - m) ** 2;
      return Math.sqrt(squares / (n - 1));
    },
  };
}

/** RSI de Wilder sobre una ventana fija de 5·n cambios. */
export function rsi(n: number): FeatureDefinition {
  checkPeriod('rsi', n, 2);
  const bars = RECURSIVE_WARMUP_FACTOR * n + 1;
  return {
    id: `rsi_${String(n)}`,
    version: 1,
    formula:
      `100 · G / (G + L); G y L: medias de Wilder (α = 1/${String(n)}) de subidas y bajadas de cierre a cierre, ` +
      `sembradas con la media simple de los ${String(n)} primeros cambios de la ventana`,
    window: n + 1,
    warmupBars: bars,
    missingData: `${NO_DATA}; null si G + L = 0 (sin movimiento en la ventana: indefinido, no 0 ni 50)`,
    compute: (w: CandleWindow) => {
      const d = changes(w.close);
      const gain = wilderOf(d.map((x) => Math.max(x, 0)), n);
      const loss = wilderOf(d.map((x) => Math.max(-x, 0)), n);
      return gain + loss === 0 ? null : (100 * gain) / (gain + loss);
    },
  };
}

/** Media móvil exponencial del cierre sobre una ventana fija de 5·n velas. */
export function ema(n: number): FeatureDefinition {
  checkPeriod('ema', n, 2);
  return {
    id: `ema_${String(n)}`,
    version: 1,
    formula: `E[i] = α·C[i] + (1 − α)·E[i−1], α = 2/(${String(n)} + 1), sembrada con la media simple de los ${String(n)} primeros cierres de la ventana`,
    window: n,
    warmupBars: RECURSIVE_WARMUP_FACTOR * n,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => emaOf(w.close, n),
  };
}

/**
 * Cierre de la última vela. Justificado (paso 24): las estrategias de referencia (src/strategy/baselines.ts) fijan su stop
 * como una fracción del cierre, y la estrategia solo ve features.
 */
export function close(): FeatureDefinition {
  return {
    id: 'close',
    version: 1,
    formula: 'C[t], cierre de la última vela cerrada',
    window: 1,
    warmupBars: 1,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => last(w.close),
  };
}

/** Volumen de la última vela, en unidades del activo base. */
export function volume(): FeatureDefinition {
  return {
    id: 'volume',
    version: 1,
    formula: 'V[t], en unidades del activo base',
    window: 1,
    warmupBars: 1,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => last(w.volume),
  };
}

/** Volumen relativo (RVOL): volumen de la última vela frente a la media de las n anteriores, sin incluirla. */
export function relativeVolume(n: number): FeatureDefinition {
  checkPeriod('relativeVolume', n, 1);
  return {
    id: `relvol_${String(n)}`,
    version: 1,
    formula: `V[t] / media(V[t−${String(n)}]…V[t−1])`,
    window: n + 1,
    warmupBars: n + 1,
    missingData: `${NO_DATA}; null si la media de las ${String(n)} velas anteriores es 0`,
    compute: (w: CandleWindow) => {
      const previous = mean(w.volume.slice(0, n));
      return previous === 0 ? null : last(w.volume) / previous;
    },
  };
}

/**
 * ATR de Wilder sobre una ventana fija de 5·n rangos verdaderos. Justificado: la única estrategia del repositorio
 * (src/strategy/trend.ts) usa el ATR para sus stops, y ARCHITECTURE.md §18 lo pasa a features/.
 */
export function atr(n: number): FeatureDefinition {
  checkPeriod('atr', n, 2);
  return {
    id: `atr_${String(n)}`,
    version: 1,
    formula:
      `media de Wilder (α = 1/${String(n)}) de TR[i] = max(H[i] − L[i], |H[i] − C[i−1]|, |L[i] − C[i−1]|), ` +
      `sembrada con la media simple de los ${String(n)} primeros TR de la ventana`,
    window: n + 1,
    warmupBars: RECURSIVE_WARMUP_FACTOR * n + 1,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => {
      const tr = w.close.slice(1).map((_, j) => {
        const high = w.high[j + 1] ?? Number.NaN;
        const low = w.low[j + 1] ?? Number.NaN;
        const prevClose = w.close[j] ?? Number.NaN;
        return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      });
      return wilderOf(tr, n);
    },
  };
}

/**
 * Media móvil simple del cierre de las n últimas velas, incluida la última. Justificado (paso 25, ADR 0028): la reversión
 * a la media de Connors y Alvarez filtra con la media simple de 200 velas y sale al cruzar la de 5.
 */
export function sma(n: number): FeatureDefinition {
  checkPeriod('sma', n, 2);
  return {
    id: `sma_${String(n)}`,
    version: 1,
    formula: `media(C[t−${String(n - 1)}]…C[t])`,
    window: n,
    warmupBars: n,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => mean(w.close.slice(-n)),
  };
}

/**
 * Máximo de Donchian: el máximo de las n velas anteriores, sin la última. Justificado (paso 25, ADR 0028): la tendencia
 * de los Turtle entra cuando el precio supera el máximo de las n velas previas; con la última incluida no lo superaría nunca.
 */
export function donchianHigh(n: number): FeatureDefinition {
  checkPeriod('donchianHigh', n, 1);
  return {
    id: `donchmax_${String(n)}`,
    version: 1,
    formula: `max(H[t−${String(n)}]…H[t−1]), sin la vela t`,
    window: n + 1,
    warmupBars: n + 1,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => Math.max(...w.high.slice(-n - 1, -1)),
  };
}

/** Mínimo de Donchian: el mínimo de las n velas anteriores, sin la última. Justificado: salida de la tendencia (ídem). */
export function donchianLow(n: number): FeatureDefinition {
  checkPeriod('donchianLow', n, 1);
  return {
    id: `donchmin_${String(n)}`,
    version: 1,
    formula: `min(L[t−${String(n)}]…L[t−1]), sin la vela t`,
    window: n + 1,
    warmupBars: n + 1,
    missingData: NO_DATA,
    compute: (w: CandleWindow) => Math.min(...w.low.slice(-n - 1, -1)),
  };
}

// Todas las features, por nombre. La prueba anti look-ahead las recorre todas, y otra prueba comprueba que cada
// función exportada de este archivo está aquí: una feature nueva no puede quedarse fuera.
export const FEATURE_CATALOG: Readonly<Record<string, (period: number) => FeatureDefinition>> = Object.freeze({
  logReturn,
  momentum,
  realizedVolatility,
  rsi,
  ema,
  close: () => close(),
  volume: () => volume(),
  relativeVolume,
  atr,
  sma,
  donchianHigh,
  donchianLow,
  lagged: (period: number) => lagged(close(), period),
});

/**
 * La misma feature con `bars` velas de retraso: calcula sobre la ventana sin sus `bars` últimas velas, así que en t da lo
 * que daba en t − bars. Su id lleva el retraso: 'close_retraso1'. Justificado (paso 27B, ADR 0031): la prueba de estrés de un retraso de una vela en la ejecución
 * (docs/PROMOTION_CRITERIA.md, tabla A.3.7).
 */
export function lagged(feature: FeatureDefinition, bars: number): FeatureDefinition {
  checkPeriod('lagged', bars, 1);
  const drop = (w: CandleWindow): CandleWindow => ({
    ...w,
    open: w.open.slice(0, -bars),
    high: w.high.slice(0, -bars),
    low: w.low.slice(0, -bars),
    close: w.close.slice(0, -bars),
    volume: w.volume.slice(0, -bars),
  });
  return {
    id: `${feature.id}_retraso${String(bars)}`,
    version: feature.version,
    formula: `${feature.formula}, calculada ${String(bars)} vela(s) antes`,
    window: feature.window + bars,
    warmupBars: feature.warmupBars + bars,
    missingData: feature.missingData,
    compute: (w: CandleWindow) => feature.compute(drop(w)),
  };
}
