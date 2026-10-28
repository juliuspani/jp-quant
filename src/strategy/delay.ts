// Retraso de una vela en la ejecución (docs/PROMOTION_CRITERIA.md, tabla A.3.7; paso 27B, ADR 0031). Envoltorio de una
// estrategia que decide al cierre de t con las features de t − 1: toma la decisión que la original tomaba una vela antes,
// y la orden se ejecuta en la apertura de t + 1. Respecto de la señal original, la ejecución pasa de la apertura de la
// vela siguiente a la de dos velas después. Sigue siendo pura (types.ts): no guarda estado, lee features retrasadas
// (lagged, en features/definitions.ts) y se las da a la original con sus ids de siempre. La posición que recibe es la
// actual, la que de verdad tiene.
import { lagged } from '../features/definitions.ts';
import type { FeatureSet } from '../features/types.ts';
import type { Strategy } from './types.ts';

export function delayed<P>(strategy: Strategy<P>, featureSet: FeatureSet, bars: number): { readonly strategy: Strategy<P>; readonly featureSet: FeatureSet } {
  if (strategy.featureSet.id !== featureSet.id || strategy.featureSet.version !== featureSet.version) {
    throw new RangeError(`${strategy.id}: usa ${strategy.featureSet.id}@${String(strategy.featureSet.version)}, no ${featureSet.id}@${String(featureSet.version)}`);
  }
  const pairs = featureSet.features.map((f) => ({ original: f.id, late: lagged(f, bars) }));
  const set: FeatureSet = Object.freeze({
    id: `${featureSet.id}-retraso-${String(bars)}`,
    version: featureSet.version,
    timeframe: featureSet.timeframe,
    features: Object.freeze(pairs.map((p) => p.late)),
  });
  const wrapped: Strategy<P> = {
    id: strategy.id,
    version: strategy.version,
    featureSet: { id: set.id, version: set.version },
    warmupBars: strategy.warmupBars + bars,
    evaluate: (input) => {
      const values = Object.fromEntries(pairs.map((p) => [p.original, input.features.values[p.late.id] ?? null]));
      return strategy.evaluate({ ...input, features: { ...input.features, values } });
    },
  };
  return Object.freeze({ strategy: Object.freeze(wrapped), featureSet: set });
}
