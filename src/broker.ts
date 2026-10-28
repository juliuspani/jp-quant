import ccxt from 'ccxt';
import type { Exchange, Order } from 'ccxt';
import { log } from './log.ts';
import type { MarketData } from './market.ts';
import type { Fill, Side } from './types.ts';
import { errMsg, sleep } from './util.ts';

export interface Broker {
  readonly kind: 'paper' | 'live';
  /** Orden a mercado de `amount` unidades de la moneda base. */
  buy(symbol: string, amount: number, clientOrderId: string): Promise<Fill>;
  sell(symbol: string, amount: number, clientOrderId: string): Promise<Fill>;
}

/**
 * Ejecuta contra precios reales pero sin enviar nada al exchange. Compra en el
 * ask y vende en el bid, con comisión y deslizamiento, para que los resultados
 * simulados no salgan mejores de lo que saldrían con dinero real.
 */
export class PaperBroker implements Broker {
  readonly kind = 'paper';
  private market: MarketData;
  private feeRate: number;
  private slippage: number;

  constructor(market: MarketData, feeRate: number, slippageBps: number) {
    this.market = market;
    this.feeRate = feeRate;
    this.slippage = slippageBps / 10_000;
  }

  async buy(symbol: string, amount: number, clientOrderId: string): Promise<Fill> {
    return this.fill(symbol, 'buy', amount, clientOrderId);
  }

  async sell(symbol: string, amount: number, clientOrderId: string): Promise<Fill> {
    return this.fill(symbol, 'sell', amount, clientOrderId);
  }

  private async fill(symbol: string, side: Side, amount: number, clientOrderId: string): Promise<Fill> {
    const q = (await this.market.quotes([symbol])).get(symbol);
    if (!q) throw new Error(`Sin precio para ${symbol}`);
    const price = side === 'buy' ? q.ask * (1 + this.slippage) : q.bid * (1 - this.slippage);
    const gross = amount * price;
    const fee = gross * this.feeRate;
    return {
      clientOrderId,
      orderId: `paper-${clientOrderId}`,
      symbol,
      side,
      amount,
      price,
      quote: side === 'buy' ? gross + fee : gross - fee,
      fee,
      ts: Date.now(),
    };
  }
}

/**
 * Órdenes reales a mercado mediante ccxt. NO se ha probado contra un exchange
 * con claves reales: antes de usar dinero hay que validarlo en el testnet.
 */
export class LiveBroker implements Broker {
  readonly kind = 'live';
  private ex: Exchange;
  private quote: string;
  private takerFee: number;

  constructor(ex: Exchange, quote: string, takerFee: number) {
    this.ex = ex;
    this.quote = quote;
    this.takerFee = takerFee;
  }

  async buy(symbol: string, amount: number, clientOrderId: string): Promise<Fill> {
    return this.execute(symbol, 'buy', amount, clientOrderId);
  }

  async sell(symbol: string, amount: number, clientOrderId: string): Promise<Fill> {
    return this.execute(symbol, 'sell', amount, clientOrderId);
  }

  private async execute(symbol: string, side: Side, amount: number, clientOrderId: string): Promise<Fill> {
    let order: Order;
    try {
      order = await this.ex.createOrder(symbol, 'market', side, amount, undefined, { clientOrderId });
    } catch (e) {
      // Si se pierde la respuesta no se sabe si la orden entró. Reenviarla a
      // ciegas podría duplicarla, así que primero se busca por su identificador.
      if (!(e instanceof ccxt.NetworkError)) throw e;
      log('warn', 'broker', `Respuesta perdida al enviar ${side} ${symbol}; buscando la orden ${clientOrderId}: ${errMsg(e)}`);
      const found = await this.findByClientId(symbol, clientOrderId);
      if (!found) throw new Error(`Orden ${clientOrderId} no confirmada por el exchange: ${errMsg(e)}`);
      order = found;
    }
    order = await this.waitFilled(symbol, order);
    return this.toFill(order, symbol, side, clientOrderId);
  }

  private async findByClientId(symbol: string, clientOrderId: string): Promise<Order | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(1500 * (attempt + 1));
      try {
        const since = Date.now() - 10 * 60_000;
        const orders = [...(await this.ex.fetchOpenOrders(symbol, since)), ...(await this.ex.fetchClosedOrders(symbol, since))];
        const hit = orders.find((o) => o.clientOrderId === clientOrderId);
        if (hit) return hit;
      } catch (e) {
        log('warn', 'broker', `No se pudo consultar órdenes de ${symbol}: ${errMsg(e)}`);
      }
    }
    return null;
  }

  private async waitFilled(symbol: string, order: Order): Promise<Order> {
    let current = order;
    for (let attempt = 0; attempt < 10 && current.status !== 'closed'; attempt++) {
      if (current.status === 'canceled' || current.status === 'rejected' || current.status === 'expired') break;
      await sleep(1000);
      current = await this.ex.fetchOrder(String(current.id), symbol);
    }
    if (!(Number(current.filled) > 0)) throw new Error(`La orden ${current.id} no se ejecutó (estado: ${current.status})`);
    return current;
  }

  private toFill(order: Order, symbol: string, side: Side, clientOrderId: string): Fill {
    const filled = Number(order.filled);
    const price = Number(order.average ?? order.price);
    const cost = Number(order.cost) > 0 ? Number(order.cost) : filled * price;
    const base = symbol.split('/')[0]!;
    // ccxt rellena `fees` en tiempo de ejecución aunque su tipo `Order` solo declare `fee`.
    const list = (order as Order & { fees?: Order['fee'][] }).fees;
    const fees = list?.length ? list : order.fee ? [order.fee] : [];

    let feeBase = 0;
    let feeQuote = 0;
    let feeOther = false;
    for (const f of fees) {
      const c = Number(f?.cost ?? 0);
      if (!f || !(c > 0)) continue;
      if (f.currency === base) feeBase += c;
      else if (f.currency === this.quote) feeQuote += c;
      else feeOther = true;
    }
    // Comisión cobrada en otra moneda (p. ej. BNB): se estima con la tarifa taker.
    const feeOtherQuote = feeOther ? cost * this.takerFee : 0;
    const fee = feeQuote + feeBase * price + feeOtherQuote;

    return {
      clientOrderId,
      orderId: String(order.id),
      symbol,
      side,
      amount: side === 'buy' ? filled - feeBase : filled,
      price,
      quote: side === 'buy' ? cost + feeQuote + feeOtherQuote : cost - fee,
      fee,
      ts: Number(order.timestamp ?? Date.now()),
    };
  }
}
