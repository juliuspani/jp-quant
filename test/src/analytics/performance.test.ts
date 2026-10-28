// Métricas de rendimiento de analytics/ (pasos 24 y 26, ADR 0027 y ADR 0029): rentabilidades por periodo, Sharpe,
// Sortino, caída máxima y su duración, CAGR, Calmar, pérdidas de cola, alfa y beta, exposición, rotación y costes, con
// series sintéticas cuyo resultado se calcula a mano.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AnalyticsError, alphaBetaOf, cagrOf, drawdownOf, periodReturns, periodsPerYear, sharpeOf, sortinoOf, summarize, tailLossesOf,
} from '../../../src/analytics/performance.ts';

const HOUR = 3_600_000;

function near(actual: number | null | undefined, expected: number, tolerance = 1e-12): void {
  assert.ok(actual !== null && actual !== undefined, `se esperaba ${String(expected)} y es null`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${String(actual)} ≠ ${String(expected)}`);
}

test('rentabilidades simples y Sharpe por periodo con la desviación típica muestral', () => {
  assert.deepEqual(periodReturns([100, 110, 99]).map((r) => Math.round(r * 1e12) / 1e12), [0.1, -0.1]);
  // Rentabilidades 0,1 y −0,1: media 0, Sharpe 0. Con 0,02, 0,04 y 0,06: media 0,04, desviación 0,02, Sharpe 2.
  near(sharpeOf([0.1, -0.1]).sharpe, 0);
  const s = sharpeOf([0.02, 0.04, 0.06]);
  near(s.mean, 0.04);
  near(s.volatility, 0.02);
  near(s.sharpe, 2, 1e-9);
  assert.equal(sharpeOf([0.01, 0.01]).sharpe, null, 'sin variación no hay Sharpe');
  assert.equal(sharpeOf([0.01]).sharpe, null);
  assert.throws(() => periodReturns([100, 0, 5]), AnalyticsError);
});

test('se anualiza con 365 días: 8760 velas de 1h y 365 de 1d', () => {
  assert.equal(periodsPerYear('1h'), 8760);
  assert.equal(periodsPerYear('1d'), 365);
});

test('Sortino: la media entre la raíz de la media de las pérdidas al cuadrado; null sin pérdidas', () => {
  // [0,03, −0,01, 0,02, −0,02]: media 0,005; desviación a la baja √((0,0001 + 0,0004)/4) = 0,01118.
  near(sortinoOf([0.03, -0.01, 0.02, -0.02]), 0.005 / Math.sqrt(0.0005 / 4), 1e-12);
  assert.equal(sortinoOf([0.01, 0.02]), null);
});

test('caída máxima y su duración: periodos desde el máximo hasta recuperarlo, o hasta el final', () => {
  // Máximo 120 en la posición 1; cae a 90 (25 %) y recupera 120 en la 5: 4 periodos desde el máximo.
  const a = drawdownOf([100, 120, 110, 90, 100, 120, 130]);
  near(a.maxDrawdown, 0.25);
  assert.equal(a.maxDuration, 4);
  // Sin recuperar: cuenta hasta el final.
  const b = drawdownOf([100, 90, 95, 99]);
  near(b.maxDrawdown, 0.1);
  assert.equal(b.maxDuration, 3);
  assert.deepEqual(drawdownOf([1, 2, 3]), { maxDrawdown: 0, maxDuration: 0 });
});

test('CAGR: un 21 % en dos años de 365 velas diarias es un 10 % anual; −1 si se pierde todo', () => {
  near(cagrOf(100, 121, 730, 365), 0.1, 1e-12);
  assert.equal(cagrOf(100, 0, 10, 365), -1);
  assert.equal(cagrOf(100, 110, 0, 365), null);
});

test('pérdidas de cola al 95 %: VaR por cuantil de tipo 7, expected shortfall y peor periodo', () => {
  // −0,10, −0,05 y 18 de 0,01: el cuantil 5 % cae entre las dos pérdidas (h = 19·0,05 = 0,95): −0,1 + 0,95·0,05 = −0,0525.
  const returns = [-0.1, -0.05, ...Array.from({ length: 18 }, () => 0.01)];
  const tail = tailLossesOf(returns);
  near(tail?.valueAtRisk95, 0.0525, 1e-12);
  near(tail?.expectedShortfall95, 0.1, 1e-12);
  near(tail?.worstPeriod, -0.1);
  assert.equal(tailLossesOf([]), null);
});

test('alfa y beta: una estrategia que es 0,5 veces el benchmark más 0,001 por periodo', () => {
  const bench = [0.01, -0.02, 0.03, 0.005, -0.01, 0.02];
  const strat = bench.map((r) => 0.5 * r + 0.001);
  const ab = alphaBetaOf(strat, bench, 365);
  near(ab?.beta, 0.5, 1e-12);
  near(ab?.alpha, 0.001, 1e-12);
  near(ab?.alphaAnnualized, 0.365, 1e-9);
  near(ab?.correlation, 1, 1e-12);
  assert.equal(alphaBetaOf([0.1, 0.2, 0.3], [0.01, 0.01, 0.01], 365), null, 'benchmark sin variación');
  assert.throws(() => alphaBetaOf([0.1], [0.1, 0.2], 365), AnalyticsError);
});

test('resumen: neta, bruta (neta más costes realizados), caída, exposición y rotación', () => {
  const summary = summarize({
    timeframe: '1d',
    startEquity: 1000,
    endEquity: 990,
    curve: [
      { at: 1 * HOUR, equity: 1000, exposure: 0, exposureWithoutDust: 0 },
      { at: 2 * HOUR, equity: 1010, exposure: 250, exposureWithoutDust: 250 },
      { at: 3 * HOUR, equity: 995, exposure: 0, exposureWithoutDust: 0 },
    ],
    // Una compra y una venta de 250: comisiones 0,625 cada una; implícitos realizados 0,3 y 0,325.
    fills: [{ notional: 250, fee: 0.625, implicit: 0.3 }, { notional: 250, fee: 0.625, implicit: 0.325 }],
    liquidationCost: 0,
  });
  assert.equal(summary.periods, 3);
  near(summary.netPnl, -10);
  near(summary.netReturn, -0.01);
  near(summary.turnover, 0.5);
  near(summary.feesPaid, 1.25);
  near(summary.implicitCosts, 0.625);
  near(summary.totalCosts, 1.875);
  near(summary.costReturn, 0.001875);
  near(summary.grossReturn, -0.01 + 0.001875);
  near(summary.timeInMarket, 1 / 3);
  near(summary.meanExposure, 250 / 1010 / 3);
  // Máximo 1010; la liquidación a 990 es la caída máxima (20/1010) y dura 2 periodos.
  near(summary.maxDrawdown, 20 / 1010);
  assert.equal(summary.maxDrawdownDuration, 2);
  assert.ok(summary.sharpe !== null && summary.sharpeAnnualized !== null && summary.volatility !== null);
  near(summary.sharpeAnnualized, summary.sharpe * Math.sqrt(365), 1e-12);
  near(summary.volatilityAnnualized, summary.volatility * Math.sqrt(365), 1e-12);
  near(summary.cagr, (990 / 1000) ** (365 / 3) - 1, 1e-12);
  near(summary.calmar, (summary.cagr ?? 0) / summary.maxDrawdown, 1e-12);
});

test('tiempo en mercado y exposición media sin polvo: un resto que no se puede vender no cuenta (ADR 0033)', () => {
  const summary = summarize({
    timeframe: '1d',
    startEquity: 1000,
    endEquity: 1000,
    curve: [
      { at: 1 * HOUR, equity: 1000, exposure: 3, exposureWithoutDust: 0 },
      { at: 2 * HOUR, equity: 1000, exposure: 250, exposureWithoutDust: 250 },
    ],
    fills: [],
    liquidationCost: 0,
  });
  near(summary.timeInMarket, 1 / 2);
  near(summary.meanExposure, 0.25 / 2);
});

test('fail closed: un valor no finito, un patrimonio inicial no positivo o una curva desordenada lanzan', () => {
  const base = { timeframe: '1h' as const, startEquity: 1000, endEquity: 1000, curve: [], fills: [], liquidationCost: 0 };
  assert.equal(summarize(base).timeInMarket, null);
  assert.throws(() => summarize({ ...base, startEquity: 0 }), AnalyticsError);
  assert.throws(() => summarize({ ...base, endEquity: Number.NaN }), AnalyticsError);
  assert.throws(() => summarize({ ...base, fills: [{ notional: Number.POSITIVE_INFINITY, fee: 0, implicit: 0 }] }), AnalyticsError);
  assert.throws(() => summarize({ ...base, fills: [{ notional: 1, fee: 0, implicit: Number.NaN }] }), AnalyticsError);
  assert.throws(
    () => summarize({ ...base, curve: [{ at: 2, equity: 1000, exposure: 0, exposureWithoutDust: 0 }, { at: 1, equity: 1000, exposure: 0, exposureWithoutDust: 0 }] }),
    AnalyticsError,
  );
});
