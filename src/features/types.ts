// Contratos del Feature Engine (ARCHITECTURE.md §16.4, ADR 0025). Las features son float y solo describen el mercado:
// no deciden ni emiten órdenes, y features/ no puede importar los contratos de órdenes del kernel.
import type { SymbolId } from '../shared/symbol.ts';
import type { Timeframe, UtcMillis } from '../shared/time.ts';

// Velas cerradas observadas, sin las que faltan (ADR 0036), de la más antigua a la más reciente, en float: solo para
// análisis (exchange-execution §17).
export interface CandleWindow {
  readonly symbol: SymbolId;
  readonly timeframe: Timeframe;
  readonly asOf: UtcMillis; // cierre de la última vela
  readonly open: readonly number[];
  readonly high: readonly number[];
  readonly low: readonly number[];
  readonly close: readonly number[];
  readonly volume: readonly number[];
}

export interface FeatureDefinition {
  readonly id: string; // único en su conjunto, con el periodo: 'ema_20'
  readonly version: number; // sube con cualquier cambio de fórmula, ventana o calentamiento
  readonly formula: string;
  readonly window: number; // velas que lee la fórmula
  // Velas observadas que recibe compute: igual a window si no es recursiva; si lo es, el calentamiento de
  // quant-research §3. Son las mismas en todos los modos, así que el valor no depende de dónde empieza la serie.
  readonly warmupBars: number;
  // Cuándo da null, además de no tener warmupBars velas observadas o faltarles más de gapTolerance(window) (ADR 0036)
  readonly missingData: string;
  compute(window: CandleWindow): number | null; // recibe exactamente warmupBars velas
}

// El timeframe es del conjunto y no de cada feature: la misma definición sirve para cualquier timeframe.
export interface FeatureSet {
  readonly id: string;
  readonly version: number;
  readonly timeframe: Timeframe;
  readonly features: readonly FeatureDefinition[];
}

export interface FeatureVector {
  readonly symbol: SymbolId;
  readonly timeframe: Timeframe;
  readonly asOf: UtcMillis; // cierre de la última vela usada
  readonly computedAt: UtcMillis; // instante del cálculo: solo se usan velas con received_time ≤ computedAt
  readonly featureSetId: string;
  readonly featureSetVersion: number;
  readonly values: Readonly<Record<string, number | null>>;
}
