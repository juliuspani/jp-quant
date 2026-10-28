// Contrato del régimen de mercado (ARCHITECTURE.md §4.4 y §16.4; paso 26, ADR 0029). Lo calcula analytics/ con velas
// cerradas y solo con precios; lo leen strategy/ (solo si su pre-registro lo incluye) y, más adelante, risk/ (solo para
// apretar). Vive en el kernel porque ni strategy/ ni risk/ pueden importar analytics/.
import type { SymbolId } from '../shared/symbol.ts';
import type { Timeframe, UtcMillis } from '../shared/time.ts';

export type VolatilityRegime = 'BAJA' | 'NORMAL' | 'ALTA' | 'EXTREMA';
export type TrendRegime = 'ALCISTA' | 'BAJISTA' | 'LATERAL';

export interface RegimeView {
  readonly scope: SymbolId | 'mercado';
  readonly timeframe: Timeframe;
  readonly asOf: UtcMillis; // cierre de la última vela usada
  readonly volatility: VolatilityRegime | null; // null: sin historia suficiente
  readonly trend: TrendRegime | null;
  readonly classifierId: string; // versión del clasificador: cuenta como parámetro (§4.4)
}
