// Estadísticas de operaciones y benchmark buy-and-hold de analytics/ (paso 26, ADR 0029), con valores calculados a mano.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buyAndHold, type PricePoint } from '../../../src/analytics/benchmark.ts';
import { AnalyticsError } from '../../../src/analytics/performance.ts';
import { tradeStats, type TradeRecord } from '../../../src/analytics/trades.ts';

const DAY = 86_400_000;

function near(actual: number | null | undefined, expected: number, tolerance = 1e-12): void {
  assert.ok(actual !== null && actual !== undefined, `se esperaba ${String(expected)} y es null`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${String(actual)} ≠ ${String(expected)}`);
}

function trade(pnl: number | null, days: number, invested = 100): TradeRecord {
  return { symbol: 'BTC/EUR', strategy: 'prueba@1', openedAt: 0, closedAt: pnl === null ? null : days * DAY, invested, pnl };
}

test('operaciones: acierto, profit factor, esperanza y relación ganancia/pérdida de las cerradas', () => {
  // Ganan 30 y 10, pierden 20 y 5, una a 0 y una abierta.
  const stats = tradeStats([trade(30, 4), trade(-20, 2), trade(10, 6), trade(-5, 1), trade(0, 2), trade(null, 0)], '1d');
  assert.equal(stats.closed, 5);
  assert.equal(stats.open, 1);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 2);
  near(stats.hitRate, 0.4);
  near(stats.profitFactor, 40 / 25);
  near(stats.expectancy, 15 / 5);
  near(stats.expectancyReturn, 0.03);
  near(stats.averageWin, 20);
  near(stats.averageLoss, -12.5);
  near(stats.winLossRatio, 1.6);
  near(stats.netPnl, 15);
  near(stats.meanBars, 3);
});

test('operaciones: sin pérdidas no hay profit factor ni relación; sin cerradas, todo null', () => {
  const stats = tradeStats([trade(5, 1), trade(7, 1)], '1d');
  assert.equal(stats.profitFactor, null);
  assert.equal(stats.winLossRatio, null);
  const none = tradeStats([trade(null, 0)], '1d');
  assert.equal(none.hitRate, null);
  assert.equal(none.expectancy, null);
  assert.equal(none.meanBars, null);
  assert.throws(() => tradeStats([trade(5, 1, 0)], '1d'), AnalyticsError);
  assert.throws(() => tradeStats([{ ...trade(5, 1), closedAt: -DAY }], '1d'), AnalyticsError);
});

function series(closes: readonly number[], first = DAY): PricePoint[] {
  return closes.map((close, i) => ({ at: first + i * DAY, close }));
}

test('buy-and-hold de un símbolo: compra al último cierre ≤ from pagando costes y vende al final', () => {
  const prices = new Map([['BTC/EUR', series([100, 110, 121, 99])]]);
  // Compra al cierre del día 1 (100) con 1000 menos un 0,5 % de costes: 9,95 unidades.
  const curve = buyAndHold({ prices, from: DAY, samples: [2 * DAY, 3 * DAY, 4 * DAY], capital: 1000, costRate: 0.005, maxStaleMs: 2 * DAY });
  assert.deepEqual(curve.symbols, ['BTC/EUR']);
  near(curve.equity[0], 9.95 * 110, 1e-9);
  near(curve.equity[1], 9.95 * 121, 1e-9);
  near(curve.equity[2], 9.95 * 99, 1e-9);
  near(curve.end, 9.95 * 99 * 0.995, 1e-9);
});

test('buy-and-hold equiponderado: solo los que cotizan al empezar (point-in-time), sin rebalancear', () => {
  const prices = new Map([
    ['ETH/EUR', series([10, 20, 30])],
    ['BTC/EUR', series([100, 100, 50])],
    ['SOL/EUR', series([1, 1], 3 * DAY)], // empieza a cotizar después
  ]);
  const curve = buyAndHold({ prices, from: DAY, samples: [2 * DAY, 3 * DAY], capital: 1000, costRate: 0, maxStaleMs: DAY });
  assert.deepEqual(curve.symbols, ['BTC/EUR', 'ETH/EUR']);
  // 5 BTC y 50 ETH: 500 + 1000 y después 250 + 1500.
  near(curve.equity[0], 1500, 1e-9);
  near(curve.equity[1], 1750, 1e-9);
  near(curve.end, 1750, 1e-9);
});

test('buy-and-hold: fail closed si un símbolo deja de cotizar en el tramo o si nada cotiza al empezar', () => {
  const prices = new Map([['BTC/EUR', series([100, 110])]]);
  assert.throws(() => buyAndHold({ prices, from: DAY, samples: [2 * DAY, 5 * DAY], capital: 1000, costRate: 0, maxStaleMs: DAY }), AnalyticsError);
  assert.throws(() => buyAndHold({ prices, from: 0, samples: [DAY], capital: 1000, costRate: 0, maxStaleMs: DAY }), AnalyticsError);
  assert.throws(() => buyAndHold({ prices, from: DAY, samples: [], capital: 1000, costRate: 1, maxStaleMs: DAY }), AnalyticsError);
});
