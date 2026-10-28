// Normalizador de marketdata/ (ARCHITECTURE.md §4.3): única puerta de los datos de mercado. Solo pasan velas cerradas,
// válidas y en orden; los huecos se avisan y no se rellenan; lo descartado se anota y no cambia la vista.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle, QuoteSnapshot } from '../../../src/kernel/market-data.ts';
import { MarketDataNormalizer, type MarketDataEvent } from '../../../src/marketdata/normalizer.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { closeTimeOf } from '../../../src/shared/time.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);
const d = (text: string): Decimal => Decimal.parse(text);

function candle(openTime: number, prices: { o?: string; h?: string; l?: string; c?: string; v?: string } = {}): Candle {
  return {
    symbol: 'BTC/EUR',
    timeframe: '1h',
    openTime,
    closeTime: closeTimeOf(openTime, '1h'),
    open: d(prices.o ?? '100'),
    high: d(prices.h ?? '110'),
    low: d(prices.l ?? '90'),
    close: d(prices.c ?? '105'),
    volume: d(prices.v ?? '1'),
  };
}

function quote(eventTime: number, bid: string, ask: string): QuoteSnapshot {
  return { symbol: 'BTC/EUR', bid: d(bid), ask: d(ask), bidSize: d('1'), askSize: d('1'), eventTime, receivedTime: eventTime };
}

const types = (events: readonly MarketDataEvent[]): string[] => events.map((e) => e.type);
const reasons = (events: readonly MarketDataEvent[]): string[] => events.flatMap((e) => (e.type === 'MarketDataDiscarded' ? [e.reason] : []));

test('solo pasa una vela cerrada y recibida después de cerrar; la vela en curso y la recibida antes se descartan', () => {
  const md = new MarketDataNormalizer();
  assert.deepEqual(reasons(md.ingest({ kind: 'candle', candle: candle(T0), closed: false }, T0 + HOUR)), ['vela en curso']);
  assert.match(reasons(md.ingest({ kind: 'candle', candle: candle(T0), closed: true }, T0 + HOUR - 1))[0] ?? '', /recibida antes de cerrar/);
  const accepted = md.ingest({ kind: 'candle', candle: candle(T0), closed: true }, T0 + HOUR + 60_000);
  assert.deepEqual(types(accepted), ['CandleClosed']);
  const [event] = accepted;
  assert.ok(event?.type === 'CandleClosed');
  assert.equal(event.receivedTime, T0 + HOUR + 60_000);
});

test('valores imposibles se descartan: precio no positivo, volumen negativo, high bajo el low o fuera de la rejilla', () => {
  const md = new MarketDataNormalizer();
  const bad = [
    candle(T0, { o: '0' }),
    candle(T0, { v: '-1' }),
    candle(T0, { h: '80' }),
    candle(T0, { l: '106' }),
    { ...candle(T0), openTime: T0 + 1, closeTime: T0 + HOUR + 1 },
  ];
  for (const c of bad) assert.deepEqual(types(md.ingest({ kind: 'candle', candle: c, closed: true }, T0 + 2 * HOUR)), ['MarketDataDiscarded'], JSON.stringify(c.openTime));
  assert.deepEqual(types(md.ingest({ kind: 'candle', candle: candle(T0), closed: true }, T0 + 2 * HOUR)), ['CandleClosed'], 'lo descartado no cuenta como recibido');
});

test('una vela repetida o desordenada se ignora y se anota; un hueco se avisa antes de la vela y no se rellena', () => {
  const md = new MarketDataNormalizer();
  md.ingest({ kind: 'candle', candle: candle(T0), closed: true }, T0 + HOUR);
  md.ingest({ kind: 'candle', candle: candle(T0 + HOUR), closed: true }, T0 + 2 * HOUR);
  assert.match(reasons(md.ingest({ kind: 'candle', candle: candle(T0 + HOUR), closed: true }, T0 + 3 * HOUR))[0] ?? '', /repetida/);
  assert.match(reasons(md.ingest({ kind: 'candle', candle: candle(T0), closed: true }, T0 + 3 * HOUR))[0] ?? '', /desordenada/);
  const afterGap = md.ingest({ kind: 'candle', candle: candle(T0 + 4 * HOUR), closed: true }, T0 + 5 * HOUR);
  assert.deepEqual(types(afterGap), ['MarketDataGap', 'CandleClosed']);
  const [gap] = afterGap;
  assert.ok(gap?.type === 'MarketDataGap');
  assert.deepEqual([gap.from, gap.to], [T0 + 2 * HOUR, T0 + 4 * HOUR], 'faltan las velas de las 2 y las 3');
});

test('cotizaciones: una cruzada o más antigua que la vigente se descarta y no cambia la vista', () => {
  const md = new MarketDataNormalizer();
  assert.deepEqual(md.ingest({ kind: 'quote', quote: quote(T0, '99', '101') }, T0), []);
  assert.deepEqual(reasons(md.ingest({ kind: 'quote', quote: quote(T0 + 1, '102', '101') }, T0 + 1)), ['cotización cruzada']);
  assert.deepEqual(reasons(md.ingest({ kind: 'quote', quote: quote(T0 - 1, '98', '100') }, T0 + 1)), ['más antigua que la vigente']);
  assert.equal(md.quote('BTC/EUR')?.bid.toString(), '99');
  assert.equal(md.quote('ETH/EUR'), null);
});

test('instrumentos y libro: un paso no positivo se descarta; del libro solo entran instantáneas', () => {
  const md = new MarketDataNormalizer();
  const instrument = { symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', tradable: true, priceStep: d('1'), quantityStep: d('0.00000001'), minQuantity: d('0.00000001'), minNotional: d('5'), asOf: T0 };
  assert.deepEqual(md.ingest({ kind: 'instruments', instruments: [instrument, { ...instrument, symbol: 'ETH/EUR', priceStep: d('0') }] }, T0).map((e) => e.type), ['MarketDataDiscarded']);
  assert.equal(md.instrument('BTC/EUR')?.minNotional.toString(), '5');
  assert.equal(md.instrument('ETH/EUR'), null);
  const book = { symbol: 'BTC/EUR', bids: [], asks: [], eventTime: T0, receivedTime: T0 };
  assert.equal(types(md.ingest({ kind: 'book', book, sequence: '7', isSnapshot: false }, T0)).length, 1);
  assert.equal(md.book('BTC/EUR'), null);
  assert.deepEqual(md.ingest({ kind: 'book', book, sequence: null, isSnapshot: true }, T0), []);
  assert.ok(md.book('BTC/EUR') !== null);
});
