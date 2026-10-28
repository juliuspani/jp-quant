// Contratos de datos de mercado (ARCHITECTURE.md §16.3). Precios y volumen en Decimal, nunca float (ADR 0014).
import type { Notional, Price, Quantity } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { Timeframe, UtcMillis } from '../shared/time.ts';

export interface Candle {
  readonly symbol: SymbolId;
  readonly timeframe: Timeframe;
  readonly openTime: UtcMillis;
  readonly closeTime: UtcMillis; // event_time de la vela
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
  readonly volume: Quantity;
}

export interface QuoteSnapshot {
  readonly symbol: SymbolId;
  readonly bid: Price;
  readonly ask: Price;
  readonly bidSize: Quantity;
  readonly askSize: Quantity;
  readonly eventTime: UtcMillis;
  readonly receivedTime: UtcMillis;
}
export interface BookLevel {
  readonly price: Price;
  readonly quantity: Quantity;
}
export interface BookSnapshot {
  readonly symbol: SymbolId;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly eventTime: UtcMillis;
  readonly receivedTime: UtcMillis;
}
export interface Instrument {
  readonly symbol: SymbolId;
  readonly base: string;
  readonly quote: string;
  readonly tradable: boolean; // spot, activo y sin anuncio de deslistado ni suspensión
  readonly priceStep: Price;
  readonly quantityStep: Quantity;
  readonly minQuantity: Quantity; // un límite que falta es un error (docs/CCXT.md §2)
  readonly minNotional: Notional;
  readonly asOf: UtcMillis;
}

// Del adaptador al normalizador (ARCHITECTURE.md §4.3 y §16.3): valores ya en Decimal, todavía sin validar.
export type RawMarketData =
  | { readonly kind: 'candle'; readonly candle: Candle; readonly closed: boolean }
  | { readonly kind: 'quote'; readonly quote: QuoteSnapshot }
  | { readonly kind: 'book'; readonly book: BookSnapshot; readonly sequence: string | null; readonly isSnapshot: boolean }
  | { readonly kind: 'volume24h'; readonly symbol: SymbolId; readonly quoteVolume: Notional; readonly eventTime: UtcMillis }
  | { readonly kind: 'instruments'; readonly instruments: readonly Instrument[] };

// Vista de solo lectura del dueño (marketdata). La leen risk y execution.
export interface MarketView {
  instrument(symbol: SymbolId): Instrument | null;
  quote(symbol: SymbolId): QuoteSnapshot | null;
  book(symbol: SymbolId): BookSnapshot | null; // null mientras el libro no esté sincronizado
  volume24h(symbol: SymbolId): { readonly quoteVolume: Notional; readonly eventTime: UtcMillis } | null;
}
