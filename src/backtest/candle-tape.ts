// Mercado que ve el venue simulado (ADR 0026): el exchange conoce sus operaciones al instante, sin la latencia con que el
// sistema recibe las velas. A una orden que llega en `at` le corresponde la vela que contiene `at`, la siguiente a la de
// la decisión; su apertura es el precio de referencia (quant-research §3). Si en ese intervalo no hubo operaciones (Kraken
// omite esas velas), no hay vela: no hay liquidez. Solo velas: el histórico no tiene libro de órdenes.
import type { BookSnapshot, Candle } from '../kernel/market-data.ts';
import type { SymbolId } from '../shared/symbol.ts';
import { floorToTimeframe, toUtcIso, type Timeframe, type UtcMillis } from '../shared/time.ts';

export interface Listing {
  readonly listedAt: UtcMillis;
  readonly delistedAt: UtcMillis | null; // excluido
}

/** Lo que el venue simulado sabe del mercado en cada instante. */
export interface VenueMarket {
  /** Marco de las velas: el venue revisa al cierre de cada una las órdenes que esperan. */
  readonly timeframe: Timeframe;
  /** null: símbolo desconocido; false: no se negocia en `at` (aún no listado o ya dado de baja). */
  listed(symbol: SymbolId, at: UtcMillis): boolean | null;
  /** La vela que contiene `at`, o null si en ese intervalo no hubo operaciones. */
  executionBar(symbol: SymbolId, at: UtcMillis): Candle | null;
  /** Libro de órdenes real en `at`, si lo hay. */
  book(symbol: SymbolId, at: UtcMillis): BookSnapshot | null;
}

export class CandleTape implements VenueMarket {
  readonly #timeframe: Timeframe;
  readonly #bars = new Map<SymbolId, Map<UtcMillis, Candle>>();
  readonly #listings: ReadonlyMap<SymbolId, Listing>;

  constructor(candles: readonly Candle[], listings: ReadonlyMap<SymbolId, Listing>) {
    const first = candles[0];
    if (first === undefined) throw new RangeError('cinta de velas vacía');
    this.#timeframe = first.timeframe;
    for (const candle of candles) {
      const where = `${candle.symbol} ${toUtcIso(candle.openTime)}`;
      if (candle.timeframe !== this.#timeframe) throw new RangeError(`${where}: timeframe ${candle.timeframe}, la cinta es de ${this.#timeframe}`);
      if (!listings.has(candle.symbol)) throw new RangeError(`${where}: símbolo sin fechas de alta y baja`);
      const bySymbol = this.#bars.get(candle.symbol) ?? new Map<UtcMillis, Candle>();
      if (bySymbol.has(candle.openTime)) throw new RangeError(`${where}: vela repetida`);
      bySymbol.set(candle.openTime, candle);
      this.#bars.set(candle.symbol, bySymbol);
    }
    this.#listings = listings;
  }

  get timeframe(): Timeframe {
    return this.#timeframe;
  }

  listed(symbol: SymbolId, at: UtcMillis): boolean | null {
    const listing = this.#listings.get(symbol);
    if (listing === undefined) return null;
    return listing.listedAt <= at && (listing.delistedAt === null || at < listing.delistedAt);
  }

  executionBar(symbol: SymbolId, at: UtcMillis): Candle | null {
    return this.#bars.get(symbol)?.get(floorToTimeframe(at, this.#timeframe)) ?? null;
  }

  book(): null {
    return null;
  }
}
