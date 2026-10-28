// Pruebas del tipo decimal (ADR 0014, decisión 9): exactitud contra una referencia sobre bigint, los tres modos de
// redondeo, pasos no decimales, entradas inválidas, valueOf, forma canónica y configuración de big.js intacta.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Big from 'big.js';
import { Decimal } from '../../../src/shared/decimal.ts';

const d = (text: string): Decimal => Decimal.parse(text);

// Referencia independiente: un decimal es mantisa entera × 10^-escala.
interface Ref {
  m: bigint;
  scale: number;
}

function toRef(text: string): Ref {
  const negative = text.startsWith('-');
  const [int = '', frac = ''] = text.replace('-', '').split('.');
  const m = BigInt(int + frac);
  return { m: negative ? -m : m, scale: frac.length };
}

function align(a: Ref, b: Ref): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.m * 10n ** BigInt(scale - a.scale), b.m * 10n ** BigInt(scale - b.scale), scale];
}

function refToString({ m, scale }: Ref): string {
  const negative = m < 0n;
  const digits = (negative ? -m : m).toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  const body = frac.length > 0 ? `${int}.${frac}` : int;
  return negative && body !== '0' ? `-${body}` : body;
}

const refPlus = (a: Ref, b: Ref): Ref => {
  const [x, y, scale] = align(a, b);
  return { m: x + y, scale };
};
const refMinus = (a: Ref, b: Ref): Ref => {
  const [x, y, scale] = align(a, b);
  return { m: x - y, scale };
};
const refTimes = (a: Ref, b: Ref): Ref => ({ m: a.m * b.m, scale: a.scale + b.scale });

// Generador con semilla: la prueba es determinista.
function* decimals(seed: number, count: number): Generator<string> {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  for (let i = 0; i < count; i++) {
    const int = String(next() % 1_000_000_000);
    const frac = String(next()).padStart(10, '0').slice(0, next() % 19);
    const sign = next() % 2 === 0 ? '-' : '';
    yield frac.length > 0 ? `${sign}${int}.${frac}` : `${sign}${int}`;
  }
}

test('suma, resta y producto son exactos frente a la referencia sobre bigint', () => {
  const values = [...decimals(42, 400), '0.1', '0.2', '0.3', '-0.0000000000000000001', '99999999999999999999.99999999'];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1] ?? '0';
    const b = values[i] ?? '0';
    assert.equal(d(a).plus(d(b)).toString(), refToString(refPlus(toRef(a), toRef(b))), `${a} + ${b}`);
    assert.equal(d(a).minus(d(b)).toString(), refToString(refMinus(toRef(a), toRef(b))), `${a} - ${b}`);
    assert.equal(d(a).times(d(b)).toString(), refToString(refTimes(toRef(a), toRef(b))), `${a} * ${b}`);
  }
  assert.equal(d('0.1').plus(d('0.2')).toString(), '0.3');
});

test('div exige escala y redondeo, y redondea en el sentido pedido', () => {
  assert.equal(d('1').div(d('3'), 4, 'DOWN').toString(), '0.3333');
  assert.equal(d('1').div(d('3'), 4, 'UP').toString(), '0.3334');
  assert.equal(d('2').div(d('3'), 4, 'HALF_EVEN').toString(), '0.6667');
  assert.equal(d('-1').div(d('3'), 2, 'DOWN').toString(), '-0.33');
  assert.equal(d('-1').div(d('3'), 2, 'UP').toString(), '-0.34');
  assert.throws(() => d('1').div(d('0'), 2, 'DOWN'));
  assert.throws(() => d('1').div(d('3'), -1, 'DOWN'), RangeError);
  assert.throws(() => d('1').div(d('3'), 1.5, 'DOWN'), RangeError);
});

test('los tres modos de redondeo a una escala', () => {
  const cases: [string, number, 'DOWN' | 'UP' | 'HALF_EVEN', string][] = [
    ['1.25', 1, 'HALF_EVEN', '1.2'],
    ['1.35', 1, 'HALF_EVEN', '1.4'],
    ['1.251', 1, 'HALF_EVEN', '1.3'],
    ['1.29', 1, 'DOWN', '1.2'],
    ['-1.29', 1, 'DOWN', '-1.2'],
    ['1.21', 1, 'UP', '1.3'],
    ['-1.21', 1, 'UP', '-1.3'],
    ['1.2', 1, 'UP', '1.2'],
  ];
  for (const [value, scale, rounding, expected] of cases) {
    assert.equal(d(value).roundToScale(scale, rounding).toString(), expected, `${value} ${rounding}`);
  }
});

test('roundToStep con pasos no decimales (0,25 y 0,5) y pasos de mercado', () => {
  assert.equal(d('1.3').roundToStep(d('0.25'), 'DOWN').toString(), '1.25');
  assert.equal(d('1.3').roundToStep(d('0.25'), 'UP').toString(), '1.5');
  assert.equal(d('1.0000001').roundToStep(d('0.25'), 'UP').toString(), '1.25');
  assert.equal(d('1.375').roundToStep(d('0.25'), 'HALF_EVEN').toString(), '1.5');
  assert.equal(d('1.125').roundToStep(d('0.25'), 'HALF_EVEN').toString(), '1');
  assert.equal(d('0.74').roundToStep(d('0.5'), 'DOWN').toString(), '0.5');
  assert.equal(d('2').roundToStep(d('0.5'), 'DOWN').toString(), '2');
  assert.equal(d('0.123456789').roundToStep(d('0.00001'), 'DOWN').toString(), '0.12345');
  assert.equal(d('0.9').roundToStep(d('0.3'), 'DOWN').toString(), '0.9');
  assert.throws(() => d('1').roundToStep(d('0'), 'DOWN'), RangeError);
  assert.throws(() => d('1').roundToStep(d('-0.1'), 'DOWN'), RangeError);
  assert.throws(() => d('-1').roundToStep(d('0.1'), 'DOWN'), RangeError);
});

