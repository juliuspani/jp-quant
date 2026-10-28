// Precios sin estructura para el control negativo (quant-research §6, prueba de humo): un paseo aleatorio multiplicativo
// con media cero en cada vela, así que el precio es una martingala y ninguna regla de entrada y salida gana en
// esperanza antes de costes. Velas horarias de BTC/EUR que abren en el cierre anterior (sin huecos), con máximo y mínimo
// algo por fuera, y received_time al cierre más un minuto. Lo usan test/src/app/baselines.test.ts y
// test/invariants/strategy-risk.test.ts.
import type { BacktestSpec } from '../../../src/app/backtest.ts';
import type { HistoricalCandle } from '../../../src/historical/types.ts';
import { seededRng } from '../../../src/kernel/random.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { closeTimeOf } from '../../../src/shared/time.ts';
import type { StrategyKit } from '../../../src/strategy/baselines.ts';
import { HOUR, LATENCY, SYMBOL, T0 } from './scenario.ts';

export const COSTS = { commission: '0.0025', halfSpread: '0.00075', minSlippage: '0.0005', multiplier: 1 } as const;

/** Cierres del paseo: cada vela multiplica el precio por 1 + σ·z, con z de media 0 y varianza 1 (suma de tres uniformes). */
export function walkCloses(seed: number, count: number, sigma = 0.005, start = 100): number[] {
  const rng = seededRng(seed, 'paseo');
  const closes: number[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const z = (rng.next() + rng.next() + rng.next() - 1.5) * 2;
    price *= 1 + sigma * z;
    closes.push(price);
  }
  return closes;
}

export function walkCandles(closes: readonly number[], start = 100): HistoricalCandle[] {
  const rng = seededRng(closes.length, 'mechas');
  let previous = start;
  return closes.map((c, i) => {
    const open = previous;
    previous = c;
    const openTime = T0 + i * HOUR;
    const closeTime = closeTimeOf(openTime, '1h');
    return {
      symbol: SYMBOL,
      timeframe: '1h',
      openTime,
      closeTime,
      receivedTime: closeTime + LATENCY,
      open: Decimal.parse(open.toFixed(2)),
      high: Decimal.parse((Math.max(open, c) * (1 + 0.002 * rng.next())).toFixed(2)),
      low: Decimal.parse((Math.min(open, c) * (1 - 0.002 * rng.next())).toFixed(2)),
      close: Decimal.parse(c.toFixed(2)),
      volume: Decimal.parse('1000'),
    };
  });
}

/** Backtest de una estrategia de referencia sobre estas velas, desde la vela `from` hasta la última. */
export function kitSpec<P>(kit: StrategyKit<P>, candles: readonly HistoricalCandle[], seed: number, from = kit.strategy.warmupBars): BacktestSpec<P> {
  return {
    runId: `${kit.strategy.id}-${String(seed)}`,
    seed,
    commit: 'prueba',
    candles,
    listings: new Map([[SYMBOL, { listedAt: T0, delistedAt: null }]]),
    from: T0 + from * HOUR,
    to: T0 + candles.length * HOUR,
    featureSet: kit.featureSet,
    strategy: kit.strategy,
    params: kit.params,
    costs: COSTS,
    startingCash: Decimal.parse('1000'),
    quoteCurrency: 'EUR',
  };
}
