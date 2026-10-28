// Strategy Library, familia Trend Following / Time-Series Momentum (paso 25, ADR 0028). Ficha completa: hipótesis,
// entradas, salidas, parámetros, supuestos y riesgos en docs/research/biblioteca/tendencia-donchian.md.
// Regla de la tendencia de los Turtle, sistema 2 (Faith, «Way of the Turtle», 2007), solo largo y sin piramidar:
// - entra cuando el cierre supera el máximo de las `entryPeriod` velas anteriores;
// - sale cuando el cierre cae por debajo del mínimo de las `exitPeriod` velas anteriores;
// - stop de protección fijo a `stopAtr` ATR de `atrPeriod` velas por debajo del cierre de la señal.
// Pura (types.ts) y sin parámetros por defecto: los valores de la literatura están en library.ts y los fija el pre-registro.
// Ablación (A.3.14; paso 27B, ADR 0031): `ablate` quita componentes de la regla para medir lo que aporta cada uno.
import { atr, close, donchianHigh, donchianLow } from '../features/definitions.ts';
import type { FeatureSet } from '../features/types.ts';
import type { Timeframe } from '../shared/time.ts';
import type { StrategyKit } from './baselines.ts';
import type { Strategy, StrategyDecision } from './types.ts';

export interface TrendFollowingParams {
  readonly entryPeriod: number;
  readonly exitPeriod: number;
  readonly atrPeriod: number;
  readonly stopAtr: number; // múltiplo del ATR
}

/** Componentes que la ablación puede quitar. La ruptura de entrada es la señal y el stop lo exige Risk: no se quitan. */
export const TREND_COMPONENTS = Object.freeze(['salida-canal'] as const);

/** Comprueba que los componentes que se quitan son de la regla. */
export function checkAblation(rule: string, known: readonly string[], ablate: readonly string[]): ReadonlySet<string> {
  const unknown = ablate.filter((c) => !known.includes(c));
  if (unknown.length > 0) throw new RangeError(`${rule}: componentes desconocidos para la ablación: ${unknown.join(', ')}`);
  return new Set(ablate);
}

export function checkPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} debe ser un número > 0: ${String(value)}`);
}

/** Valor finito y positivo de una feature, o null. */
export function positive(values: Readonly<Record<string, number | null>>, id: string): number | null {
  const v = values[id] ?? null;
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/** Entrada con el stop a `stopAtr` ATR por debajo del cierre; sin stop positivo no se entra. */
export function enterBelow(c: number, atrValue: number, stopAtr: number, reason: string): StrategyDecision {
  const stopPrice = c - stopAtr * atrValue;
  return stopPrice > 0 ? { action: 'enter', stopPrice, reason } : { action: 'hold', reason: 'stop no positivo' };
}

export function trendFollowing(params: TrendFollowingParams, timeframe: Timeframe, ablate: readonly string[] = []): StrategyKit<TrendFollowingParams> {
  checkPositive('stopAtr', params.stopAtr);
  const without = checkAblation('tendencia-donchian', TREND_COMPONENTS, ablate);
  const high = donchianHigh(params.entryPeriod); // validan los periodos
  const low = donchianLow(params.exitPeriod);
  const range = atr(params.atrPeriod);
  const featureSet: FeatureSet = Object.freeze({
    id: `tendencia-${high.id}-${low.id}-${range.id}`,
    version: 1,
    timeframe,
    features: Object.freeze([close(), high, low, range]),
  });
  const strategy: Strategy<TrendFollowingParams> = {
    id: 'tendencia-donchian',
    version: '1.0.0',
    featureSet: { id: featureSet.id, version: featureSet.version },
    warmupBars: Math.max(...featureSet.features.map((f) => f.warmupBars)),
    evaluate: ({ features, position, params: p }): StrategyDecision => {
      const c = positive(features.values, 'close');
      if (position !== null) {
        if (without.has('salida-canal')) return { action: 'hold', reason: 'sin salida por canal (ablación): solo el stop' };
        const floor = positive(features.values, low.id);
        if (c === null || floor === null) return { action: 'hold', reason: 'sin features' }; // el stop sigue protegiendo
        return c < floor ? { action: 'exit', reason: 'cierre bajo el mínimo del canal de salida' } : { action: 'hold', reason: 'tendencia vigente' };
      }
      const ceiling = positive(features.values, high.id);
      const a = positive(features.values, range.id);
      if (c === null || ceiling === null || a === null) return { action: 'hold', reason: 'sin features' };
      return c > ceiling ? enterBelow(c, a, p.stopAtr, 'cierre sobre el máximo del canal de entrada') : { action: 'hold', reason: 'sin ruptura' };
    },
  };
  return Object.freeze({ strategy: Object.freeze(strategy), featureSet, params: Object.freeze({ ...params }) });
}
