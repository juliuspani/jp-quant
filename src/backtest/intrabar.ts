// Disparo dentro de la vela de las órdenes que esperan en el exchange (paso 23, ADR 0026, quant-research §5). Con velas no
// se sabe en qué orden se tocaron el máximo y el mínimo, así que se asume lo peor para quien tiene la posición:
// - si la orden ya esperaba al abrir la vela y la vela abre más allá del stop (hueco), se ejecuta desde la apertura;
// - si el mínimo toca el stop, se ejecuta desde el precio del stop;
// - si en la misma vela se tocan el stop y el objetivo, primero el stop;
// - el objetivo, si lo hay y se toca, se ejecuta desde su precio, nunca desde uno mejor.
// Devuelve la referencia: el venue cobra encima el medio spread, el slippage y la comisión, como en cualquier venta.
// Solo posiciones largas (spot): el stop está por debajo y el objetivo por encima.
import type { Candle } from '../kernel/market-data.ts';
import type { Price } from '../shared/decimal.ts';
import type { UtcMillis } from '../shared/time.ts';

export interface ExitLevels {
  readonly stop: Price;
  readonly target: Price | null;
}

export interface Trigger {
  readonly level: 'stop' | 'target';
  readonly reason: 'gap' | 'touch';
  readonly reference: Price;
}

/** Qué nivel salta en `bar` para una orden que espera desde `armedAt`, o null. */
export function sellTrigger(bar: Candle, levels: ExitLevels, armedAt: UtcMillis): Trigger | null {
  const sawOpen = armedAt <= bar.openTime;
  if (sawOpen && !bar.open.gt(levels.stop)) return { level: 'stop', reason: 'gap', reference: bar.open };
  if (!bar.low.gt(levels.stop)) return { level: 'stop', reason: 'touch', reference: levels.stop };
  if (levels.target !== null && !bar.high.lt(levels.target)) return { level: 'target', reason: 'touch', reference: levels.target };
  return null;
}

/** Política de esta función, la que comprueba el criterio de peor caso dentro de la vela (A.3.7; paso 27B, ADR 0031). */
export const INTRABAR_POLICY = 'peor-caso@1';
