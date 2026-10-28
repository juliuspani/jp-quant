// Verificación de exchange-execution §17 y docs/CCXT.md §2 (paso 18): qué estructuras de ccxt respetan el modo
// cadena (`exchange.number = String`) con Bitvavo, el exchange principal (ADR 0018). Sin red: se llama a los
// parsers con respuestas de ejemplo con la forma de la API. Si una actualización de ccxt cambia esto, falla aquí.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ccxt from 'ccxt';

interface Parsers {
  number: (text: string) => unknown;
  parseOHLCV(raw: unknown[]): unknown[];
  parseTrade(raw: Record<string, unknown>): Record<string, unknown>;
  parseOrder(raw: Record<string, unknown>): Record<string, unknown>;
  parseTicker(raw: Record<string, unknown>): Record<string, unknown>;
  parseBalance(raw: unknown[]): Record<string, Record<string, unknown>>;
  parseMarkets(raw: unknown[]): { precision: Record<string, unknown>; limits: { amount: Record<string, unknown> } }[];
}

interface WsBook {
  asks: unknown[][];
}
interface WsParsers extends Parsers {
  orderBook(snapshot: Record<string, unknown>): WsBook;
  handleDelta(side: unknown, delta: string[]): void;
}

function stringMode<T extends Parsers>(exchange: object): T {
  const parsers = exchange as T;
  parsers.number = String;
  return parsers;
}

test('REST de Bitvavo en modo cadena: velas, trades, órdenes, ticker, saldos y mercados devuelven cadenas', () => {
  const ex = stringMode<Parsers>(new ccxt.bitvavo());
  const [time, ...ohlcv] = ex.parseOHLCV([1590383700000, '8088.5', '8090', '8080.25', '8088.5', '0.04788623']);
  assert.equal(typeof time, 'number'); // el timestamp sigue siendo entero en milisegundos
  assert.deepEqual(ohlcv, ['8088.5', '8090', '8080.25', '8088.5', '0.04788623']);

  const trade = ex.parseTrade({ id: 't1', timestamp: 1590383700000, amount: '0.1', price: '8088.5', side: 'buy', market: 'BTC-EUR' });
  assert.equal(trade.price, '8088.5');
  assert.equal(trade.amount, '0.1');

  const order = ex.parseOrder({
    orderId: 'o1', market: 'BTC-EUR', created: 1590383700000, status: 'new', side: 'buy', orderType: 'limit',
    amount: '0.1', amountRemaining: '0.1', price: '8000.1', filledAmount: '0', filledAmountQuote: '0', feePaid: '0',
  });
  assert.equal(order.price, '8000.1');
  assert.equal(order.amount, '0.1');

  const ticker = ex.parseTicker({ market: 'BTC-EUR', timestamp: 1590383700000, last: '8088.5', bid: '8088.1', ask: '8088.9', volume: '12.5' });
  assert.equal(ticker.last, '8088.5');
  assert.equal(ticker.bid, '8088.1');

  const balance = ex.parseBalance([{ symbol: 'EUR', available: '100.25', inOrder: '0.5' }]);
  assert.equal(balance.EUR?.free, '100.25');
  assert.equal(balance.EUR?.total, '100.75');

  const [market] = ex.parseMarkets([
    { market: 'BTC-EUR', status: 'trading', base: 'BTC', quote: 'EUR', pricePrecision: 5, minOrderInBaseAsset: '0.0001', minOrderInQuoteAsset: '5', quantityDecimals: 8, notionalDecimals: 2 },
  ]);
  assert.equal(typeof market?.limits.amount.min, 'string');
});

test('WebSocket de Bitvavo: el libro de órdenes ignora el modo cadena y guarda float', () => {
  // handleDelta usa safeFloat y OrderBookSide indexa en un Float64Array. El libro por WebSocket no puede leerse
  // de las estructuras de ccxt: hay que convertir las cadenas del mensaje original (paso 32, exchange/).
  const ex = stringMode<WsParsers>(new ccxt.pro.bitvavo());
  const book = ex.orderBook({});
  ex.handleDelta(book.asks, ['8088.5', '0.1']);
  assert.deepEqual(book.asks[0], [8088.5, 0.1]);
});
