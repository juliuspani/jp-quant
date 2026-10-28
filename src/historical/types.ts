// Tipos del histórico de mercado: la vela del kernel (ARCHITECTURE.md §16.3) con su received_time.
import type { Candle } from '../kernel/market-data.ts';
import type { UtcMillis } from '../shared/time.ts';

export type { SymbolId } from '../shared/symbol.ts';

export interface HistoricalCandle extends Candle {
  // received_time: cuándo la habría tenido el sistema en tiempo real, el cierre más la latencia mínima de la fuente
  // (ARCHITECTURE.md §5.1). Ningún dato está disponible antes.
  readonly receivedTime: UtcMillis;
}
