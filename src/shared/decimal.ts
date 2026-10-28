// Tipo decimal propio (ADR 0014, exchange-execution §17): el único archivo de src/ que importa big.js. Precios,
// cantidades, balances, comisiones e importes nunca son float. Inmutable; ningún método acepta ni devuelve
// `number` salvo fromAnalysis y toAnalysis, que son la frontera con el análisis.
import Big from 'big.js';

export type Rounding = 'DOWN' | 'UP' | 'HALF_EVEN'; // DOWN: hacia cero; UP: alejándose de cero

// Constructor propio: nunca se toca la configuración global de big.js. `strict` prohíbe crear un Big desde un
// number y que valueOf lo convierta en uno.
const B = Big();
B.strict = true;
const DEFAULT_DP = B.DP;
const DEFAULT_RM = B.RM;

const MODES: Readonly<Record<Rounding, Big.RoundingMode>> = { DOWN: 0, HALF_EVEN: 2, UP: 3 };
// Solo notación decimal normal: sin exponente, signo +, espacios, separadores, NaN ni Infinity.
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;
// Mantisa en notación normal y exponente entero de hasta tres cifras: «2.333e-07», «1E+3».
const SCIENTIFIC = /^-?\d+(\.\d+)?[eE][+-]?\d{1,3}$/;
const MAX_SCALE = 1_000_000; // el máximo que admite big.js

function checkScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new RangeError(`escala inválida: ${String(scale)} (entero de 0 a ${MAX_SCALE})`);
  }
}

function mode(rounding: Rounding): Big.RoundingMode {
  const rm = MODES[rounding];
  if (rm === undefined) throw new RangeError(`modo de redondeo desconocido: ${String(rounding)}`);
  return rm;
}

export class Decimal {
  readonly #value: Big;

  private constructor(value: Big) {
    // «-0» no existe en la forma canónica.
    this.#value = value.c.every((digit) => digit === 0) ? B('0') : value;
    Object.freeze(this);
  }

  static parse(text: string): Decimal {
    if (typeof text !== 'string' || !PLAIN_DECIMAL.test(text)) {
      throw new SyntaxError(`no es un decimal en notación normal: ${JSON.stringify(text)}`);
    }
    return new Decimal(B(text));
  }

  /**
   * Notación científica en texto («2.333e-07»), la de fuentes como el OHLCVT de Kraken (ADR 0014 §5 y ADR 0022).
   * Exacta: big.js la lee sin pasar por float. Solo la usa el adaptador de una fuente que la escribe así.
   */
  static parseScientific(text: string): Decimal {
    if (typeof text !== 'string' || !SCIENTIFIC.test(text)) {
      throw new SyntaxError(`no es un decimal en notación científica: ${JSON.stringify(text)}`);
    }
    return new Decimal(B(text));
  }

  /** Único paso de float a Decimal: solo para resultados de análisis que se convierten en dinero. */
  static fromAnalysis(value: number, scale: number, rounding: Rounding): Decimal {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`valor de análisis no finito: ${String(value)}`);
    }
    checkScale(scale);
    // String(number) es la representación más corta que vuelve al mismo float; puede llevar exponente.
    return new Decimal(B(String(value)).round(scale, mode(rounding)));
  }

  static min(...values: readonly Decimal[]): Decimal {
    return Decimal.#pick(values, (a, b) => a.lt(b));
  }

  static max(...values: readonly Decimal[]): Decimal {
    return Decimal.#pick(values, (a, b) => a.gt(b));
  }

  static #pick(values: readonly Decimal[], better: (a: Decimal, b: Decimal) => boolean): Decimal {
    const [first, ...rest] = values;
    if (first === undefined) throw new RangeError('min/max sin valores');
    return rest.reduce((best, v) => (better(v, best) ? v : best), first);
  }

  plus(other: Decimal): Decimal {
    return new Decimal(this.#value.plus(other.#value));
  }

  minus(other: Decimal): Decimal {
    return new Decimal(this.#value.minus(other.#value));
  }

  times(other: Decimal): Decimal {
    return new Decimal(this.#value.times(other.#value));
  }

  /** División con escala y redondeo explícitos. DP y RM se fijan solo durante la llamada (ADR 0014, 4). */
  div(other: Decimal, scale: number, rounding: Rounding): Decimal {
    checkScale(scale);
    const rm = mode(rounding);
    B.DP = scale;
    B.RM = rm;
    try {
      return new Decimal(this.#value.div(other.#value));
    } finally {
      B.DP = DEFAULT_DP;
      B.RM = DEFAULT_RM;
    }
  }

  roundToScale(scale: number, rounding: Rounding): Decimal {
    checkScale(scale);
    return new Decimal(this.#value.round(scale, mode(rounding)));
  }

  /** Múltiplo de `step` (> 0) en el sentido indicado. Solo valores ≥ 0: la cantidad se redondea con DOWN. */
  roundToStep(step: Decimal, rounding: Rounding): Decimal {
    if (!step.isPositive()) throw new RangeError(`el paso debe ser positivo: ${step.toString()}`);
    if (this.isNegative()) throw new RangeError(`roundToStep solo admite valores ≥ 0: ${this.toString()}`);
    // Cociente entero redondeado en el sentido pedido y, después, producto exacto.
    return this.div(step, 0, rounding).times(step);
  }

  abs(): Decimal {
    return new Decimal(this.#value.abs());
  }

  negated(): Decimal {
    return new Decimal(this.#value.neg());
  }

  cmp(other: Decimal): -1 | 0 | 1 {
    return this.#value.cmp(other.#value);
  }

  eq(other: Decimal): boolean {
    return this.#value.eq(other.#value);
  }

  lt(other: Decimal): boolean {
    return this.#value.lt(other.#value);
  }

  lte(other: Decimal): boolean {
    return this.#value.lte(other.#value);
  }

  gt(other: Decimal): boolean {
    return this.#value.gt(other.#value);
  }

  gte(other: Decimal): boolean {
    return this.#value.gte(other.#value);
  }

  isZero(): boolean {
    return this.#value.c.every((digit) => digit === 0);
  }

  isNegative(): boolean {
    return !this.isZero() && this.#value.s === -1;
  }

  isPositive(): boolean {
    return !this.isZero() && this.#value.s === 1;
  }

  /** Forma canónica: notación normal, sin ceros finales y sin «-0». Va a SQLite, JSON, logs y al exchange. */
  toString(): string {
    return this.#value.toFixed();
  }

  toJSON(): string {
    return this.toString();
  }

  /** Única salida a float: solo para indicadores y estadísticas, nunca para una orden ni la contabilidad. */
  toAnalysis(): number {
    return Number(this.toString());
  }

  /** Impide cualquier coerción implícita a number (`+d`, `d * 2`, `d > 0`). */
  valueOf(): never {
    throw new TypeError('Decimal no se convierte implícitamente a number: usa toAnalysis() solo en análisis');
  }
}

// Alias que solo documentan (ADR 0014, decisión 8).
export type Price = Decimal;
export type Quantity = Decimal;
export type Notional = Decimal;
