// Paso 24 (ADR 0027): las estrategias de referencia sobre el sistema compuesto. Comprueban el camino completo Data →
// Features → Strategy → Risk → Execution → Fill → Portfolio → Analytics y hacen el control de cordura: RANDOM, sobre
// precios sin estructura, pierde más o menos los costes; si ganara de forma consistente habría un fallo o leakage. Datos
// sintéticos: no cuentan como pruebas del registro (quant-research §10).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type BacktestResult } from '../../../src/app/backtest.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { baseline, buyAndHold, random, type StrategyKit } from '../../../src/strategy/baselines.ts';
import type { Strategy } from '../../../src/strategy/types.ts';
import { candles, HOUR, T0, upAndDown } from './scenario.ts';
import { traceOrders } from './trace.ts';
import { kitSpec, walkCandles, walkCloses } from './walk.ts';

const BARS = 600;
const RUNS = 30;

const kits = {
  baseline: baseline({ emaPeriod: 10, stopFraction: 0.05 }, '1h'),
  random: random({ seed: 1, entryProbability: 0.2, exitProbability: 0.1, stopFraction: 0.05 }, '1h'),
  buyAndHold: buyAndHold({ stopFraction: 0.5 }, '1h'),
};

function run<P>(kit: StrategyKit<P>, closes: readonly number[], seed = 1): BacktestResult {
  return runBacktest(kitSpec(kit, walkCandles(closes), seed));
}

function num(text: string): number {
  return Decimal.parse(text).toAnalysis();
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function standardError(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1) / values.length);
}

test('camino completo para las tres: cada fill vuelve a Risk, la cartera cuadra con los fills y analytics con la cartera', () => {
  const closes = walkCloses(11, 400);
  for (const kit of Object.values(kits) as StrategyKit<unknown>[]) {
    const result = run(kit, closes);
    const name = kit.strategy.id;
    assert.equal(result.halted, null, name);
    // Data → Features → Strategy: una evaluación por vela del tramo.
    const evaluated = result.journal.filter((e) => e.type === 'StrategyEvaluated').length;
    assert.equal(evaluated, 400 - kit.strategy.warmupBars, `${name}: una evaluación por vela`);
    // Strategy → Risk → Execution → Fill: cada orden y cada fill tienen intención, decisión aprobada y token previos.
    const orders = traceOrders(result.journal);
    const fills = orders.flatMap((o) => o.fills);
    assert.ok(fills.length >= 1, `${name}: opera`);
    assert.equal(fills.length, result.metrics.fills, `${name}: todos los fills del venue están en el diario`);
    assert.ok(orders.every((o) => o.intent.strategyId === name));
    // Fill → Portfolio: la caja final es la inicial menos las compras y más las ventas, con sus comisiones.
    let cash = Decimal.parse('1000');
    for (const fill of fills) {
      const notional = fill.quantity.times(fill.price);
      cash = fill.side === 'buy' ? cash.minus(notional).minus(fill.fee) : cash.plus(notional).minus(fill.fee);
    }
    const last = result.equityCurve.at(-1);
    assert.ok(last !== undefined);
    const trips = result.roundTrips;
    assert.equal(trips.filter((t) => t.closedAt !== null).length, result.metrics.closedTrades, name);
    if (result.metrics.openPositions === 0) assert.equal(last.equity, cash.toString(), `${name}: sin posiciones, patrimonio = caja`);
    // Portfolio → Analytics: el resumen sale de la misma curva y de los mismos fills.
    const p = result.performance;
    assert.ok(Math.abs(p.netReturn - num(result.metrics.netReturn)) < 1e-6, name);
    assert.ok(Math.abs(p.feesPaid - num(result.metrics.feesPaid)) < 1e-9, name);
    assert.equal(p.periods, result.equityCurve.length);
    assert.ok(p.totalCosts > 0 && p.turnover > 0 && p.timeInMarket !== null && p.timeInMarket > 0, name);
    assert.ok(Math.abs(p.grossReturn - (p.netReturn + p.costReturn)) < 1e-12, name);
  }
});

test('BASELINE entra cuando el cierre supera la EMA y sale cuando cae por debajo; no se presenta como rentable', () => {
  const kit = baseline({ emaPeriod: 2, stopFraction: 0.05 }, '1h');
  const result = runBacktest({ ...kitSpec(kit, candles(upAndDown()), 1), to: T0 + 40 * HOUR });
  const reasons = result.journal.filter((e) => e.type === 'OrderIntentCreated').map((e) => (e.payload as { reason: string }).reason);
  assert.ok(reasons.includes('cierre sobre la EMA') && reasons.includes('cierre bajo la EMA'), reasons.join(', '));
  assert.ok(result.metrics.closedTrades >= 1);
  traceOrders(result.journal);
});

