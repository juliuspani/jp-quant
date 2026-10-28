// Normalizador de datos de mercado (ARCHITECTURE.md §4.3, paso 23): la única puerta de entrada de datos de mercado y el
// dueño de la vista de mercado. El mismo código en el replay y en tiempo real.
// - Velas: solo las cerradas, y solo cuando se reciben después de cerrar (antes sería look-ahead). Las repetidas y las
//   desordenadas se ignoran y se anotan. Un hueco publica MarketDataGap antes de la vela; nunca se rellena.
// - Valores: un precio no positivo, un volumen negativo, un high por debajo del low o una cotización cruzada se
//   descartan y se anotan. Lo descartado no cambia la vista.
// - Libro: solo instantáneas; las diferencias con números de secuencia llegan con exchange/ (paso 32).
import type { BookSnapshot, Candle, Instrument, MarketView, QuoteSnapshot, RawMarketData } from '../kernel/market-data.ts';
import type { Notional } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import { closeTimeOf, isAligned, toUtcIso, type Timeframe, type UtcMillis } from '../shared/time.ts';

export type MarketDataEvent =
  | { readonly type: 'CandleClosed'; readonly candle: Candle; readonly receivedTime: UtcMillis }
  | { readonly type: 'MarketDataGap'; readonly symbol: SymbolId; readonly timeframe: Timeframe; readonly from: UtcMillis; readonly to: UtcMillis }
  | { readonly type: 'MarketDataDiscarded'; readonly kind: RawMarketData['kind']; readonly symbol: SymbolId | null; readonly reason: string };

function discarded(kind: RawMarketData['kind'], symbol: SymbolId | null, reason: string): MarketDataEvent {
  return Object.freeze({ type: 'MarketDataDiscarded', kind, symbol, reason });
}

function candleProblem(candle: Candle, receivedTime: UtcMillis): string | null {
  const prices = [candle.open, candle.high, candle.low, candle.close];
  if (!prices.every((p) => p.isPositive())) return 'precio no positivo';
  if (candle.volume.isNegative()) return 'volumen negativo';
  if (candle.high.lt(candle.low) || candle.high.lt(candle.open) || candle.high.lt(candle.close)) return 'high por debajo de otro precio';
  if (candle.low.gt(candle.open) || candle.low.gt(candle.close)) return 'low por encima de otro precio';
  if (!isAligned(candle.openTime, candle.timeframe) || candle.closeTime !== closeTimeOf(candle.openTime, candle.timeframe)) {
    return 'apertura o cierre fuera de la rejilla del timeframe';
  }
  if (receivedTime < candle.closeTime) return 'recibida antes de cerrar: sería look-ahead';
  return null;
}

function quoteProblem(quote: QuoteSnapshot): string | null {
  if (!quote.bid.isPositive() || !quote.ask.isPositive()) return 'bid o ask no positivos';
  if (quote.bid.gt(quote.ask)) return 'cotización cruzada';
  if (quote.bidSize.isNegative() || quote.askSize.isNegative()) return 'tamaño negativo';
  if (quote.receivedTime < quote.eventTime) return 'recibida antes de ocurrir';
  return null;
}

export class MarketDataNormalizer implements MarketView {
  readonly #lastOpen = new Map<string, UtcMillis>(); // por símbolo y timeframe
  readonly #instruments = new Map<SymbolId, Instrument>();
  readonly #quotes = new Map<SymbolId, QuoteSnapshot>();
  readonly #books = new Map<SymbolId, BookSnapshot>();
  readonly #volumes = new Map<SymbolId, { readonly quoteVolume: Notional; readonly eventTime: UtcMillis }>();

