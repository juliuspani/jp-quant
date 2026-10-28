import type { Store } from './store.ts';
import type { Bucket, Fill, Position, Quote } from './types.ts';

export interface Valuation {
  ts: number;
  equity: number;
  cash: number;
  exposure: number;
  exposureByBucket: Record<Bucket, number>;
  /** Precio (bid) usado para valorar cada símbolo abierto. */
  prices: Record<string, number>;
}

/** Por debajo de este valor en quote, el resto de una posición se considera polvo y se da por cerrada. */
const DUST_QUOTE = 1;

/**
 * Contabilidad propia del bot. La caja es un libro interno que parte del
 * capital asignado y solo cambia con las operaciones del bot, de modo que en
 * real nunca cuenta como suyo el resto del saldo que haya en la cuenta.
 */
export class Portfolio {
  private store: Store;
  private mode: string;
  private lastPrices = new Map<string, number>();

  constructor(store: Store, mode: string, startingQuote: number) {
    this.store = store;
    this.mode = mode;
    if (store.get<number | null>('ledger.cash', null) === null) {
      store.set('ledger.cash', startingQuote);
      store.set('ledger.initial', startingQuote);
    }
  }

  cash(): number {
    return this.store.get('ledger.cash', 0);
  }

  initialCapital(): number {
    return this.store.get('ledger.initial', 0);
  }

  applyBuy(fill: Fill, bucket: Bucket, stopPrice: number, reason: string, meta: Record<string, unknown> = {}): Position {
    return this.store.tx(() => {
      this.store.set('ledger.cash', this.cash() - fill.quote);
      const pos = this.store.openPosition({
        symbol: fill.symbol,
        bucket,
        amount: fill.amount,
        costBasis: fill.quote,
        entryPrice: fill.price,
        entryTs: fill.ts,
        stopPrice,
        meta,
      });
      this.store.recordFill(fill, this.mode, pos.id, reason);
      return pos;
    });
  }

  /** Aplica una venta total o parcial. Devuelve el resultado realizado por esta venta. */
  applySell(pos: Position, fill: Fill, reason: string): { position: Position; pnl: number; closed: boolean } {
    return this.store.tx(() => {
      const remaining = pos.amount - fill.amount;
      const closed = remaining * fill.price < DUST_QUOTE;
      // Al cerrar se imputa todo el coste restante: el polvo que quede cuenta como pérdida.
      const costPart = closed ? pos.costBasis : pos.costBasis * (fill.amount / pos.amount);
      const pnl = fill.quote - costPart;
      const next: Position = {
        ...pos,
        amount: closed ? 0 : remaining,
        costBasis: pos.costBasis - costPart,
        realizedPnl: pos.realizedPnl + pnl,
        status: closed ? 'closed' : 'open',
        exitTs: closed ? fill.ts : null,
        exitReason: closed ? reason : null,
      };
      this.store.set('ledger.cash', this.cash() + fill.quote);
      this.store.savePosition(next);
      this.store.recordFill(fill, this.mode, pos.id, reason);
      return { position: next, pnl, closed };
    });
  }

  /** Valora la cartera al bid. Si falta un precio se usa el último conocido. */
  valuation(quotes: Map<string, Quote>, now: number): Valuation {
    const cash = this.cash();
    const exposureByBucket: Record<Bucket, number> = { core: 0, scout: 0 };
    const prices: Record<string, number> = {};
    for (const p of this.store.openPositions()) {
      const bid = quotes.get(p.symbol)?.bid;
      if (bid) this.lastPrices.set(p.symbol, bid);
      const price = this.lastPrices.get(p.symbol) ?? p.entryPrice;
      prices[p.symbol] = price;
      exposureByBucket[p.bucket] += p.amount * price;
    }
    const exposure = exposureByBucket.core + exposureByBucket.scout;
    return { ts: now, equity: cash + exposure, cash, exposure, exposureByBucket, prices };
  }
}