test('BUY_AND_HOLD es el benchmark: una compra al empezar, mantiene todo el tramo y sigue al mercado con lo que Risk le deja', () => {
  const up = walkCloses(5, BARS).map((c, i) => c * (1 + i / BARS)); // el mismo paseo con una deriva alcista
  const down = walkCloses(5, BARS).map((c, i) => c * (1 - (0.3 * i) / BARS)); // sin llegar al stop del 50 %
  const rising = run(kits.buyAndHold, up);
  const falling = run(kits.buyAndHold, down);
  for (const result of [rising, falling]) {
    const buys = traceOrders(result.journal).filter((o) => o.intent.kind === 'entry');
    assert.equal(buys.length, 1, 'una sola entrada');
    assert.equal(result.metrics.closedTrades, 0, 'no sale');
    assert.ok((result.performance.timeInMarket ?? 0) > 0.99);
    // Risk dimensiona por el stop: 0,75 % del patrimonio entre el 50 % de distancia y los costes, menos de un 2 %.
    const exposure = num(buys[0]?.decision.approvedNotional?.toString() ?? '0') / 1000;
    assert.ok(exposure > 0.01 && exposure < 0.02, String(exposure));
  }
  assert.ok(rising.performance.netReturn > 0 && falling.performance.netReturn < 0);
  // Un solo viaje: su rentabilidad bruta es la del mercado por la parte invertida.
  const market = (up.at(-1) ?? 0) / (up[0] ?? 1) - 1;
  const share = rising.performance.grossReturn / market;
  assert.ok(share > 0.01 && share < 0.03, `parte del mercado capturada: ${String(share)}`);
});

test('control negativo: sobre precios sin estructura RANDOM pierde más o menos los costes y no gana de forma consistente', () => {
  const net: number[] = [];
  const gross: number[] = [];
  const costs: number[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const kit = random({ seed: 1000 + i, entryProbability: 0.2, exitProbability: 0.1, stopFraction: 0.05 }, '1h');
    const result = run(kit, walkCloses(i, BARS), i);
    assert.equal(result.halted, null);
    assert.ok(result.metrics.closedTrades >= 20, 'opera lo bastante para medir');
    net.push(result.performance.netReturn);
    gross.push(result.performance.grossReturn);
    costs.push(result.performance.costReturn);
  }
  const lossShare = -mean(net) / mean(costs);
  // La bruta (neta más costes) es ruido alrededor de cero: no puede ser significativamente positiva.
  assert.ok(mean(gross) < 2 * standardError(gross), `bruta media ${String(mean(gross))} ± ${String(standardError(gross))}: fallo o leakage`);
  assert.ok(Math.abs(mean(gross)) < 3 * standardError(gross) + 0.25 * mean(costs), `bruta media ${String(mean(gross))}`);
  assert.ok(lossShare > 0.6 && lossShare < 1.6, `pierde ${String(lossShare)} veces los costes`);
  assert.ok(net.filter((r) => r > 0).length <= RUNS / 5, `gana en ${String(net.filter((r) => r > 0).length)} de ${String(RUNS)}`);
});

test('el control tiene potencia: una estrategia con look-ahead sobre los mismos precios gana de forma consistente y lo delata', () => {
  // Hace trampa a propósito: conoce los cierres futuros del paseo. Sirve para ver que el control de cordura distingue.
  const ORACLE_HORIZON = 10;
  const gross: number[] = [];
  for (let i = 1; i <= 8; i++) {
    const closes = walkCloses(i, BARS);
    const future = new Map(closes.map((c, k) => [T0 + (k + 1) * HOUR, (closes[k + ORACLE_HORIZON] ?? c) / c - 1]));
    const oracle: Strategy<{ readonly stopFraction: number }> = {
      ...kits.buyAndHold.strategy,
      id: 'oraculo',
      evaluate: ({ asOf, features, position }) => {
        const c = features.values['close'] ?? null;
        const ahead = future.get(asOf) ?? null;
        if (c === null || ahead === null) return { action: 'hold', reason: 'sin datos' };
        if (position === null) return ahead > 0.02 ? { action: 'enter', stopPrice: c * 0.9, reason: 'sabe que sube' } : { action: 'hold', reason: 'fuera' };
        return ahead < 0 ? { action: 'exit', reason: 'sabe que baja' } : { action: 'hold', reason: 'dentro' };
      },
    };
    const result = runBacktest({ ...kitSpec({ ...kits.buyAndHold, strategy: oracle }, walkCandles(closes), i) });
    assert.ok(result.metrics.closedTrades >= 5);
    gross.push(result.performance.netReturn);
  }
  assert.ok(mean(gross) > 3 * standardError(gross) && gross.every((r) => r > 0), `con look-ahead gana: ${gross.join(', ')}`);
});