  /** Valida un dato crudo, actualiza la vista y devuelve los eventos que publica. */
  ingest(raw: RawMarketData, receivedTime: UtcMillis): readonly MarketDataEvent[] {
    toUtcIso(receivedTime);
    switch (raw.kind) {
      case 'candle':
        return this.#candle(raw.candle, raw.closed, receivedTime);
      case 'quote': {
        const problem = quoteProblem(raw.quote);
        if (problem !== null) return [discarded('quote', raw.quote.symbol, problem)];
        const previous = this.#quotes.get(raw.quote.symbol);
        if (previous !== undefined && raw.quote.eventTime < previous.eventTime) return [discarded('quote', raw.quote.symbol, 'más antigua que la vigente')];
        this.#quotes.set(raw.quote.symbol, Object.freeze({ ...raw.quote }));
        return [];
      }
      case 'book':
        if (!raw.isSnapshot) return [discarded('book', raw.book.symbol, 'diferencias de libro: llegan con exchange/ (paso 32)')];
        this.#books.set(raw.book.symbol, Object.freeze({ ...raw.book }));
        return [];
      case 'volume24h':
        if (raw.quoteVolume.isNegative()) return [discarded('volume24h', raw.symbol, 'volumen negativo')];
        this.#volumes.set(raw.symbol, Object.freeze({ quoteVolume: raw.quoteVolume, eventTime: raw.eventTime }));
        return [];
      case 'instruments': {
        const events: MarketDataEvent[] = [];
        for (const instrument of raw.instruments) {
          const steps = [instrument.priceStep, instrument.quantityStep];
          if (!steps.every((s) => s.isPositive()) || instrument.minQuantity.isNegative() || instrument.minNotional.isNegative()) {
            events.push(discarded('instruments', instrument.symbol, 'paso no positivo o mínimo negativo'));
            continue;
          }
          this.#instruments.set(instrument.symbol, Object.freeze({ ...instrument }));
        }
        return events;
      }
    }
    return [discarded((raw as { kind: RawMarketData['kind'] }).kind, null, 'tipo de dato desconocido')];
  }

  instrument(symbol: SymbolId): Instrument | null {
    return this.#instruments.get(symbol) ?? null;
  }

  quote(symbol: SymbolId): QuoteSnapshot | null {
    return this.#quotes.get(symbol) ?? null;
  }

  book(symbol: SymbolId): BookSnapshot | null {
    return this.#books.get(symbol) ?? null;
  }

  volume24h(symbol: SymbolId): { readonly quoteVolume: Notional; readonly eventTime: UtcMillis } | null {
    return this.#volumes.get(symbol) ?? null;
  }

  #candle(candle: Candle, closed: boolean, receivedTime: UtcMillis): readonly MarketDataEvent[] {
    if (!closed) return [discarded('candle', candle.symbol, 'vela en curso')];
    const problem = candleProblem(candle, receivedTime);
    if (problem !== null) return [discarded('candle', candle.symbol, `${toUtcIso(candle.openTime)}: ${problem}`)];
    const key = `${candle.symbol}\u0000${candle.timeframe}`;
    const last = this.#lastOpen.get(key);
    if (last !== undefined && candle.openTime === last) return [discarded('candle', candle.symbol, `${toUtcIso(candle.openTime)}: repetida`)];
    if (last !== undefined && candle.openTime < last) return [discarded('candle', candle.symbol, `${toUtcIso(candle.openTime)}: desordenada`)];
    this.#lastOpen.set(key, candle.openTime);
    const accepted: MarketDataEvent = Object.freeze({ type: 'CandleClosed', candle: Object.freeze({ ...candle }), receivedTime });
    const expected = last === undefined ? candle.openTime : closeTimeOf(last, candle.timeframe);
    if (candle.openTime === expected) return [accepted];
    // Hueco: faltan velas entre el cierre de la última y la apertura de esta. Se avisa y no se rellena.
    const gap: MarketDataEvent = Object.freeze({ type: 'MarketDataGap', symbol: candle.symbol, timeframe: candle.timeframe, from: expected, to: candle.openTime });
    return [gap, accepted];
  }
}
