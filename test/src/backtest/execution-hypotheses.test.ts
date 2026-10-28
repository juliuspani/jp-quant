// Una prueba por cada hipótesis del modelo de ejecución del backtest (prompt del paso 23, ADR 0026): bid/ask, comisiones,
// spread, slippage, profundidad, latencia, ejecuciones parciales, rechazos, paso de precio, precisión de cantidad,
// importe mínimo, cancelación, datos obsoletos, liquidez del libro, caducidad y declaración del modelo sin libro.
// Valores por defecto: comisión 0,25 %, medio spread 0,075 %, slippage mínimo 0,05 %; libro sintético con el 2 % del
// volumen de la vela en 5 niveles y un 0,05 % de impacto por nivel; 5 cifras significativas de precio (paso de 1 EUR a
// 40.000), 8 decimales de cantidad e importe mínimo de 5 EUR; latencia de 1 s de ida y 1 s de vuelta.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DEPTH_MODEL } from '../../../src/backtest/book-model.ts';
import { CostModelError, executionCosts } from '../../../src/backtest/costs.ts';
import { DEFAULT_INSTRUMENT_RULES, priceStepFor } from '../../../src/backtest/instrument-model.ts';
import { bar, book, COSTS, d, DECIDED, HOUR, marketOrder, SYMBOL, T0, venueBench } from './venue-bench.ts';

const ARRIVAL = DECIDED + 1000;
const RESPONSE = ARRIVAL + 1000;

function single<T>(items: readonly T[]): T {
  assert.equal(items.length, 1, `se esperaba un elemento y hay ${String(items.length)}`);
  const [item] = items;
  assert.ok(item !== undefined);
  return item;
}

// Decimal guarda su valor en un campo privado, que deepEqual no compara: los saldos se comparan como texto.
function balances(bench: ReturnType<typeof venueBench>): Record<string, string> {
  return Object.fromEntries(Object.entries(bench.venue.balances()).map(([currency, value]) => [currency, value.toString()]));
}

function filledPrices(bench: ReturnType<typeof venueBench>): string[] {
  return bench.updates().flatMap((u) => u.fills.map((f) => `${f.quantity.toString()}@${f.price.toString()}`));
}

test('H01 bid/ask: una compra paga por encima del ask y una venta cobra por debajo del bid; nunca al precio de referencia', () => {
  const bench = venueBench({ cash: '100000' });
  bench.venue.submit(marketOrder('buy', '0.01'));
  bench.drain();
  bench.venue.submit(marketOrder('sell', '0.01'));
  bench.drain();
  // Referencia: apertura 40.000. Ask 40.030 y bid 39.970 (medio spread), más el slippage mínimo, al paso de 1 EUR.
  assert.deepEqual(filledPrices(bench), ['0.01@40051', '0.01@39950']);
});

test('H02 comisiones: cada fill paga la comisión taker sobre su importe, en EUR, redondeada al alza', () => {
  const bench = venueBench({ cash: '1000' });
  bench.venue.submit(marketOrder('buy', '0.01'));
  bench.drain();
  const buy = single(single(bench.updates()).fills);
  assert.deepEqual({ fee: buy.fee.toString(), currency: buy.feeCurrency, estimated: buy.feeEstimated }, { fee: '1.001275', currency: 'EUR', estimated: false });
  assert.deepEqual(balances(bench), { BTC: '0.01', EUR: '598.488725' });
  bench.venue.submit(marketOrder('sell', '0.01'));
  bench.drain();
  // 0,01 × 39.950 = 399,5 de importe y 0,99875 de comisión: la ida y vuelta cuesta 3,010025 EUR sobre 400.
  assert.deepEqual(balances(bench), { BTC: '0', EUR: '996.989975' });
});

test('H03 spread: el medio spread separa ask y bid de la referencia, y uno mayor empeora los dos lados', () => {
  const narrow = venueBench({ cash: '100000' });
  const wide = venueBench({ cash: '100000', costs: { ...COSTS, halfSpread: '0.002' } });
  for (const bench of [narrow, wide]) {
    bench.venue.submit(marketOrder('buy', '0.01'));
    bench.drain();
    bench.venue.submit(marketOrder('sell', '0.01'));
    bench.drain();
  }
  assert.deepEqual(filledPrices(narrow), ['0.01@40051', '0.01@39950']);
  assert.deepEqual(filledPrices(wide), ['0.01@40101', '0.01@39900']);
});

