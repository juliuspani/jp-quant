// Reglas del mercado en el backtest (ADR 0026). No hay histórico de las reglas del exchange, así que se modelan con las
// de Bitvavo [verificar con su documentación en el paso 32]: paso de precio por cifras significativas, decimales fijos de
// cantidad e importe mínimo por orden. Las mismas reglas las ven el sistema (MarketView) y el venue simulado.
import type { Instrument } from '../kernel/market-data.ts';
import { Decimal, type Price } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { UtcMillis } from '../shared/time.ts';

export interface InstrumentRules {
  readonly priceSignificantDigits: number; // el paso de precio deja esas cifras significativas
  readonly quantityDecimals: number; // el paso de cantidad es 10^-quantityDecimals
  readonly minNotional: Decimal; // importe mínimo por orden, en la moneda de cotización
}

export const DEFAULT_INSTRUMENT_RULES: InstrumentRules = Object.freeze({
  priceSignificantDigits: 5,
  quantityDecimals: 8,
  minNotional: Decimal.parse('5'),
});

const ONE = Decimal.parse('1');
const TEN = Decimal.parse('10');
const MAX_DIGITS = 18; // la escala del almacén histórico (DECIMAL(38,18))
const STEP_SCALE = 40;

function powerOfTen(digits: number): Decimal {
  return Decimal.parse(`1${'0'.repeat(digits)}`);
}

function checkDigits(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > MAX_DIGITS) {
    throw new RangeError(`${name} inválido: ${String(value)} (entero de ${String(min)} a ${String(MAX_DIGITS)})`);
  }
}

export function checkInstrumentRules(rules: InstrumentRules): void {
  checkDigits('priceSignificantDigits', rules.priceSignificantDigits, 1);
  checkDigits('quantityDecimals', rules.quantityDecimals, 0);
  if (!rules.minNotional.isPositive()) throw new RangeError(`minNotional debe ser positivo: ${rules.minNotional.toString()}`);
}

/** Paso de precio que deja `digits` cifras significativas en `price`: 61234,5 con 5 cifras → 1; 0,0012345 → 0,0000001. */
export function priceStepFor(price: Price, digits: number): Price {
  checkDigits('cifras significativas', digits, 1);
  if (!price.isPositive()) throw new RangeError(`precio no positivo: ${price.toString()}`);
  const upper = powerOfTen(digits); // con este paso, el precio tiene más de `digits` cifras
  const lower = upper.div(TEN, 0, 'DOWN'); // y por debajo, menos
  let step = ONE;
  while (price.gte(step.times(upper))) step = step.times(TEN);
  while (price.lt(step.times(lower))) {
    step = step.div(TEN, STEP_SCALE, 'DOWN');
    if (step.isZero()) throw new RangeError(`precio demasiado pequeño para el modelo: ${price.toString()}`);
  }
  return step;
}

export function quantityStepFor(decimals: number): Decimal {
  checkDigits('quantityDecimals', decimals, 0);
  return ONE.div(powerOfTen(decimals), decimals, 'DOWN');
}

/** Reglas de `symbol` cuando su último precio es `price`. `tradable` lo da el universo point-in-time (listado y sin baja). */
export function instrumentFor(symbol: SymbolId, price: Price, rules: InstrumentRules, tradable: boolean, asOf: UtcMillis): Instrument {
  checkInstrumentRules(rules);
  const [base, quote, extra] = symbol.split('/');
  if (base === undefined || quote === undefined || base === '' || quote === '' || extra !== undefined) {
    throw new RangeError(`símbolo sin la forma BASE/COTIZACIÓN: ${symbol}`);
  }
  const quantityStep = quantityStepFor(rules.quantityDecimals);
  return Object.freeze({
    symbol,
    base,
    quote,
    tradable,
    priceStep: priceStepFor(price, rules.priceSignificantDigits),
    quantityStep,
    minQuantity: quantityStep,
    minNotional: rules.minNotional,
    asOf,
  });
}
