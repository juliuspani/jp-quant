// Liquidez del simulador de ejecución (ADR 0026). Con libro de órdenes, una orden a mercado recorre sus niveles. Sin
// libro, que es el caso de todo el histórico actual (solo velas), se construye un libro sintético conservador a partir
// de la vela de ejecución:
// - precio de referencia: la apertura de la vela que contiene la llegada de la orden, la «apertura siguiente» de
//   quant-research §3 (la orden sale al cierre más la latencia);
// - mejor ask y mejor bid: la referencia ± el medio spread, redondeados contra quien opera al paso de precio;
// - profundidad por lado: `participation` del volumen de esa vela, repartida en `levels` niveles iguales, cada uno
//   `impactPerLevel` peor que el anterior.
// En los dos casos, cada fill paga además el slippage mínimo (quant-research §5), y su precio se redondea contra quien
// opera. La cotización que ve el sistema sale del cierre de cada vela con el mismo spread (quoteFromCandle). Nada aquí
// es float.
import type { BookLevel, BookSnapshot, Instrument, QuoteSnapshot } from '../kernel/market-data.ts';
import { Decimal, type Price, type Quantity } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { Side } from '../shared/trading.ts';
import type { UtcMillis } from '../shared/time.ts';

export interface DepthModel {
  readonly participation: Decimal; // fracción del volumen de la vela de ejecución que ofrece el libro sintético por lado
  readonly levels: number; // niveles en que se reparte esa profundidad
  readonly impactPerLevel: Decimal; // empeoramiento del precio en cada nivel, en fracción del mejor precio
}

// Valores de partida, conservadores (ADR 0026): no salen de ningún dato y no se ajustan a la vista de un resultado.
export const DEFAULT_DEPTH_MODEL: DepthModel = Object.freeze({
  participation: Decimal.parse('0.02'),
  levels: 5,
  impactPerLevel: Decimal.parse('0.0005'),
});

const ONE = Decimal.parse('1');
const MAX_LEVELS = 50;
const DIV_SCALE = 18;

export function checkDepthModel(model: DepthModel): void {
  if (!model.participation.isPositive() || model.participation.gt(ONE)) {
    throw new RangeError(`participation debe estar en (0, 1]: ${model.participation.toString()}`);
  }
  if (!Number.isSafeInteger(model.levels) || model.levels < 1 || model.levels > MAX_LEVELS) {
    throw new RangeError(`levels debe ser un entero de 1 a ${String(MAX_LEVELS)}: ${String(model.levels)}`);
  }
  if (model.impactPerLevel.isNegative() || !model.impactPerLevel.lt(ONE)) {
    throw new RangeError(`impactPerLevel debe estar en [0, 1): ${model.impactPerLevel.toString()}`);
  }
}

/** Precio redondeado al paso, siempre contra quien opera: una compra paga más y una venta cobra menos. */
export function againstTrader(price: Price, side: Side, priceStep: Price): Price {
  return price.roundToStep(priceStep, side === 'buy' ? 'UP' : 'DOWN');
}

/** Mejor ask y mejor bid alrededor de `reference`: ± el medio spread, redondeados contra quien opera. */
function touch(reference: Price, instrument: Instrument, halfSpread: Decimal): { readonly ask: Price; readonly bid: Price } {
  return {
    ask: againstTrader(reference.times(ONE.plus(halfSpread)), 'buy', instrument.priceStep),
    bid: againstTrader(reference.times(ONE.minus(halfSpread)), 'sell', instrument.priceStep),
  };
}

/** Cantidad de cada nivel del libro sintético: `participation` del volumen, repartida en `levels`, a la baja al paso. */
function levelQuantity(volume: Quantity, instrument: Instrument, depth: DepthModel): Quantity {
  const levels = Decimal.parse(String(depth.levels));
  return volume.times(depth.participation).div(levels, DIV_SCALE, 'DOWN').roundToStep(instrument.quantityStep, 'DOWN');
}

/**
 * Libro sintético alrededor de `reference` con el volumen `volume` de la vela de ejecución. `impactPerLevel` llega ya
 * multiplicado por el estrés de costes. Sin volumen suficiente para un paso de cantidad, los niveles quedan vacíos: no
 * hay liquidez.
 */
export function syntheticBook(
  symbol: SymbolId,
  reference: Price,
  volume: Quantity,
  instrument: Instrument,
  halfSpread: Decimal,
  depth: DepthModel,
  at: UtcMillis,
): BookSnapshot {
  checkDepthModel(depth);
  const { ask: bestAsk, bid: bestBid } = touch(reference, instrument, halfSpread);
  const perLevel = levelQuantity(volume, instrument, depth);
  const asks: BookLevel[] = [];
  const bids: BookLevel[] = [];
  if (perLevel.isPositive()) {
    let worsening = Decimal.parse('0');
    for (const _level of Array.from({ length: depth.levels })) {
      asks.push(Object.freeze({ price: againstTrader(bestAsk.times(ONE.plus(worsening)), 'buy', instrument.priceStep), quantity: perLevel }));
      const bid = againstTrader(bestBid.times(ONE.minus(worsening)), 'sell', instrument.priceStep);
      if (bid.isPositive()) bids.push(Object.freeze({ price: bid, quantity: perLevel }));
      worsening = worsening.plus(depth.impactPerLevel);
    }
  }
  return Object.freeze({ symbol, bids: Object.freeze(bids), asks: Object.freeze(asks), eventTime: at, receivedTime: at });
}

/**
 * Cotización del modelo para el sistema, a partir del cierre de una vela (el último precio negociado): el mismo medio
 * spread y la misma profundidad por nivel que el libro sintético. Su eventTime es el cierre de la vela; el último trade
 * pudo ser anterior, y eso no se sabe con velas (se declara en el informe).
 */
export function quoteFromCandle(
  candle: { readonly symbol: SymbolId; readonly close: Price; readonly volume: Quantity; readonly closeTime: UtcMillis },
  instrument: Instrument,
  halfSpread: Decimal,
  depth: DepthModel,
  receivedTime: UtcMillis,
): QuoteSnapshot {
  checkDepthModel(depth);
  const { ask, bid } = touch(candle.close, instrument, halfSpread);
  const size = levelQuantity(candle.volume, instrument, depth);
  return Object.freeze({ symbol: candle.symbol, bid, ask, bidSize: size, askSize: size, eventTime: candle.closeTime, receivedTime });
}

export interface BookFill {
  readonly price: Price;
  readonly quantity: Quantity;
}

/**
 * Recorre los niveles del lado contrario (asks para comprar, bids para vender) hasta `quantity`. Cada fill es un múltiplo
 * del paso de cantidad y paga el slippage mínimo encima del precio del nivel. Lo que no cabe en el libro no se ejecuta.
 */
export function walkBook(book: BookSnapshot, side: Side, quantity: Quantity, instrument: Instrument, minSlippage: Decimal): BookFill[] {
  const levels = side === 'buy' ? book.asks : book.bids;
  const slip = side === 'buy' ? ONE.plus(minSlippage) : ONE.minus(minSlippage);
  const fills: BookFill[] = [];
  let remaining = quantity;
  for (const level of levels) {
    if (!remaining.isPositive()) break;
    const take = Decimal.min(remaining, level.quantity).roundToStep(instrument.quantityStep, 'DOWN');
    if (!take.isPositive()) continue;
    const price = againstTrader(level.price.times(slip), side, instrument.priceStep);
    if (!price.isPositive()) continue;
    fills.push(Object.freeze({ price, quantity: take }));
    remaining = remaining.minus(take);
  }
  return fills;
}