test('parse rechaza todo lo que no sea notación decimal normal', () => {
  for (const bad of ['', ' 1', '1 ', '+1', '1e5', '1E-3', '.5', '5.', '1,5', '1_000', 'NaN', 'Infinity', '-', '0x10', '--1']) {
    assert.throws(() => Decimal.parse(bad), SyntaxError, JSON.stringify(bad));
  }
  assert.throws(() => Decimal.parse(1 as unknown as string), SyntaxError);
});

test('parseScientific: notación científica en texto, exacta y con forma canónica normal', () => {
  assert.equal(Decimal.parseScientific('2.333e-07').toString(), '0.0000002333');
  assert.equal(Decimal.parseScientific('1.0000000000000002e-05').toString(), '0.000010000000000000002');
  assert.equal(Decimal.parseScientific('1E+3').toString(), '1000');
  assert.equal(Decimal.parseScientific('-5e0').toString(), '-5');
  for (const bad of ['', '1', '1.5', 'e5', '1e', '1e1.5', '1e1000', '+1e5', '.5e1', '1e 5', 'NaN', 'Infinity']) {
    assert.throws(() => Decimal.parseScientific(bad), SyntaxError, JSON.stringify(bad));
  }
});

test('fromAnalysis es el único paso de float y rechaza lo no finito', () => {
  assert.equal(Decimal.fromAnalysis(0.1 + 0.2, 8, 'HALF_EVEN').toString(), '0.3');
  assert.equal(Decimal.fromAnalysis(1e-7, 8, 'DOWN').toString(), '0.0000001');
  assert.equal(Decimal.fromAnalysis(2.999, 2, 'DOWN').toString(), '2.99');
  assert.equal(Decimal.fromAnalysis(1e21, 0, 'DOWN').toString(), '1000000000000000000000');
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => Decimal.fromAnalysis(bad, 2, 'DOWN'), RangeError);
  }
  assert.equal(d('0.5').toAnalysis(), 0.5);
});

test('valueOf lanza: ninguna coerción implícita a number', () => {
  const x = d('1.5');
  assert.throws(() => Number(x), TypeError);
  assert.throws(() => (x as unknown as number) * 2, TypeError);
  assert.throws(() => (x as unknown as number) > 1, TypeError);
  assert.equal(`${x.toString()}`, '1.5');
});

test('forma canónica: notación normal, sin ceros finales, sin «-0», y JSON en cadena', () => {
  assert.equal(d('1.500').toString(), '1.5');
  assert.equal(d('007.10').toString(), '7.1');
  assert.equal(d('-0').toString(), '0');
  assert.equal(d('-0.000').toString(), '0');
  assert.equal(d('1').minus(d('1')).toString(), '0');
  assert.equal(d('-1').times(d('0')).toString(), '0');
  assert.equal(d('0.00000001').toString(), '0.00000001');
  assert.equal(d('123456789012345678901234567890').toString(), '123456789012345678901234567890');
  assert.equal(JSON.stringify({ p: d('2.50') }), '{"p":"2.5"}');
  assert.equal(d('-0').isZero(), true);
  assert.equal(d('-0').isNegative(), false);
  assert.equal(d('-0').isPositive(), false);
});

test('comparaciones, min, max, abs y negated', () => {
  assert.equal(d('1.10').eq(d('1.1')), true);
  assert.equal(d('1').cmp(d('2')), -1);
  assert.equal(d('2').gt(d('1')), true);
  assert.equal(d('2').gte(d('2')), true);
  assert.equal(d('1').lt(d('2')), true);
  assert.equal(d('1').lte(d('1')), true);
  assert.equal(Decimal.min(d('3'), d('-1'), d('2')).toString(), '-1');
  assert.equal(Decimal.max(d('3'), d('-1'), d('2')).toString(), '3');
  assert.throws(() => Decimal.min(), RangeError);
  assert.equal(d('-2.5').abs().toString(), '2.5');
  assert.equal(d('2.5').negated().toString(), '-2.5');
  assert.equal(d('-1').isNegative(), true);
  assert.equal(d('1').isPositive(), true);
});

test('es inmutable', () => {
  const x = d('1');
  x.plus(d('1'));
  assert.equal(x.toString(), '1');
  assert.ok(Object.isFrozen(x));
});

test('DP y RM se restauran aunque div lance, y la configuración global de big.js no cambia', () => {
  const global = { DP: Big.DP, RM: Big.RM, strict: Big.strict };
  assert.throws(() => d('1').div(d('0'), 50, 'UP'));
  assert.equal(d('2').div(d('3'), 3, 'DOWN').toString(), '0.666');
  assert.deepEqual({ DP: Big.DP, RM: Big.RM, strict: Big.strict }, global);
  // big.js por defecto: 20 decimales y mitad arriba. Si el envoltorio hubiera tocado la configuración global, cambiaría.
  assert.equal(new Big('2').div(new Big('3')).toFixed(), '0.66666666666666666667');
});
