// Estrategia programada: el control aleatorio con el backtester real (docs/PROMOTION_CRITERIA.md A.3.12; paso 27B,
// ADR 0031). Entra y sale en los instantes de una colocación al azar de las operaciones de la estrategia, así que pasa por
// Risk, Execution, costes y fills como cualquier otra. No se presenta como estrategia ni cuenta en N: es un control.
// Cada entrada lleva el instante de la marca en que se decide; la estrategia la toma al evaluar la vela que se recibe en
// esa marca (su cierre es como mucho una vela anterior). Igual con la salida.
// El tamaño lo decide Risk con un stop lejano (`stopFraction`): sale una fracción menor que la de la estrategia, pero el
// Sharpe apenas depende del tamaño, porque rentabilidad y costes escalan con él. Pura: los instantes llegan en los parámetros.
import { close } from '../features/definitions.ts';
import type { FeatureSet } from '../features/types.ts';
import type { Timeframe, UtcMillis } from '../shared/time.ts';
import { timeframeMs } from '../shared/time.ts';
import type { StrategyKit } from './baselines.ts';
import type { Strategy, StrategyDecision } from './types.ts';

export interface ScheduledTrade {
  readonly symbol: string;
  readonly enterAt: UtcMillis; // marca en que se decide entrar
  readonly exitAt: UtcMillis; // marca en que se decide salir
}

export interface ScheduledParams {
  readonly trades: readonly ScheduledTrade[];
  readonly stopFraction: number;
}

export function scheduled(params: ScheduledParams, timeframe: Timeframe): StrategyKit<ScheduledParams> {
  if (!(params.stopFraction > 0 && params.stopFraction < 1)) throw new RangeError(`stopFraction debe estar en (0, 1): ${String(params.stopFraction)}`);
  const step = timeframeMs(timeframe);
  // Vela de la decisión: la que abre en floor(marca / vela) − 1 velas, porque su cierre + 1 ms es múltiplo de la vela.
  const bucket = (mark: UtcMillis): number => Math.floor(mark / step);
  const entries = new Set<string>();
  const exits = new Set<string>();
  for (const t of params.trades) {
    if (!(t.exitAt > t.enterAt)) throw new RangeError(`${t.symbol}: salida no posterior a la entrada`);
    entries.add(`${t.symbol}|${String(bucket(t.enterAt))}`);
    exits.add(`${t.symbol}|${String(bucket(t.exitAt))}`);
  }
  const featureSet: FeatureSet = Object.freeze({ id: 'cierre', version: 1, timeframe, features: Object.freeze([close()]) });
  const strategy: Strategy<ScheduledParams> = {
    id: 'control-programado',
    version: '1.0.0',
    featureSet: { id: featureSet.id, version: featureSet.version },
    warmupBars: 1,
    evaluate: ({ asOf, symbol, features, position, params: p }): StrategyDecision => {
      const c = features.values['close'] ?? null;
      if (c === null || !(c > 0)) return { action: 'hold', reason: 'sin features' };
      const key = `${symbol}|${String(bucket(asOf + 1))}`;
      if (position === null) return entries.has(key) ? { action: 'enter', stopPrice: c * (1 - p.stopFraction), reason: 'entrada programada' } : { action: 'hold', reason: 'fuera' };
      return exits.has(key) ? { action: 'exit', reason: 'salida programada' } : { action: 'hold', reason: 'dentro' };
    },
  };
  return Object.freeze({ strategy: Object.freeze(strategy), featureSet, params: Object.freeze({ ...params }) });
}