test('H04 slippage: cada fill paga al menos el slippage mínimo, también contra un libro real', () => {
  const books = [book(DECIDED, [['40010', '1']], [['39990', '1']])];
  const base = venueBench({ books, cash: '100000' });
  const more = venueBench({ books, cash: '100000', costs: { ...COSTS, minSlippage: '0.001' } });
  for (const bench of [base, more]) {
    bench.venue.submit(marketOrder('buy', '0.01'));
    bench.drain();
  }
  assert.deepEqual(filledPrices(base), ['0.01@40031'], '40.010 × 1,0005, al alza');
  assert.deepEqual(filledPrices(more), ['0.01@40051'], '40.010 × 1,001, al alza');
  assert.throws(() => executionCosts({ ...COSTS, minSlippage: '0.0004' }), CostModelError);
});

test('H05 profundidad: una orden mayor que el primer nivel recorre los siguientes, a precios peores', () => {
  const bench = venueBench({ cash: '100000' });
  bench.venue.submit(marketOrder('buy', '1'));
  bench.drain();
  // Libro sintético: 100 de volumen × 2 % = 2 BTC en 5 niveles de 0,4.
  assert.deepEqual(filledPrices(bench), ['0.4@40051', '0.4@40072', '0.2@40092']);
  const update = single(bench.updates());
  assert.equal(update.status, 'filled');
  assert.equal(update.averagePrice?.toString(), '40067.6', 'peor que los 40.051 de una orden pequeña');
});

test('H06 latencia: la orden se ejecuta en la vela de su llegada y la respuesta vuelve tras la latencia de vuelta; nada es síncrono', () => {
  const bench = venueBench();
  bench.venue.submit(marketOrder('buy', '0.01'));
  assert.equal(bench.captured.length, 0, 'submit no responde en el mismo instante');
  bench.drain();
  const [first] = bench.captured;
  assert.equal(first?.at, RESPONSE);
  assert.equal(single(single(bench.updates()).fills).exchangeTime, ARRIVAL);

  // Decidida medio segundo antes de que abra la vela siguiente: llega en ella y se ejecuta con su apertura.
  const late = T0 + HOUR - 500;
  const crossing = venueBench({ start: late, candles: [bar(T0), bar(T0 + HOUR, { o: '41000' })] });
  crossing.venue.submit(marketOrder('buy', '0.01', { expiresAt: late + 300_000 }));
  crossing.drain();
  assert.deepEqual(filledPrices(crossing), ['0.01@41052'], '41.000 × 1,00075 = 41.030,75 → 41.031; × 1,0005 → 41.052');
});

test('H07 ejecución parcial: lo que no cabe en la liquidez caduca, con la parte ejecutada', () => {
  const bench = venueBench({ cash: '200000' });
  bench.venue.submit(marketOrder('buy', '3'));
  bench.drain();
  const [partial, expired] = bench.updates();
  assert.equal(bench.updates().length, 2);
  assert.deepEqual([partial?.status, partial?.filled.toString(), partial?.fills.length], ['partially_filled', '2', 5]);
  assert.deepEqual([expired?.status, expired?.filled.toString(), expired?.fills.length], ['expired', '2', 0]);
  assert.equal(single(bench.venue.outcomes()).outcome, 'partial');
  assert.equal(balances(bench).BTC, '2');
});

