// Control aleatorio y señal desplazada (quant-research §6; docs/PROMOTION_CRITERIA.md A.3.12 y A.3.15; paso 27B,
// ADR 0031). Dos partes separadas:
// - las colocaciones: el control aleatorio pone las mismas operaciones (mismo número, símbolo, duración y fracción) en
//   instantes al azar del mismo tramo, sin que dos del mismo símbolo se solapen, al menos 1000 veces; la señal desplazada
//   gira el calendario de cada tramo un número de periodos al azar y conserva la estructura de las operaciones;
// - la evaluación: un simulador de operaciones sobre los cierres de cada tramo, en las marcas de la curva. Cada operación
//   gana o pierde lo que se mueve el cierre con una fracción fija del patrimonio y paga el coste por lado al entrar y al
//   salir; las rentabilidades de un periodo suman las de las operaciones abiertas, sin componer.
// El simulador es una aproximación. Su validez se comprueba con la réplica (las operaciones de la estrategia con el mismo
// simulador): si se aleja más de un 10 % del Sharpe del backtester, el simulador no decide y las mismas colocaciones se
// evalúan con el backtester real (lo hace app/criteria-evidence.ts). Puro: el azar llega de fuera con su semilla.
import type { Rng } from '../kernel/random.ts';
import { AnalyticsError, finite, sharpeOf } from './performance.ts';
import { sortedQuantile } from './statistics.ts';

/** Mínimo de simulaciones del control aleatorio (quant-research §6). */
export const RANDOM_CONTROL_SIMULATIONS = 1000;
/** Desplazamientos al azar de la señal: se informa su mediana, que no depende de un solo sorteo. */
export const SIGNAL_SHIFTS = 100;
/** Desviación máxima de la réplica respecto del Sharpe del backtester para que el simulador decida (fijada por la persona). */
export const MAX_REPLICA_DEVIATION = 0.1;
// Intentos de colocar las operaciones de un símbolo en un tramo sin caer donde no hay precio.
const PLACEMENT_TRIES = 100;

export interface ControlFold {
  readonly bars: number; // marcas de la curva del tramo: da bars − 1 periodos
  readonly prices: ReadonlyMap<string, readonly (number | null)[]>; // cierre de cada símbolo en cada marca; null sin precio
}

export interface ControlTrade {
  readonly symbol: string;
  readonly fold: number;
  readonly start: number; // marca en que se abre: ocupa los periodos start + 1 … start + bars
  readonly bars: number; // ≥ 1
  readonly fraction: number; // invertido / patrimonio al abrir
}

export interface ControlMarket {
  readonly folds: readonly ControlFold[];
  readonly costRate: number; // por lado: comisión, medio spread y slippage, con el multiplicador de costes
  readonly perYear: number;
}

function checkTrade(market: ControlMarket, t: ControlTrade): void {
  const fold = market.folds[t.fold];
  if (fold === undefined) throw new AnalyticsError(`operación en un tramo que no existe: ${String(t.fold)}`);
  if (!Number.isSafeInteger(t.bars) || t.bars < 1) throw new AnalyticsError(`duración inválida: ${String(t.bars)}`);
  if (!Number.isSafeInteger(t.start) || t.start < 0 || t.start + t.bars > fold.bars - 1) {
    throw new AnalyticsError(`operación fuera del tramo ${String(t.fold)}: marca ${String(t.start)} durante ${String(t.bars)}`);
  }
  if (!(finite('fracción', t.fraction) >= 0)) throw new AnalyticsError(`fracción negativa: ${String(t.fraction)}`);
  if (!fold.prices.has(t.symbol)) throw new AnalyticsError(`${t.symbol}: sin precios en el tramo ${String(t.fold)}`);
}

/** Si el símbolo tiene precio en todas las marcas de la operación colocada en `start`. */
function fits(fold: ControlFold, symbol: string, start: number, bars: number): boolean {
  const prices = fold.prices.get(symbol);
  if (prices === undefined) return false;
  for (let k = start; k <= start + bars; k++) {
    const p = prices[k];
    if (p === null || p === undefined || !(p > 0)) return false;
  }
  return true;
}

