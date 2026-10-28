// Contrato de las estrategias (ARCHITECTURE.md §16.5, paso 23). Una estrategia es pura: recibe features y la posición
// en float, que son análisis, y devuelve una decisión. No envía órdenes ni las construye: lo hace el Strategy Engine
// (engine.ts), que convierte la decisión en una intención para Risk. El régimen (paso 26) es el del propio símbolo al
// cierre de la misma vela, calculado por analytics/; una estrategia solo lo usa si su pre-registro lo incluye.
import type { FeatureVector } from '../features/types.ts';
import type { RegimeView } from '../kernel/regime.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { UtcMillis } from '../shared/time.ts';

export interface PositionView {
  readonly quantity: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly highestPrice: number; // máximo del bid visto desde la entrada, en las evaluaciones
}

export interface StrategyInput<P> {
  readonly asOf: UtcMillis;
  readonly symbol: SymbolId;
  readonly features: FeatureVector;
  readonly regime: RegimeView | null; // null: sin historia suficiente o sin clasificador
  readonly position: PositionView | null;
  readonly params: Readonly<P>;
}

export type StrategyDecision =
  | { readonly action: 'hold'; readonly reason: string; readonly stopPrice?: number } // stopPrice: el stop sube (trailing)
  | { readonly action: 'enter'; readonly stopPrice: number; readonly reason: string }
  | { readonly action: 'exit'; readonly reason: string };

export interface Strategy<P> {
  readonly id: string;
  readonly version: string;
  readonly featureSet: { readonly id: string; readonly version: number };
  readonly warmupBars: number; // calentamiento declarado (quant-research §3): al menos el del conjunto de features
  evaluate(input: StrategyInput<P>): StrategyDecision; // pura: sin E/S, sin reloj y sin azar
}
