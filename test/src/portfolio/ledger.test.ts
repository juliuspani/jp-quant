// Cartera en Decimal desde los fills (paso 23): caja, coste medio con comisiones, PnL realizado, valoración al bid y
// polvo. Cuadra con los saldos del venue simulado, y lo imposible lanza en lugar de corregirse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fill } from '../../../src/kernel/execution.ts';
import { PortfolioError, PortfolioLedger } from '../../../src/portfolio/ledger.ts';
import { SimulatedClock } from '../../../src/backtest/simulated-clock.ts';
import { d, instrument, quote, SYMBOL, T0, TestMarket } from '../harness/trading.ts';
import { marketOrder, venueBench } from '../backtest/venue-bench.ts';

let trade = 0;
function fill(side: 'buy' | 'sell', quantity: string, price: string, fee: string, overrides: Partial<Fill> = {}): Fill {
  trade += 1;
  return { tradeId: `t${String(trade)}`, clientOrderId: 'ijp-x', symbol: SYMBOL, side, quantity: d(quantity), price: d(price), fee: d(fee), feeCurrency: 'EUR', feeEstimated: false, exchangeTime: T0, ...overrides };
}

function ledger(market = new TestMarket(), cash = '10000') {
  return new PortfolioLedger({ clock: new SimulatedClock(T0), market, quoteCurrency: 'EUR', startingCash: d(cash) });
}

const text = (value: { toString(): string } | null | undefined): string | null => (value === null || value === undefined ? null : value.toString());

test('compra y venta: caja, coste con comisiones, coste medio, PnL realizado y patrimonio al bid', () => {
  const market = new TestMarket(); // bid 39.990, ask 40.000
  const book = ledger(market);
  book.applyFill(fill('buy', '0.1', '40000', '10'), 'core');
  book.applyFill(fill('buy', '0.1', '41000', '10'), 'core');
  let snap = book.snapshot();
  const [position] = snap.positions;
  assert.deepEqual([text(snap.cash), text(position?.quantity), text(position?.costBasis), text(position?.averageEntry)], ['1880', '0.2', '8120', '40600']);
  assert.deepEqual([text(snap.exposure), text(snap.equity)], ['7998', '9878'], 'valoración al bid: 0,2 × 39.990');
  assert.equal(text(snap.exposureWithoutDust), '7998', 'sin polvo, la misma');

  book.applyFill(fill('sell', '0.05', '42000', '5'), 'core');
  snap = book.snapshot();
  // Se vende un cuarto: coste 2030, ingreso 2100 − 5 = 2095, PnL 65.
  assert.deepEqual([text(snap.cash), text(snap.positions[0]?.costBasis), text(snap.positions[0]?.realizedPnl)], ['3975', '6090', '65']);
  book.applyFill(fill('sell', '0.15', '39000', '15'), 'core');
  snap = book.snapshot();
  // Cierra: coste 6090, ingreso 5850 − 15 = 5835, PnL −255; total −190.
  assert.deepEqual([snap.positions.length, text(snap.cash), text(book.realizedPnl())], [0, '9810', '-190']);
  assert.equal(snap.marksAsOf, null, 'sin posiciones no se valora nada');
});

test('cuadra con los saldos del venue simulado tras comprar y vender', () => {
  const bench = venueBench({ cash: '1000' });
  const market = new TestMarket();
  market.instruments.set(SYMBOL, instrument({ quantityStep: d('0.00000001'), minQuantity: d('0.00000001') }));
  const book = new PortfolioLedger({ clock: bench.clock, market, quoteCurrency: 'EUR', startingCash: d('1000') });
  for (const order of [marketOrder('buy', '0.02'), marketOrder('sell', '0.005')]) {
    bench.venue.submit(order);
    bench.drain();
  }
  for (const update of bench.updates()) for (const f of update.fills) book.applyFill(f, 'core');
  const balances = bench.venue.balances();
  const snap = book.snapshot();
  assert.equal(text(snap.cash), text(balances.EUR));
  assert.equal(text(snap.positions[0]?.quantity), text(balances.BTC));
  assert.deepEqual([text(balances.EUR), text(balances.BTC)], ['396.228075', '0.015']);
});

test('la valoración toma la marca más antigua de las posiciones y queda sin fecha si falta un precio', () => {
  const market = new TestMarket();
  market.instruments.set('ETH/EUR', instrument({ symbol: 'ETH/EUR', base: 'ETH' }));
  market.quotes.set('ETH/EUR', quote(T0 - 5_000, '2000', { symbol: 'ETH/EUR' }));
  const book = ledger(market);
  book.applyFill(fill('buy', '0.01', '40000', '1'), 'core');
  book.applyFill(fill('buy', '0.5', '2000', '1', { symbol: 'ETH/EUR' }), 'core');
  assert.equal(book.snapshot().marksAsOf, T0 - 5_000);
  market.quotes.delete('ETH/EUR');
  const snap = book.snapshot();
  assert.equal(snap.marksAsOf, null);
  assert.equal(text(snap.positions.find((p) => p.symbol === 'ETH/EUR')?.costBasis), '1001', 'sin precio vale lo que costó');
});

test('polvo: lo que no llega al importe mínimo del mercado se marca como tal y no cuenta en la exposición sin polvo', () => {
  const market = new TestMarket();
  market.instruments.set('ETH/EUR', instrument({ symbol: 'ETH/EUR', base: 'ETH' }));
  market.quotes.set('ETH/EUR', quote(T0, '2000', { symbol: 'ETH/EUR' }));
  const book = ledger(market);
  book.applyFill(fill('buy', '0.0001', '40000', '0.01'), 'core');
  let snap = book.snapshot();
  assert.equal(text(snap.positions[0]?.dust), '0.0001', '0,0001 × 39.990 = 3,999 < 5 EUR');
  assert.deepEqual([text(snap.exposure), text(snap.exposureWithoutDust)], ['3.999', '0'], 'el polvo cuenta en la exposición, no en la que no lo tiene');
  // Con otra posición que sí se puede vender, la exposición sin polvo es solo la de esa.
  book.applyFill(fill('buy', '0.5', '2000', '1', { symbol: 'ETH/EUR' }), 'core');
  snap = book.snapshot();
  assert.equal(text(snap.positions.find((p) => p.symbol === 'ETH/EUR')?.dust), '0');
  assert.ok(snap.exposureWithoutDust.isPositive());
  assert.equal(text(snap.exposureWithoutDust), text(snap.exposure.minus(d('3.999'))));
});

test('fail closed: un fill repetido, una venta sin posición o una comisión en otra moneda lanzan', () => {
  const book = ledger();
  const once = fill('buy', '0.01', '40000', '1');
  book.applyFill(once, 'core');
  assert.throws(() => book.applyFill(once, 'core'), PortfolioError);
  assert.throws(() => book.applyFill(fill('sell', '0.02', '40000', '1'), 'core'), PortfolioError);
  assert.throws(() => book.applyFill(fill('buy', '0.01', '40000', '0.00001', { feeCurrency: 'BTC' }), 'core'), PortfolioError);
  assert.throws(() => book.applyFill(fill('buy', '0', '40000', '0'), 'core'), PortfolioError);
  assert.equal(text(book.snapshot().cash), '9599', 'lo rechazado no cambia la caja');
});