/** Rentabilidades por periodo de un conjunto de operaciones, tramo tras tramo. Lanza si una cae donde no hay precio. */
export function simulateTrades(market: ControlMarket, trades: readonly ControlTrade[]): number[] {
  const cost = finite('coste por lado', market.costRate);
  if (cost < 0 || cost >= 1) throw new AnalyticsError(`coste por lado fuera de [0, 1): ${String(cost)}`);
  const series = market.folds.map((f) => new Array<number>(Math.max(0, f.bars - 1)).fill(0));
  for (const t of trades) {
    checkTrade(market, t);
    const fold = market.folds[t.fold];
    const returns = series[t.fold];
    if (fold === undefined || returns === undefined) continue;
    if (!fits(fold, t.symbol, t.start, t.bars)) throw new AnalyticsError(`${t.symbol}: sin precio en la operación del tramo ${String(t.fold)}`);
    const prices = fold.prices.get(t.symbol) ?? [];
    for (let k = t.start + 1; k <= t.start + t.bars; k++) {
      const previous = prices[k - 1] ?? Number.NaN;
      const current = prices[k] ?? Number.NaN;
      returns[k - 1] = (returns[k - 1] ?? 0) + t.fraction * (current / previous - 1);
    }
    returns[t.start] = (returns[t.start] ?? 0) - t.fraction * cost;
    returns[t.start + t.bars - 1] = (returns[t.start + t.bars - 1] ?? 0) - t.fraction * cost;
  }
  return series.flat();
}

/** Sharpe anualizado de un conjunto de operaciones con el simulador; null sin variación. */
export function simulatedSharpe(market: ControlMarket, trades: readonly ControlTrade[]): number | null {
  const { sharpe } = sharpeOf(simulateTrades(market, trades));
  return sharpe === null ? null : sharpe * Math.sqrt(market.perYear);
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) continue;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

/**
 * Una colocación al azar: las operaciones de cada símbolo en cada tramo, en orden al azar y con huecos al azar entre
 * ellas (uniforme entre las colocaciones sin solapes), donde su símbolo tiene precio. Lanza si no hay sitio.
 */