test('H08 rechazos: símbolo desconocido o sin negociar, tipo no soportado, client order ID repetido y saldo insuficiente', () => {
  const listings = new Map([
    [SYMBOL, { listedAt: Date.UTC(2020, 0, 1), delistedAt: T0 + 30_000 }],
    ['ETH/EUR', { listedAt: T0 + HOUR, delistedAt: null }],
  ]);
  const delisted = venueBench({ listings, candles: [bar(T0), bar(T0, {}, 'ETH/EUR')] });
  delisted.venue.submit(marketOrder('buy', '0.01'));
  delisted.venue.submit(marketOrder('buy', '0.01', { symbol: 'ETH/EUR' }));
  delisted.venue.submit(marketOrder('buy', '0.01', { symbol: 'SOL/EUR' }));
  delisted.drain();
  assert.deepEqual(delisted.failures().map((f) => [f.operation, f.errorClass, f.detail.split(':')[0]]), [
    ['submit', 'rejected', 'SYMBOL_NOT_TRADING'],
    ['submit', 'rejected', 'SYMBOL_NOT_TRADING'],
    ['submit', 'rejected', 'SYMBOL_UNKNOWN'],
  ]);

  const bench = venueBench({ cash: '100' });
  const order = marketOrder('buy', '0.001');
  bench.venue.submit(marketOrder('buy', '0.01', { type: 'limit' }));
  bench.venue.submit(order);
  bench.venue.submit(order);
  bench.venue.submit(marketOrder('buy', '0.01'));
  bench.venue.submit(marketOrder('sell', '0.01'));
  bench.drain();
  assert.deepEqual(bench.failures().map((f) => [f.errorClass, f.detail.split(':')[0]]), [
    ['rejected', 'ORDER_TYPE_NOT_SUPPORTED'],
    ['rejected', 'DUPLICATE_CLIENT_ORDER_ID'],
    ['insufficient_funds', 'coste 401.511275 > saldo 59.8488725 EUR'],
    ['insufficient_funds', 'venta de 0.01 > saldo 0.001 BTC'],
  ]);
  assert.deepEqual(balances(bench), { BTC: '0.001', EUR: '59.8488725' }, 'solo la orden válida movió saldos');
});

test('H09 paso de precio: cinco cifras significativas, y cada fill en la rejilla, redondeado contra quien opera', () => {
  const steps = ['61234.5', '0.0012345', '100000', '99999.9', '1', '9.99999'].map((p) => priceStepFor(d(p), 5).toString());
  assert.deepEqual(steps, ['1', '0.0000001', '10', '1', '0.0001', '0.0001']);
  const bench = venueBench({ cash: '1000', candles: [bar(T0, { o: '0.123456', v: '100000' })] });
  bench.venue.submit(marketOrder('buy', '100'));
  bench.drain();
  bench.venue.submit(marketOrder('sell', '100'));
  bench.drain();
  // Paso de 0,00001. Compra: 0,123456 × 1,00075 → 0,12355 (al alza); × 1,0005 → 0,12362. Venta: × 0,99925 → 0,12336
  // (a la baja); × 0,9995 → 0,12329.
  assert.deepEqual(filledPrices(bench), ['100@0.12362', '100@0.12329']);
  const tick = priceStepFor(d('0.123456'), 5);
  assert.equal(tick.toString(), '0.00001');
  for (const update of bench.updates()) for (const fill of update.fills) assert.ok(fill.price.roundToStep(tick, 'DOWN').eq(fill.price));
});

test('H10 precisión de cantidad: una cantidad fuera del paso se rechaza y cada fill es un múltiplo del paso', () => {
  const bench = venueBench({ cash: '100000' });
  bench.venue.submit(marketOrder('buy', '0.000000015'));
  bench.venue.submit(marketOrder('buy', '0'));
  bench.drain();
  assert.deepEqual(bench.failures().map((f) => f.detail.split(':')[0]), ['LOT_SIZE', 'LOT_SIZE']);

  const thin = venueBench({ cash: '100000', candles: [bar(T0, { v: '0.333333333' })] });
  thin.venue.submit(marketOrder('buy', '0.002'));
  thin.drain();
  // 0,333333333 × 2 % / 5 = 0,0013333333332 por nivel, a la baja al paso de 1e-8: 0,00133333.
  assert.deepEqual(thin.updates().flatMap((u) => u.fills.map((f) => f.quantity.toString())), ['0.00133333', '0.00066667']);
});

