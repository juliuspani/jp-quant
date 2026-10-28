// Estrategias de referencia (paso 24, ADR 0027). Sirven para comprobar el pipeline y para comparar, no para operar:
// ninguna se presenta como rentable (quant-research §1 y §11).
// - BASELINE: deliberadamente sencilla. Entra cuando el cierre supera su EMA y sale cuando cae por debajo.
// - RANDOM: control negativo (quant-research §6). Entra y sale al azar; sobre precios sin estructura debe perder más o
//   menos los costes. Si gana de forma consistente, hay un fallo o leakage.
// - BUY_AND_HOLD: benchmark. Entra en cuanto puede y no sale; si salta el stop de protección, vuelve a entrar.
// Todas pasan por Risk como cualquier estrategia: el tamaño lo decide Risk (riesgo por operación, exposición y
// concentración), así que BUY_AND_HOLD tiene la parte del patrimonio que Risk permite, no el 100 %.
// Son puras (types.ts): el azar de RANDOM sale de la semilla de sus parámetros, el símbolo y el cierre de la vela.
// Ningún parámetro tiene valor por defecto: los fija quien las usa, y en research, el pre-registro (paso 25).
import { close, ema } from '../features/definitions.ts';
import type { FeatureSet } from '../features/types.ts';
import { checkSeed, seededUnit } from '../kernel/random.ts';
import type { Timeframe } from '../shared/time.ts';
import type { Strategy, StrategyDecision } from './types.ts';

/** Una estrategia con su conjunto de features, construidos con los mismos parámetros. */
export interface StrategyKit<P> {
  readonly strategy: Strategy<P>;
  readonly featureSet: FeatureSet;
  readonly params: P;
}

export interface BaselineParams {
  readonly emaPeriod: number;
  readonly stopFraction: number; // stop a esta fracción por debajo del cierre de la señal
}

export interface RandomParams {
  readonly seed: number;
  readonly entryProbability: number; // por vela, sin posición
  readonly exitProbability: number; // por vela, con posición: duración media de 1/exitProbability velas
  readonly stopFraction: number;
}

export interface BuyAndHoldParams {
  readonly stopFraction: number;
}

function checkFraction(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new RangeError(`${name} debe estar en (0, 1): ${String(value)}`);
}

function closeOf(values: Readonly<Record<string, number | null>>): number | null {
  const c = values['close'] ?? null;
  return c !== null && Number.isFinite(c) && c > 0 ? c : null;
}

function enter(c: number, stopFraction: number, reason: string): StrategyDecision {
  return { action: 'enter', stopPrice: c * (1 - stopFraction), reason };
}

/** BASELINE: cierre frente a su EMA de `emaPeriod` velas. */
export function baseline(params: BaselineParams, timeframe: Timeframe): StrategyKit<BaselineParams> {
  checkFraction('stopFraction', params.stopFraction);
  const average = ema(params.emaPeriod); // valida el periodo
  const featureSet: FeatureSet = Object.freeze({
    id: `cierre-${average.id}`,
    version: 1,
    timeframe,
    features: Object.freeze([close(), average]),
  });
  const strategy: Strategy<BaselineParams> = {
    id: 'baseline-cierre-ema',
    version: '1.0.0',
    featureSet: { id: featureSet.id, version: featureSet.version },
    warmupBars: average.warmupBars,
    evaluate: ({ features, position, params: p }): StrategyDecision => {
      const c = closeOf(features.values);
      const m = features.values[average.id] ?? null;
      if (c === null || m === null) return { action: 'hold', reason: 'sin features' };
      if (position === null) return c > m ? enter(c, p.stopFraction, 'cierre sobre la EMA') : { action: 'hold', reason: 'cierre bajo la EMA' };
      return c < m ? { action: 'exit', reason: 'cierre bajo la EMA' } : { action: 'hold', reason: 'cierre sobre la EMA' };
    },
  };
  return Object.freeze({ strategy: Object.freeze(strategy), featureSet, params: Object.freeze({ ...params }) });
}

function closeOnly(timeframe: Timeframe): FeatureSet {
  return Object.freeze({ id: 'cierre', version: 1, timeframe, features: Object.freeze([close()]) });
}

/** RANDOM: en cada vela, entra con probabilidad `entryProbability` y sale con `exitProbability`. */
export function random(params: RandomParams, timeframe: Timeframe): StrategyKit<RandomParams> {
  checkSeed(params.seed);
  checkFraction('entryProbability', params.entryProbability);
  checkFraction('exitProbability', params.exitProbability);
  checkFraction('stopFraction', params.stopFraction);
  const featureSet = closeOnly(timeframe);
  const strategy: Strategy<RandomParams> = {
    id: 'random',
    version: '1.0.0',
    featureSet: { id: featureSet.id, version: featureSet.version },
    warmupBars: 1,
    evaluate: ({ asOf, symbol, features, position, params: p }): StrategyDecision => {
      const c = closeOf(features.values);
      if (c === null) return { action: 'hold', reason: 'sin features' };
      // Solo la semilla, el símbolo y el instante: ningún precio entra en la decisión, que no puede saber nada del mercado.
      const u = seededUnit(p.seed, `${symbol}|${String(asOf)}`);
      if (position === null) return u < p.entryProbability ? enter(c, p.stopFraction, 'entrada al azar') : { action: 'hold', reason: 'fuera, al azar' };
      return u < p.exitProbability ? { action: 'exit', reason: 'salida al azar' } : { action: 'hold', reason: 'dentro, al azar' };
    },
  };
  return Object.freeze({ strategy: Object.freeze(strategy), featureSet, params: Object.freeze({ ...params }) });
}

/** BUY_AND_HOLD: entra en cuanto puede y mantiene la posición. */
export function buyAndHold(params: BuyAndHoldParams, timeframe: Timeframe): StrategyKit<BuyAndHoldParams> {
  checkFraction('stopFraction', params.stopFraction);
  const featureSet = closeOnly(timeframe);
  const strategy: Strategy<BuyAndHoldParams> = {
    id: 'buy-and-hold',
    version: '1.0.0',
    featureSet: { id: featureSet.id, version: featureSet.version },
    warmupBars: 1,
    evaluate: ({ features, position, params: p }): StrategyDecision => {
      if (position !== null) return { action: 'hold', reason: 'mantener' };
      const c = closeOf(features.values);
      return c === null ? { action: 'hold', reason: 'sin features' } : enter(c, p.stopFraction, 'comprar y mantener');
    },
  };
  return Object.freeze({ strategy: Object.freeze(strategy), featureSet, params: Object.freeze({ ...params }) });
}
