// Benchmark buy-and-hold (quant-research §6; paso 26, ADR 0029): comprar al empezar el tramo con todo el capital y
// mantener, pagando los costes de la compra y, al final, los de la venta, igual que la estrategia. Con un símbolo es el
// buy-and-hold de BTC; con varios, el equiponderado de los que cotizan al empezar (universo point-in-time), sin
// rebalancear. Se calcula con los cierres, en float (análisis), en los mismos instantes que la curva de la estrategia.
//
// Fail closed: un símbolo sin cierre reciente en un instante de la curva (un hueco largo o una baja) lanza, porque la
// regla de liquidación al deslistar aún no existe (compromiso del primer universo dinámico).
import { toUtcIso, type UtcMillis } from '../shared/time.ts';
import { AnalyticsError, finite } from './performance.ts';

export interface PricePoint {
  readonly at: UtcMillis; // cierre de la vela
  readonly close: number;
}

export interface BenchmarkInput {
  readonly prices: ReadonlyMap<string, readonly PricePoint[]>; // por símbolo, en orden de cierre
  readonly from: UtcMillis; // se compra al último cierre ≤ from
  readonly samples: readonly UtcMillis[]; // instantes de la curva de la estrategia, en orden
  readonly capital: number;
  readonly costRate: number; // por lado: comisión, medio spread y slippage mínimo
  readonly maxStaleMs: number; // antigüedad máxima del último cierre en cada instante
}

export interface BenchmarkCurve {
  readonly symbols: readonly string[]; // los que se compran
  readonly equity: readonly number[]; // marcado a mercado en cada instante de `samples`
  readonly end: number; // valor de liquidación al final, neto de la venta
}

/** Índice del último punto con at ≤ t, o −1. */
function lastAtOrBefore(points: readonly PricePoint[], t: UtcMillis): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid]?.at ?? Number.POSITIVE_INFINITY) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function priceAt(symbol: string, points: readonly PricePoint[], t: UtcMillis, maxStaleMs: number): number | null {
  const point = points[lastAtOrBefore(points, t)];
  if (point === undefined) return null;
  if (t - point.at > maxStaleMs) return null;
  return finite(`cierre de ${symbol}`, point.close);
}

export function buyAndHold(input: BenchmarkInput): BenchmarkCurve {
  const capital = finite('capital', input.capital);
  const cost = finite('coste por lado', input.costRate);
  if (!(capital > 0)) throw new AnalyticsError('capital no positivo');
  if (cost < 0 || cost >= 1) throw new AnalyticsError(`coste por lado fuera de [0, 1): ${String(cost)}`);
  const held: { symbol: string; points: readonly PricePoint[]; entry: number }[] = [];
  for (const [symbol, points] of [...input.prices.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry = priceAt(symbol, points, input.from, input.maxStaleMs);
    if (entry === null) continue; // aún no cotiza al empezar: fuera del universo point-in-time
    if (!(entry > 0)) throw new AnalyticsError(`${symbol}: cierre no positivo al empezar`);
    held.push({ symbol, points, entry });
  }
  if (held.length === 0) throw new AnalyticsError('ningún símbolo del benchmark cotiza al empezar el tramo');
  const units = held.map((h) => ((capital / held.length) * (1 - cost)) / h.entry);
  const value = (t: UtcMillis): number =>
    held.reduce((total, h, i) => {
      const price = priceAt(h.symbol, h.points, t, input.maxStaleMs);
      if (price === null) throw new AnalyticsError(`${h.symbol}: sin cierre reciente el ${toUtcIso(t)} (hueco o baja)`);
      return total + (units[i] ?? 0) * price;
    }, 0);
  const equity = input.samples.map(value);
  const last = equity.at(-1) ?? held.reduce((total, h, i) => total + (units[i] ?? 0) * h.entry, 0);
  return Object.freeze({ symbols: Object.freeze(held.map((h) => h.symbol)), equity: Object.freeze(equity), end: last * (1 - cost) });
}
