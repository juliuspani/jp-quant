// Strategy Library, familia Mean Reversion (paso 25, ADR 0028). Ficha completa: hipótesis, entradas, salidas,
// parámetros, supuestos y riesgos en docs/research/biblioteca/reversion-rsi2.md.
// RSI de 2 periodos de Connors y Alvarez («Short Term Trading Strategies That Work», 2008), solo largo:
// - entra cuando el cierre está sobre su media simple de `trendPeriod` velas y el RSI de `rsiPeriod` cae bajo `rsiEntry`;
// - sale cuando el cierre supera su media simple de `exitPeriod` velas.
// La regla original no tiene stop. Aquí lo exige Risk para dimensionar (trading-risk): stop de protección fijo a `stopAtr`
// ATR de `atrPeriod` velas, la convención de los Turtle (trend-following.ts), no un valor de la literatura de la regla.
// Pura (types.ts) y sin parámetros por defecto: los valores de la literatura están en library.ts y los fija el pre-registro.
import { atr, close, rsi, sma } from '../features/definitions.ts';
import type { FeatureSet } from '../features/types.ts';
import type { Timeframe } from '../shared/time.ts';
import type { StrategyKit } from './baselines.ts';
import { checkAblation, checkPositive, enterBelow, positive } from './trend-following.ts';
import type { Strategy, StrategyDecision } from './types.ts';

export interface MeanReversionParams {
  readonly trendPeriod: number;
  readonly rsiPeriod: number;
  readonly rsiEntry: number; // umbral del RSI, en (0, 100)
  readonly exitPeriod: number;
  readonly atrPeriod: number;
  readonly stopAtr: number;
}

/**
 * Componentes que la ablación puede quitar (A.3.14; paso 27B, ADR 0031): el filtro de la media de tendencia y la salida
 * por la media corta. El RSI en sobreventa es la señal y el stop lo exige Risk: no se quitan.
 */
export const MEAN_REVERSION_COMPONENTS = Object.freeze(['filtro-tendencia', 'salida-media'] as const);

export function meanReversion(params: MeanReversionParams, timeframe: Timeframe, ablate: readonly string[] = []): StrategyKit<MeanReversionParams> {
  checkPositive('stopAtr', params.stopAtr);
  const without = checkAblation('reversion-rsi2', MEAN_REVERSION_COMPONENTS, ablate);
  if (!Number.isFinite(params.rsiEntry) || params.rsiEntry <= 0 || params.rsiEntry >= 100) {
    throw new RangeError(`rsiEntry debe estar en (0, 100): ${String(params.rsiEntry)}`);
  }
  const trend = sma(params.trendPeriod); // validan los periodos
  const oscillator = rsi(params.rsiPeriod);
  const exit = sma(params.exitPeriod);
  const range = atr(params.atrPeriod);
  if (trend.id === exit.id) throw new RangeError('trendPeriod y exitPeriod deben ser distintos');
  const featureSet: FeatureSet = Object.freeze({
    id: `reversion-${trend.id}-${oscillator.id}-${exit.id}-${range.id}`,
    version: 1,
    timeframe,
    features: Object.freeze([close(), trend, oscillator, exit, range]),
  });
  const strategy: Strategy<MeanReversionParams> = {
    id: 'reversion-rsi2',
    version: '1.0.0',
    featureSet: { id: featureSet.id, version: featureSet.version },
    warmupBars: Math.max(...featureSet.features.map((f) => f.warmupBars)),
    evaluate: ({ features, position, params: p }): StrategyDecision => {
      const c = positive(features.values, 'close');
      if (position !== null) {
        if (without.has('salida-media')) return { action: 'hold', reason: 'sin salida por la media (ablación): solo el stop' };
        const target = positive(features.values, exit.id);
        if (c === null || target === null) return { action: 'hold', reason: 'sin features' }; // el stop sigue protegiendo
        return c > target ? { action: 'exit', reason: 'cierre sobre la media de salida' } : { action: 'hold', reason: 'sin revertir' };
      }
      const m = positive(features.values, trend.id);
      const r = features.values[oscillator.id] ?? null; // 0 es un RSI válido
      const a = positive(features.values, range.id);
      if (c === null || m === null || r === null || !Number.isFinite(r) || a === null) return { action: 'hold', reason: 'sin features' };
      if (c <= m && !without.has('filtro-tendencia')) return { action: 'hold', reason: 'cierre bajo la media de tendencia' };
      return r < p.rsiEntry ? enterBelow(c, a, p.stopAtr, 'RSI en sobreventa sobre la media de tendencia') : { action: 'hold', reason: 'sin sobreventa' };
    },
  };
  return Object.freeze({ strategy: Object.freeze(strategy), featureSet, params: Object.freeze({ ...params }) });
}