test('H11 importe mínimo: por debajo de 5 EUR al precio de referencia se rechaza; justo en el mínimo, no', () => {
  const bench = venueBench({ cash: '1000' });
  bench.venue.submit(marketOrder('buy', '0.0001'));
  bench.venue.submit(marketOrder('buy', '0.000125'));
  bench.drain();
  assert.deepEqual(bench.failures().map((f) => f.detail), ['MIN_NOTIONAL: 4 < 5 EUR']);
  assert.equal(single(bench.updates()).status, 'filled');
});

test('H12 cancelación: llega tarde a una orden ya ejecutada, falla con una desconocida y puede adelantarse a la orden', () => {
  const bench = venueBench({ cash: '1000' });
  const order = marketOrder('buy', '0.01');
  bench.venue.submit(order);
  bench.drain();
  bench.venue.cancel({ clientOrderId: order.clientOrderId, reason: 'prueba', approvalId: null });
  bench.venue.cancel({ clientOrderId: 'ijp-desconocida', reason: 'prueba', approvalId: null });
  bench.venue.queryOrder(order.clientOrderId);
  bench.drain();
  const [, tooLate, query] = bench.updates();
  assert.deepEqual([tooLate?.status, tooLate?.origin, query?.status], ['filled', 'rest', 'filled'], 'cancelar no deshace lo ejecutado');
  assert.deepEqual(bench.failures().map((f) => [f.operation, f.errorClass]), [['cancel', 'order_not_found']]);

  // Carrera: la cancelación sale antes que la orden y llega antes. El exchange no la conoce todavía y la orden se ejecuta.
  const race = venueBench({ cash: '1000' });
  const raced = marketOrder('buy', '0.01');
  race.venue.cancel({ clientOrderId: raced.clientOrderId, reason: 'carrera', approvalId: null });
  race.venue.submit(raced);
  race.drain();
  assert.deepEqual(race.captured.map((c) => c.kind), ['failure', 'update']);
  assert.equal(single(race.updates()).status, 'filled');
});

test('H13 datos obsoletos: un libro antiguo no se usa y, sin operaciones en el intervalo de llegada, la orden caduca sin ejecutarse', () => {
  const stale = venueBench({ cash: '1000', books: [book(DECIDED - 120_000, [['39000', '1']], [['38990', '1']])] });
  stale.venue.submit(marketOrder('buy', '0.01'));
  stale.drain();
  assert.deepEqual(filledPrices(stale), ['0.01@40051'], 'libro sintético de la vela, no el libro de hace dos minutos');
  assert.equal(single(stale.venue.outcomes()).liquidity, 'synthetic');

  const gap = venueBench({ cash: '1000', candles: [bar(T0 - HOUR), bar(T0 + HOUR)] });
  gap.venue.submit(marketOrder('buy', '0.01'));
  gap.drain();
  const update = single(gap.updates());
  assert.deepEqual([update.status, update.filled.toString(), update.fills.length], ['expired', '0', 0]);
  assert.deepEqual(single(gap.venue.outcomes()).outcome, 'no_liquidity');
  assert.deepEqual(balances(gap), { EUR: '1000' });
});

test('H14 liquidez del libro: con un libro real al día se recorren sus niveles; si no llega, ejecución parcial; uno cruzado no vale', () => {
  const books = [book(DECIDED, [['40010', '0.005'], ['40020', '0.01']], [['39990', '0.01']])];
  const real = venueBench({ books, cash: '100000' });
  real.venue.submit(marketOrder('buy', '0.01'));
  real.drain();
  assert.deepEqual(filledPrices(real), ['0.005@40031', '0.005@40041']);
  assert.equal(single(real.venue.outcomes()).liquidity, 'book');

  const shallow = venueBench({ books, cash: '100000' });
  shallow.venue.submit(marketOrder('buy', '0.02'));
  shallow.drain();
  assert.deepEqual(shallow.updates().map((u) => [u.status, u.filled.toString()]), [['partially_filled', '0.015'], ['expired', '0.015']]);

  const crossed = venueBench({ books: [book(DECIDED, [['39990', '1']], [['40000', '1']])], cash: '100000' });
  crossed.venue.submit(marketOrder('buy', '0.01'));
  crossed.drain();
  assert.equal(single(crossed.venue.outcomes()).liquidity, 'synthetic', 'un libro cruzado es un dato inválido');
});

