// Precios sin estructura para la prueba de humo (quant-research §6; docs/PROMOTION_CRITERIA.md A.3.15; paso 27B,
// ADR 0031). Baraja, con semilla, las velas de cada símbolo: cada vela conserva su forma (apertura, máximo, mínimo y
// cierre relativos al cierre anterior, y su volumen), pero en un orden al azar. El camino resultante tiene la misma
// distribución de rentabilidades y el mismo precio final, sin tendencias, regímenes ni autocorrelación: un paseo
// aleatorio. Las marcas de tiempo no cambian, así que el calendario, los tramos y las altas y bajas son los mismos.
// Son datos sintéticos: el ejecutor los usa solo para comprobar que la estrategia no «gana» donde no hay nada que ganar.
import type { HistoricalCandle } from '../historical/types.ts';
import type { Rng } from '../kernel/random.ts';
import { Decimal } from '../shared/decimal.ts';

const PRICE_SCALE = 10;

function price(value: number): Decimal {
  return Decimal.fromAnalysis(value, PRICE_SCALE, 'HALF_EVEN');
}

/** Velas barajadas de cada símbolo. La primera de cada uno queda igual y ancla el camino. */
export function shuffledCandles(candles: readonly HistoricalCandle[], rng: Rng): HistoricalCandle[] {
  const bySymbol = new Map<string, HistoricalCandle[]>();
  for (const c of candles) bySymbol.set(c.symbol, [...(bySymbol.get(c.symbol) ?? []), c]);
  const out: HistoricalCandle[] = [];
  for (const symbol of [...bySymbol.keys()].sort()) {
    const series = (bySymbol.get(symbol) ?? []).sort((a, b) => a.openTime - b.openTime);
    const first = series[0];
    if (first === undefined) continue;
    out.push(first);
    const shapes = series.slice(1).map((c, i) => {
      const previous = (series[i] ?? first).close.toAnalysis();
      return { open: c.open.toAnalysis() / previous, high: c.high.toAnalysis() / previous, low: c.low.toAnalysis() / previous, close: c.close.toAnalysis() / previous, volume: c.volume };
    });
    for (let i = shapes.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const a = shapes[i];
      const b = shapes[j];
      if (a === undefined || b === undefined) continue;
      shapes[i] = b;
      shapes[j] = a;
    }
    let previous = first.close.toAnalysis();
    for (const [i, shape] of shapes.entries()) {
      const c = series[i + 1];
      if (c === undefined) continue;
      const close = previous * shape.close;
      out.push({
        ...c,
        open: price(previous * shape.open),
        high: price(previous * shape.high),
        low: price(previous * shape.low),
        close: price(close),
        volume: shape.volume,
      });
      previous = close;
    }
  }
  return out;
}
