// Control aleatorio y señal desplazada (paso 27B, ADR 0031) sobre un paseo aleatorio, que no tiene estructura: una
// estrategia que conoce el futuro supera al percentil 95 del control, una al azar no, y la señal desplazada de la que
// conoce el futuro vuelve a ser nula. Además, el simulador da exactamente lo esperado en un caso a mano.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsError, sharpeOf } from '../../../src/analytics/performance.ts';
import {
  percentileOf, RANDOM_CONTROL_SIMULATIONS, randomControl, shiftedSignal, simulateTrades, type ControlMarket, type ControlTrade,
} from '../../../src/analytics/random-control.ts';
import { seededRng } from '../../../src/kernel/random.ts';

function walk(seed: number, n: number): number[] {
  const rng = seededRng(seed, 'paseo');
  const prices = [100];
  for (let i = 1; i < n; i++) prices.push((prices.at(-1) ?? 100) * (1 + 0.02 * (rng.next() + rng.next() + rng.next() - 1.5) * 2));
  return prices;
}

function market(prices: readonly (number | null)[], costRate = 0.004): ControlMarket {
  return { folds: [{ bars: prices.length, prices: new Map([['BTC/EUR', prices]]) }], costRate, perYear: 365 };
}

test('simulador: cada periodo suma la fracción por lo que se mueve el cierre, y paga el coste por lado al entrar y al salir', () => {
  const m = market([100, 110, 121, 121], 0.01);
  const returns = simulateTrades(m, [{ symbol: 'BTC/EUR', fold: 0, start: 0, bars: 2, fraction: 0.5 }]);
  assert.equal(returns.length, 3);
  assert.ok(Math.abs((returns[0] ?? 0) - (0.05 - 0.005)) < 1e-15);
  assert.ok(Math.abs((returns[1] ?? 0) - (0.05 - 0.005)) < 1e-15);
  assert.equal(returns[2], 0);
  assert.throws(() => simulateTrades(m, [{ symbol: 'BTC/EUR', fold: 0, start: 2, bars: 2, fraction: 0.5 }]), AnalyticsError, 'fuera del tramo');
  assert.throws(() => simulateTrades(market([100, null, 121]), [{ symbol: 'BTC/EUR', fold: 0, start: 0, bars: 1, fraction: 0.5 }]), AnalyticsError);
});

/** Operaciones de un día que entran justo antes de las mayores subidas: conocen el futuro. */
function foresight(prices: readonly number[], count: number): ControlTrade[] {
  const moves = prices.slice(1).map((p, k) => ({ k, r: p / (prices[k] ?? p) - 1 }));
  return moves
    .sort((a, b) => b.r - a.r)
    .slice(0, count)
    .map(({ k }) => ({ symbol: 'BTC/EUR', fold: 0, start: k, bars: 1, fraction: 0.5 }));
}

test('control aleatorio: la estrategia que conoce el futuro queda por encima del percentil 95 y su réplica es su Sharpe con el simulador', () => {
  const prices = walk(5, 600);
  const m = market(prices);
  const trades = foresight(prices, 40);
  const control = randomControl(m, trades, RANDOM_CONTROL_SIMULATIONS, seededRng(1, 'control'));
  assert.equal(control.simulations, 1000);
  const replica = (sharpeOf(simulateTrades(m, trades)).sharpe ?? 0) * Math.sqrt(365);
  assert.equal(control.replica, replica);
  assert.ok(replica > control.p95, `${String(replica)} ≤ p95 ${String(control.p95)}`);
  assert.equal(percentileOf(control.sharpes, replica), 1);
  const again = randomControl(m, trades, RANDOM_CONTROL_SIMULATIONS, seededRng(1, 'control'));
  assert.equal(again.p95, control.p95, 'determinista por semilla');
});

test('control aleatorio: una estrategia al azar no supera el percentil 95 (salvo por azar, con su semilla fija)', () => {
  const prices = walk(8, 600);
  const m = market(prices);
  const rng = seededRng(2, 'azar');
  const trades: ControlTrade[] = Array.from({ length: 30 }, () => ({ symbol: 'BTC/EUR', fold: 0, start: Math.floor(rng.next() * 590), bars: 5, fraction: 0.5 }));
  const control = randomControl(m, trades, RANDOM_CONTROL_SIMULATIONS, seededRng(1, 'control'));
  assert.ok((control.replica ?? 0) < control.p95);
  assert.ok(percentileOf(control.sharpes, control.replica ?? 0) < 0.95);
});

test('señal desplazada: desplazar la que conoce el futuro destruye su ventaja; la mediana queda por debajo del percentil 95', () => {
  const prices = walk(5, 600);
  const m = market(prices);
  const trades = foresight(prices, 40);
  const control = randomControl(m, trades, RANDOM_CONTROL_SIMULATIONS, seededRng(1, 'control'));
  const shifted = shiftedSignal(m, trades, 100, seededRng(1, 'desplazada'));
  assert.equal(shifted.shifts, 100);
  assert.ok(shifted.median < control.p95, `${String(shifted.median)} ≥ ${String(control.p95)}`);
});

test('sin operaciones, o sin sitio para colocarlas, el control no se construye', () => {
  const m = market(walk(1, 50));
  assert.throws(() => randomControl(m, [], 1000, seededRng(1, 'c')), AnalyticsError);
  assert.throws(() => shiftedSignal(m, [], 100, seededRng(1, 'c')), AnalyticsError);
  const gaps = market([100, null, 101, null, 102, null]);
  assert.throws(() => randomControl(gaps, [{ symbol: 'BTC/EUR', fold: 0, start: 0, bars: 0, fraction: 0.5 }], 10, seededRng(1, 'c')), AnalyticsError);
});