test('H15 caducidad: una orden que llega después de su expiresAt caduca sin ejecutarse', () => {
  const bench = venueBench({ cash: '1000' });
  bench.venue.submit(marketOrder('buy', '0.01', { expiresAt: DECIDED + 500 }));
  bench.drain();
  const update = single(bench.updates());
  assert.deepEqual([update.status, update.filled.toString()], ['expired', '0']);
  assert.equal(single(bench.venue.outcomes()).outcome, 'expired_ttl');
  assert.deepEqual(balances(bench), { EUR: '1000' });
});

test('H16 sin libro, el modelo es conservador y el informe lo declara con sus parámetros', () => {
  const synthetic = venueBench({ cash: '1000' });
  synthetic.venue.submit(marketOrder('buy', '0.01'));
  synthetic.drain();
  const report = synthetic.venue.report();
  assert.equal(report.bookData, false);
  assert.match(report.declaration, /^Sin datos de libro de órdenes: modelo sintético conservador/);
  assert.match(report.declaration, /0\.02 del volumen de la vela de ejecución en 5 niveles/);
  assert.deepEqual({ ...report.orders }, { total: 1, withBook: 0, synthetic: 1, filled: 1, partial: 0, no_liquidity: 0, expired_ttl: 0, rejected: 0, insufficient_funds: 0 });
  assert.deepEqual(report.costs, { commission: '0.0025', halfSpread: '0.00075', minSlippage: '0.0005', multiplier: '1' });

  const real = venueBench({ books: [book(DECIDED, [['40010', '1']], [['39990', '1']])], cash: '1000' });
  real.venue.submit(marketOrder('buy', '0.01'));
  real.drain();
  assert.equal(real.venue.report().bookData, true);
  assert.match(real.venue.report().declaration, /^Libro de órdenes real/);
});

test('H17 sin costes no hay backtest: por debajo de los mínimos el modelo no se construye; el estrés los multiplica todos', () => {
  for (const spec of [
    { ...COSTS, commission: '0.001' },
    { ...COSTS, commission: '0' },
    { ...COSTS, halfSpread: '0.0005' },
    { ...COSTS, minSlippage: '0' },
    { ...COSTS, multiplier: 0 },
    { ...COSTS, multiplier: 1.5 },
    { ...COSTS, commission: 'gratis' },
  ]) {
    assert.throws(() => executionCosts(spec), CostModelError, JSON.stringify(spec));
  }
  const doubled = executionCosts({ ...COSTS, multiplier: 2 });
  assert.deepEqual([doubled.commission, doubled.halfSpread, doubled.minSlippage].map(String), ['0.005', '0.0015', '0.001']);
  const stressed = venueBench({ costs: { ...COSTS, multiplier: 2 } });
  assert.equal(stressed.venue.report().depth.impactPerLevel, '0.001');
  assert.equal(DEFAULT_DEPTH_MODEL.impactPerLevel.toString(), '0.0005');
  assert.equal(DEFAULT_INSTRUMENT_RULES.minNotional.toString(), '5');
});

test('H18 reconciliación: la foto de la cuenta trae saldos, todas las órdenes y los fills desde la marca pedida', () => {
  const bench = venueBench({ cash: '1000' });
  const order = marketOrder('buy', '0.01');
  bench.venue.submit(order);
  bench.drain();
  bench.venue.requestAccountSnapshot(null);
  bench.venue.requestAccountSnapshot(ARRIVAL + 1);
  bench.drain();
  const snapshots = bench.captured.flatMap((c) => (c.kind === 'snapshot' ? [c.value] : []));
  const [all, later] = snapshots;
  assert.deepEqual(Object.entries(all?.balances ?? {}).map(([c, v]) => `${c}=${v.toString()}`), ['BTC=0.01', 'EUR=598.488725']);
  assert.deepEqual(all?.orders.map((o) => [o.clientOrderId, o.status, o.origin]), [[order.clientOrderId, 'filled', 'reconciliation']]);
  assert.deepEqual([all?.fills.length, later?.fills.length], [1, 0]);
});

