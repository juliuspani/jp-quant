// Cartera en Decimal a partir de los fills (ARCHITECTURE.md §4.1 y §16.6, paso 23): caja, posiciones, coste, PnL
// realizado y patrimonio. Es la vista que leen Risk, Execution y Strategy, y la misma en todos los modos. Solo cambia con
// FillRecorded (applyFill); la valoración se hace al pedir la foto, al bid de la vista de mercado, que es lo que se
// cobraría al vender antes de costes. Nunca corrige saldos para que cuadren: un fill imposible lanza.
import type { Clock } from '../kernel/clock.ts';
import type { Fill } from '../kernel/execution.ts';
import type { MarketView } from '../kernel/market-data.ts';
import type { PortfolioSnapshot, PortfolioView, PositionSnapshot } from '../kernel/portfolio.ts';
import { Decimal, type Notional, type Quantity } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { UtcMillis } from '../shared/time.ts';
import type { Bucket } from '../shared/trading.ts';

export class PortfolioError extends Error {
  override readonly name = 'PortfolioError';
}

interface Holding {
  readonly bucket: Bucket;
  readonly quantity: Quantity;
  readonly costBasis: Notional; // lo pagado por la cantidad que queda, con comisiones
  readonly realizedPnl: Notional;
  readonly openedAt: UtcMillis;
}

export interface PortfolioLedgerDeps {
  readonly clock: Clock;
  readonly market: MarketView;
  readonly quoteCurrency: string;
  readonly startingCash: Notional;
}

const ZERO = Decimal.parse('0');
const SCALE = 18;

function baseOf(symbol: SymbolId): string {
  const [base, quote, extra] = symbol.split('/');
  if (base === undefined || quote === undefined || base === '' || extra !== undefined) throw new PortfolioError(`símbolo sin la forma BASE/COTIZACIÓN: ${symbol}`);
  return base;
}

export class PortfolioLedger implements PortfolioView {
  readonly #deps: PortfolioLedgerDeps;
  readonly #holdings = new Map<SymbolId, Holding>();
  readonly #tradeIds = new Set<string>();
  #cash: Notional;
  #realizedClosed: Notional = ZERO; // PnL de posiciones ya cerradas

  constructor(deps: PortfolioLedgerDeps) {
    if (deps.quoteCurrency === '' || deps.startingCash.isNegative()) throw new PortfolioError('moneda de cotización vacía o caja negativa');
    this.#deps = deps;
    this.#cash = deps.startingCash;
  }

  /** Aplica un fill nuevo (FillRecorded). Un fill repetido, imposible o con la comisión en otra moneda lanza. */
  applyFill(fill: Fill, bucket: Bucket): void {
    const key = `${fill.symbol}\u0000${fill.tradeId}`;
    if (this.#tradeIds.has(key)) throw new PortfolioError(`fill repetido: ${fill.tradeId}`);
    if (!fill.quantity.isPositive() || !fill.price.isPositive() || fill.fee.isNegative()) throw new PortfolioError(`fill imposible: ${fill.tradeId}`);
    // La comisión cobrada en el activo base o en otra moneda (exchange-execution §6) llega con exchange/ (paso 32).
    if (fill.feeCurrency !== this.#deps.quoteCurrency) throw new PortfolioError(`comisión en ${fill.feeCurrency}: solo se admite ${this.#deps.quoteCurrency}`);
    const notional = fill.quantity.times(fill.price);
    const held = this.#holdings.get(fill.symbol);
    if (fill.side === 'buy') {
      this.#cash = this.#cash.minus(notional).minus(fill.fee);
      this.#holdings.set(fill.symbol, Object.freeze({
        bucket: held?.bucket ?? bucket,
        quantity: (held?.quantity ?? ZERO).plus(fill.quantity),
        costBasis: (held?.costBasis ?? ZERO).plus(notional).plus(fill.fee),
        realizedPnl: held?.realizedPnl ?? ZERO,
        openedAt: held?.openedAt ?? fill.exchangeTime,
      }));
    } else {
      if (held === undefined || fill.quantity.gt(held.quantity)) {
        throw new PortfolioError(`venta de ${fill.quantity.toString()} ${baseOf(fill.symbol)} sin esa posición (${held?.quantity.toString() ?? '0'})`);
      }
      const proceeds = notional.minus(fill.fee);
      const remaining = held.quantity.minus(fill.quantity);
      // El coste de lo vendido, a coste medio; al cerrar del todo, todo el coste que quedaba.
      const soldCost = remaining.isZero() ? held.costBasis : held.costBasis.times(fill.quantity).div(held.quantity, SCALE, 'HALF_EVEN');
      const realized = held.realizedPnl.plus(proceeds.minus(soldCost));
      this.#cash = this.#cash.plus(proceeds);
      if (remaining.isZero()) {
        this.#holdings.delete(fill.symbol);
        this.#realizedClosed = this.#realizedClosed.plus(realized);
      } else {
        this.#holdings.set(fill.symbol, Object.freeze({ ...held, quantity: remaining, costBasis: held.costBasis.minus(soldCost), realizedPnl: realized }));
      }
    }
    this.#tradeIds.add(key);
  }

  /** PnL realizado de toda la cartera, abiertas y cerradas. */
  realizedPnl(): Notional {
    return [...this.#holdings.values()].reduce((total, h) => total.plus(h.realizedPnl), this.#realizedClosed);
  }

  snapshot(): PortfolioSnapshot {
    let exposure = ZERO;
    let exposureWithoutDust = ZERO;
    let marksAsOf: UtcMillis | null = null;
    let unmarked = false;
    const positions: PositionSnapshot[] = [];
    for (const [symbol, held] of [...this.#holdings.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const quote = this.#deps.market.quote(symbol);
      const instrument = this.#deps.market.instrument(symbol);
      // Sin precio, la posición vale lo que costó y la valoración queda sin fecha: Risk no abre nada (STALE_DATA).
      const value = quote === null ? held.costBasis : held.quantity.times(quote.bid);
      if (quote === null) unmarked = true;
      else {
        const markTime = quote.eventTime < quote.receivedTime ? quote.eventTime : quote.receivedTime;
        if (marksAsOf === null || markTime < marksAsOf) marksAsOf = markTime;
      }
      exposure = exposure.plus(value);
      // Polvo: lo que no llega al mínimo del mercado no se puede vender (exchange-execution §6).
      const dust = instrument !== null && (held.quantity.lt(instrument.minQuantity) || value.lt(instrument.minNotional)) ? held.quantity : ZERO;
      if (dust.isZero()) exposureWithoutDust = exposureWithoutDust.plus(value);
      positions.push(Object.freeze({
        symbol,
        bucket: held.bucket,
        quantity: held.quantity,
        available: held.quantity, // sin órdenes en reposo que bloqueen saldo hasta el paso 36
        costBasis: held.costBasis,
        averageEntry: held.costBasis.div(held.quantity, SCALE, 'HALF_EVEN'),
        realizedPnl: held.realizedPnl,
        dust,
        openedAt: held.openedAt,
      }));
    }
    return Object.freeze({
      asOf: this.#deps.clock.now(),
      quoteCurrency: this.#deps.quoteCurrency,
      cash: this.#cash,
      equity: this.#cash.plus(exposure),
      exposure,
      exposureWithoutDust,
      positions: Object.freeze(positions),
      marksAsOf: unmarked ? null : marksAsOf, // null también sin posiciones: no se valoró nada
    });
  }
}
