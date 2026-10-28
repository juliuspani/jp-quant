// Costes del simulador de ejecución (quant-research §5, ADR 0018 y ADR 0026). Un backtest sin costes no es válido: por
// debajo de los mínimos el modelo no se construye (fail closed). El multiplicador es el estrés de costes (×2, ×3) y
// multiplica todas las partidas de precio: comisión, medio spread, slippage mínimo e impacto por nivel del libro.
import { Decimal } from '../shared/decimal.ts';

/** Lo que registra el experimento en `costes` (src/research/registry.ts), por lado y en fracción. */
export interface CostSpec {
  readonly commission: string; // comisión taker
  readonly halfSpread: string; // medio spread: solo se cobra así cuando no hay libro
  readonly minSlippage: string; // slippage mínimo, que se cobra en cada fill
  readonly multiplier: number; // entero ≥ 1
}

/** Partidas efectivas, ya multiplicadas por el estrés. */
export interface ExecutionCosts {
  readonly commission: Decimal;
  readonly halfSpread: Decimal;
  readonly minSlippage: Decimal;
  readonly multiplier: Decimal;
}

// Taker de Bitvavo en el nivel de la cuenta (ADR 0018) [verificar con su documentación en el paso 32]. Más estricto que
// el 0,10 % genérico de quant-research §5.
export const MIN_COMMISSION = Decimal.parse('0.0025');
// La mitad del spread más ancho que el Risk Engine acepta en el núcleo (0,15 %, trading-risk §4.5): sin libro, cada
// operación simulada paga al menos lo que podría pagar una real que pasara ese control.
export const MIN_HALF_SPREAD = Decimal.parse('0.00075');
export const MIN_SLIPPAGE = Decimal.parse('0.0005'); // quant-research §5
const MAX_MULTIPLIER = 10;

export class CostModelError extends Error {
  override readonly name = 'CostModelError';
}

function fraction(name: string, text: string, min: Decimal): Decimal {
  let value: Decimal;
  try {
    value = Decimal.parse(text);
  } catch (error) {
    throw new CostModelError(`${name}: no es un decimal (${JSON.stringify(text)})`, { cause: error });
  }
  if (value.lt(min)) throw new CostModelError(`${name} ${value.toString()} por debajo del mínimo ${min.toString()}: sin costes no hay backtest`);
  if (!value.lt(Decimal.parse('1'))) throw new CostModelError(`${name} ${value.toString()} no es una fracción menor que 1`);
  return value;
}

/** Valida la especificación y devuelve las partidas efectivas. Lanza CostModelError si algo falta o no llega al mínimo. */
export function executionCosts(spec: CostSpec): ExecutionCosts {
  if (!Number.isSafeInteger(spec.multiplier) || spec.multiplier < 1 || spec.multiplier > MAX_MULTIPLIER) {
    throw new CostModelError(`multiplicador inválido: ${String(spec.multiplier)} (entero de 1 a ${String(MAX_MULTIPLIER)})`);
  }
  const multiplier = Decimal.parse(String(spec.multiplier));
  const costs = {
    commission: fraction('comisión', spec.commission, MIN_COMMISSION).times(multiplier),
    halfSpread: fraction('medio spread', spec.halfSpread, MIN_HALF_SPREAD).times(multiplier),
    minSlippage: fraction('slippage mínimo', spec.minSlippage, MIN_SLIPPAGE).times(multiplier),
    multiplier,
  };
  if (!costs.commission.plus(costs.halfSpread).plus(costs.minSlippage).lt(Decimal.parse('1'))) {
    throw new CostModelError('con el multiplicador, los costes de un lado llegan al 100 %');
  }
  return Object.freeze(costs);
}