// Stops de protección que esperan en el exchange (paso 23, ADR 0026): se compran 0,01 BTC en la vela de las 12:00 y
// después se coloca un stop de venta. Se comprueba al cierre de cada vela.
function stopOrder(trigger: string, quantity = '0.01') {
  return marketOrder('sell', quantity, { type: 'stop_market', triggerPrice: d(trigger), expiresAt: null });
}

function boughtBench(candles = [bar(T0 - HOUR), bar(T0), bar(T0 + HOUR)]) {
  const bench = venueBench({ cash: '1000', candles });
  bench.venue.submit(marketOrder('buy', '0.01'));
  bench.drain();
  return bench;
}

test('H19 stop por toque: si el mínimo de la vela toca el stop, se vende desde el precio del stop, al cierre de esa vela', () => {
  const bench = boughtBench();
  bench.venue.submit(stopOrder('39600'));
  bench.drain(T0 + HOUR + 5_000);
  const [, open, filled] = bench.updates();
  assert.equal(open?.status, 'open');
  // Referencia 39.600: bid 39.570 (medio spread, a la baja) y 39.550 con el slippage mínimo.
  assert.deepEqual([filled?.status, filled?.fills[0]?.price.toString(), filled?.fills[0]?.exchangeTime], ['filled', '39550', T0 + HOUR]);
  assert.match(single(bench.venue.outcomes().filter((o) => o.detail.startsWith('stop'))).detail, /^stop por toque, desde el stop 39600/);
  assert.deepEqual(balances(bench).BTC, '0');
});

test('H20 stop por hueco: si la vela abre más allá del stop, se vende desde la apertura', () => {
  const bench = boughtBench([bar(T0, { l: '39700' }), bar(T0 + HOUR, { o: '39000', h: '39100', l: '38800', c: '39050' })]);
  bench.venue.submit(stopOrder('39600'));
  bench.drain(T0 + 2 * HOUR + 5_000);
  const filled = bench.updates().find((u) => u.status === 'filled' && u.fills[0]?.side === 'sell');
  // Apertura 39.000: bid 38.970 y 38.950 con el slippage; la vela de las 12:00 no llegó al stop (mínimo 39.700).
  assert.deepEqual([filled?.fills[0]?.price.toString(), filled?.fills[0]?.exchangeTime], ['38950', T0 + 2 * HOUR]);
});

test('H21 un stop que espera bloquea su saldo, sigue esperando si no se toca y se cancela liberándolo', () => {
  const bench = boughtBench([bar(T0, { l: '39700' }), bar(T0 + HOUR, { l: '39700' }), bar(T0 + 2 * HOUR)]);
  const stop = stopOrder('39600');
  bench.venue.submit(stop);
  bench.venue.submit(marketOrder('sell', '0.01'));
  bench.drain(T0 + 2 * HOUR + 5_000);
  assert.deepEqual(bench.failures().map((f) => [f.errorClass, f.detail]), [['insufficient_funds', 'venta de 0.01 > saldo 0 BTC']]);
  assert.equal(bench.updates().at(-1)?.status, 'open', 'ninguna vela llegó al stop');
  bench.venue.cancel({ clientOrderId: stop.clientOrderId, reason: 'salida', approvalId: '00000000-0000-4000-8000-000000000999' });
  bench.drain(T0 + 2 * HOUR + 10_000);
  assert.equal(bench.updates().at(-1)?.status, 'canceled');
  bench.venue.submit(marketOrder('sell', '0.01', { expiresAt: T0 + 3 * HOUR }));
  bench.drain(T0 + 2 * HOUR + 20_000);
  assert.equal(balances(bench).BTC, '0', 'cancelado el stop, la venta tiene saldo');
});

test('H22 un stop que saltaría al llegar o con el disparo fuera del paso se rechaza', () => {
  const bench = boughtBench();
  bench.venue.submit(stopOrder('40000')); // la vela abrió en 40.000: ya está en el stop
  bench.venue.submit(stopOrder('39600.5'));
  bench.drain(T0 + 120_000);
  assert.deepEqual(bench.failures().map((f) => f.detail.split(':')[0]), ['STOP_WOULD_TRIGGER', 'PRICE_FILTER']);
});