export function randomPlacement(market: ControlMarket, trades: readonly ControlTrade[], rng: Rng): ControlTrade[] {
  const groups = new Map<string, ControlTrade[]>();
  for (const t of trades) {
    checkTrade(market, t);
    const key = `${String(t.fold)}|${t.symbol}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const placed: ControlTrade[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) ?? [];
    const first = group[0];
    const fold = first === undefined ? undefined : market.folds[first.fold];
    if (first === undefined || fold === undefined) continue;
    const periods = fold.bars - 1;
    const free = periods - group.reduce((n, t) => n + t.bars, 0);
    if (free < 0) throw new AnalyticsError(`${first.symbol}: las operaciones no caben en el tramo ${String(first.fold)}`);
    let done: ControlTrade[] | null = null;
    for (let attempt = 0; attempt < PLACEMENT_TRIES && done === null; attempt++) {
      const order = shuffle([...group], rng);
      const gaps = order.map(() => Math.floor(rng.next() * (free + 1))).sort((a, b) => a - b);
      let used = 0;
      const candidate = order.map((t, i) => {
        const start = (gaps[i] ?? 0) + used;
        used += t.bars;
        return { ...t, start };
      });
      if (candidate.every((t) => fits(fold, t.symbol, t.start, t.bars))) done = candidate;
    }
    if (done === null) throw new AnalyticsError(`${first.symbol}: sin colocación con precio en el tramo ${String(first.fold)}`);
    placed.push(...done);
  }
  return placed;
}

/** `count` colocaciones al azar de las mismas operaciones. */
export function randomPlacements(market: ControlMarket, trades: readonly ControlTrade[], count: number, rng: Rng): ControlTrade[][] {
  if (!Number.isSafeInteger(count) || count < 1) throw new AnalyticsError(`simulaciones inválidas: ${String(count)}`);
  if (trades.length === 0) throw new AnalyticsError('sin operaciones: el control aleatorio no tiene qué imitar');
  return Array.from({ length: count }, () => randomPlacement(market, trades, rng));
}

/**
 * `count` desplazamientos de la señal: en cada uno, el calendario de cada tramo gira un número de periodos al azar. La
 * operación que pasaría del final se corta en él, así que no se solapa con las que dan la vuelta.
 */
export function shiftedPlacements(market: ControlMarket, trades: readonly ControlTrade[], count: number, rng: Rng): ControlTrade[][] {
  if (!Number.isSafeInteger(count) || count < 1) throw new AnalyticsError(`desplazamientos inválidos: ${String(count)}`);
  if (trades.length === 0) throw new AnalyticsError('sin operaciones: no hay señal que desplazar');
  for (const t of trades) checkTrade(market, t);
  return Array.from({ length: count }, () => {
    const offsets = market.folds.map((f) => 1 + Math.floor(rng.next() * Math.max(1, f.bars - 2)));
    return trades.map((t) => {
      const periods = (market.folds[t.fold]?.bars ?? 1) - 1;
      const start = (t.start + (offsets[t.fold] ?? 0)) % periods;
      return { ...t, start, bars: Math.min(t.bars, periods - start) };
    });
  });
}

export interface ControlSummary {
  readonly simulations: number;
  readonly discarded: number; // sin Sharpe (sin variación)
  readonly p95: number;
  readonly median: number;
  readonly sharpes: readonly number[]; // ordenados
}

/** Percentil 95 y mediana de los Sharpe de las simulaciones; las que no tienen Sharpe se descartan y se cuentan. */
export function summarizeControl(values: readonly (number | null)[]): ControlSummary {
  const sharpes = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (sharpes.length === 0) throw new AnalyticsError('ninguna simulación tiene Sharpe');
  return Object.freeze({
    simulations: values.length,
    discarded: values.length - sharpes.length,
    p95: sortedQuantile(sharpes, 0.95),
    median: sortedQuantile(sharpes, 0.5),
    sharpes: Object.freeze(sharpes),
  });
}

export interface RandomControl extends ControlSummary {
  readonly replica: number | null; // Sharpe de las operaciones de la estrategia con el mismo simulador
}

/** Control aleatorio con el simulador: `simulations` colocaciones al azar. */
export function randomControl(market: ControlMarket, trades: readonly ControlTrade[], simulations: number, rng: Rng): RandomControl {
  const placements = randomPlacements(market, trades, simulations, rng);
  const summary = summarizeControl(placements.map((p) => simulatedSharpe(market, p)));
  return Object.freeze({ ...summary, replica: simulatedSharpe(market, trades) });
}

/** Fracción de las simulaciones con un Sharpe menor que `value`: su percentil en el control. */
export function percentileOf(sortedSharpes: readonly number[], value: number): number {
  if (sortedSharpes.length === 0) throw new AnalyticsError('percentil en una distribución vacía');
  return sortedSharpes.filter((s) => s < value).length / sortedSharpes.length;
}

/** Señal desplazada con el simulador: mediana del Sharpe de `shifts` desplazamientos (sin Sharpe, cuenta como 0). */
export function shiftedSignal(market: ControlMarket, trades: readonly ControlTrade[], shifts: number, rng: Rng): { readonly shifts: number; readonly median: number } {
  const values = shiftedPlacements(market, trades, shifts, rng).map((p) => simulatedSharpe(market, p) ?? 0).sort((a, b) => a - b);
  return Object.freeze({ shifts, median: sortedQuantile(values, 0.5) });
}

/** |réplica − real| / |real|; null si falta alguno o el real es 0 (no se puede comprobar: el simulador no decide). */
export function replicaDeviation(replica: number | null, actual: number | null): number | null {
  if (replica === null || actual === null || actual === 0) return null;
  return Math.abs(replica - actual) / Math.abs(actual);
}

/** Si el simulador puede decidir: su réplica se aleja como mucho un 10 % del Sharpe del backtester. */
export function simulatorValid(replica: number | null, actual: number | null): boolean {
  const deviation = replicaDeviation(replica, actual);
  return deviation !== null && deviation <= MAX_REPLICA_DEVIATION;
}
