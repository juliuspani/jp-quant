// Features con valores conocidos calculados a mano (el desarrollo va en cada prueba) y la ficha de cada feature:
// fórmula, ventana, calentamiento y política de datos que faltan (ADR 0025).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as definitions from '../../../src/features/definitions.ts';
import {
  FEATURE_CATALOG,
  RECURSIVE_WARMUP_FACTOR,
  atr,
  close,
  donchianHigh,
  donchianLow,
  ema,
  logReturn,
  momentum,
  realizedVolatility,
  relativeVolume,
  rsi,
  sma,
  volume,
} from '../../../src/features/definitions.ts';
import { FeatureEngine } from '../../../src/features/engine.ts';
import { received, windowOf, type Bar } from './helpers.ts';

function near(actual: number | null, expected: number, tolerance = 1e-12): void {
  assert.ok(actual !== null, `se esperaba ${String(expected)} y es null`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${String(actual)} ≠ ${String(expected)}`);
}

test('logReturn y momentum: rentabilidad logarítmica y tasa de cambio simple', () => {
  // ln(110/100) = ln 1,1; la ventana es k + 1 cierres y solo cuentan el primero y el último.
  near(logReturn(1).compute(windowOf({ close: [100, 110] })), Math.log(1.1));
  near(logReturn(3).compute(windowOf({ close: [100, 250, 50, 121] })), Math.log(1.21));
  // 125/100 − 1 = 0,25; los cierres intermedios no cuentan.
  near(momentum(3).compute(windowOf({ close: [100, 90, 140, 125] })), 0.25);
  near(momentum(1).compute(windowOf({ close: [80, 60] })), -0.25);
});

test('realizedVolatility: desviación típica muestral de rentabilidades logarítmicas', () => {
  // Cierres 100, 110, 99, 108,9: r = (ln 1,1; ln 0,9; ln 1,1). Con a = (ln 1,1 − ln 0,9)/3, las desviaciones a la
  // media son (a, −2a, a): suma de cuadrados 6a², varianza muestral 6a²/2 = 3a², desviación a·√3 = ln(11/9)/√3.
  near(realizedVolatility(3).compute(windowOf({ close: [100, 110, 99, 108.9] })), Math.log(11 / 9) / Math.sqrt(3));
  // Precios que crecen a ritmo constante: todas las rentabilidades son iguales y la volatilidad es 0.
  near(realizedVolatility(2).compute(windowOf({ close: [100, 200, 400] })), 0);
});

test('ema: sembrada con la media simple y suavizada con α = 2/(n+1) sobre 5·n cierres', () => {
  // n = 2, α = 2/3, ventana de 10 cierres. Semilla (2 + 4)/2 = 3. Después E = (2/3)·C + (1/3)·E:
  // 6 → 5; 3 → 11/3; 5 → 41/9; 7 → 167/27; 4 → 383/81; 6 → 1355/243; 8 → 5243/729; 5 → 12533/2187.
  near(ema(2).compute(windowOf({ close: [2, 4, 6, 3, 5, 7, 4, 6, 8, 5] })), 12533 / 2187);
  // Serie lineal 1…10: la EMA va (1 − α)/α = 0,5 por detrás, 9,5.
  near(ema(2).compute(windowOf({ close: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })), 9.5);
});

test('rsi: Wilder sobre 5·n cambios; sin movimiento es null', () => {
  // n = 2, 11 cierres: cambios +1 −1 +2 +1 −1 +2 −1 +2 −1 +2. Semilla G = (1 + 0)/2 = 0,5 y L = (0 + 1)/2 = 0,5.
  // Wilder, X = (X + x)/2, con los ocho cambios restantes:
  // G: 1,25; 1,125; 0,5625; 1,28125; 0,640625; 1,3203125; 0,66015625; 1,330078125 = 681/512.
  // L: 0,25; 0,125; 0,5625; 0,28125; 0,640625; 0,3203125; 0,66015625; 0,330078125 = 169/512.
  // RSI = 100·681/(681 + 169) = 1362/17.
  near(rsi(2).compute(windowOf({ close: [10, 11, 10, 12, 13, 12, 14, 13, 15, 14, 16] })), 1362 / 17);
  // Solo subidas: L = 0 y RSI = 100. Sin ningún cambio: indefinido.
  near(rsi(2).compute(windowOf({ close: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] })), 100);
  assert.equal(rsi(2).compute(windowOf({ close: Array.from({ length: 11 }, () => 7) })), null);
});

// Velas del ejemplo del ATR: máximo, mínimo y cierre; la apertura es el punto medio, para que la vela sea válida.
const ATR_BARS: readonly (readonly [number, number, number])[] = [
  [11, 9, 10], [12, 10, 11], [12, 9, 9], [10, 8, 10], [14, 11, 13], [14, 12, 12],
  [13, 11, 11], [12, 8, 9], [10, 9, 10], [11, 10, 10], [10, 6, 7],
];
// TR = max(H − L, |H − C previo|, |L − C previo|): 2, 3, 2, 4 (hueco al alza), 2, 2, 4, 1, 1, 4.
// n = 2: semilla (2 + 3)/2 = 2,5 y después X = (X + TR)/2: 2,25; 3,125; 2,5625; 2,28125; 3,140625; 2,0703125;
// 1,53515625; 2,767578125.
const ATR_2 = 2.767578125;

test('atr: Wilder de los rangos verdaderos sobre 5·n + 1 velas', () => {
  const w = windowOf({ close: ATR_BARS.map((b) => b[2]), high: ATR_BARS.map((b) => b[0]), low: ATR_BARS.map((b) => b[1]) });
  near(atr(2).compute(w), ATR_2);
});

test('close: el cierre de la última vela, sin calentamiento', () => {
  near(close().compute(windowOf({ close: [101.25] })), 101.25);
});

test('volume y relativeVolume: volumen de la vela y frente a la media de las anteriores', () => {
  near(volume().compute(windowOf({ close: [1], volume: [42.5] })), 42.5);
  // Media de (2, 4, 6) = 4; la vela actual no entra en la media: 12/4 = 3.
  near(relativeVolume(3).compute(windowOf({ close: [1, 1, 1, 1], volume: [2, 4, 6, 12] })), 3);
  assert.equal(relativeVolume(2).compute(windowOf({ close: [1, 1, 1], volume: [0, 0, 5] })), null);
});

test('sma: media simple de los n últimos cierres, incluido el último', () => {
  // (4 + 6 + 8)/3 = 6; el primer cierre queda fuera de la ventana de 3.
  near(sma(3).compute(windowOf({ close: [4, 6, 8] })), 6);
  near(sma(2).compute(windowOf({ close: [100, 4, 6] })), 5);
});

test('donchian: máximo y mínimo de las n velas anteriores, sin la última', () => {
  // La última vela (máximo 50, mínimo 1) no entra: el canal es el de las 3 anteriores.
  const w = windowOf({ close: [10, 10, 10, 10], high: [12, 15, 11, 50], low: [9, 7, 8, 1] });
  near(donchianHigh(3).compute(w), 15);
  near(donchianLow(3).compute(w), 7);
  // Con n = 2 la primera vela de la ventana queda fuera.
  const longer = windowOf({ close: [1, 1, 1, 1], high: [99, 5, 7, 50], low: [0, 2, 3, 0] });
  near(donchianHigh(2).compute(longer), 7);
  near(donchianLow(2).compute(longer), 2);
});

test('por el motor, con velas en Decimal: mismo valor y solo cuentan las últimas warmupBars velas', () => {
  const engine = new FeatureEngine({ id: 'atr', version: 1, timeframe: '1h', features: [atr(2)] });
  const bar = ([high, low, close]: readonly [number, number, number]): Bar => ({
    open: String((high + low) / 2), high: String(high), low: String(low), close: String(close), volume: '1',
  });
  // Una vela de más al principio (índice 0) con valores extremos: con ventana fija no cambia el resultado.
  const series = [received('X/EUR', '1h', 0, { open: '500', high: '900', low: '100', close: '100', volume: '1' })];
  ATR_BARS.forEach((b, i) => series.push(received('X/EUR', '1h', i + 1, bar(b))));
  const vectors = series.map((r) => engine.onCandleClosed(r.candle, r.receivedTime));
  assert.equal(vectors[9]?.values['atr_2'], null, 'con 10 velas aún no hay 5·2 + 1');
  assert.notEqual(vectors[10]?.values['atr_2'], null, 'con 11 velas ya hay valor, que incluye la vela extrema');
  near(vectors[11]?.values['atr_2'] ?? null, ATR_2);
});

test('ficha de cada feature: fórmula, ventana, calentamiento y política de datos que faltan', () => {
  for (const [name, build] of Object.entries(FEATURE_CATALOG)) {
    for (const period of [2, 3, 14]) {
      const f = build(period);
      assert.match(f.id, /^[a-z]+(_\d+)?(_retraso\d+)?$/, `${name}: id`); // con retraso desde el paso 27B
      assert.ok(Number.isSafeInteger(f.version) && f.version >= 1, `${name}: versión`);
      assert.ok(f.formula.length > 10, `${name}: fórmula`);
      assert.ok(f.missingData.includes('null'), `${name}: política de datos que faltan`);
      assert.ok(f.window >= 1 && f.warmupBars >= f.window, `${name}: ventana y calentamiento`);
    }
  }
  // Las recursivas se calientan con 5 veces su periodo (quant-research §3); las demás, con su ventana.
  assert.equal(ema(20).warmupBars, RECURSIVE_WARMUP_FACTOR * 20);
  assert.equal(rsi(14).warmupBars, RECURSIVE_WARMUP_FACTOR * 14 + 1);
  assert.equal(atr(14).warmupBars, RECURSIVE_WARMUP_FACTOR * 14 + 1);
  for (const f of [logReturn(5), momentum(5), realizedVolatility(5), relativeVolume(5), volume(), close(), sma(5), donchianHigh(5), donchianLow(5)]) assert.equal(f.warmupBars, f.window);
});

test('periodos inválidos se rechazan; ninguno tiene valor por defecto', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => logReturn(bad), RangeError);
  for (const build of [realizedVolatility, rsi, ema, atr, sma]) assert.throws(() => build(1), RangeError);
  for (const build of [donchianHigh, donchianLow]) assert.throws(() => build(0), RangeError);
  assert.throws(() => momentum(0), RangeError);
  assert.throws(() => relativeVolume(0), RangeError);
});

test('cada feature exportada está en el catálogo que recorre la prueba anti look-ahead', () => {
  const exported = Object.entries(definitions)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
    .sort();
  assert.deepEqual(exported, Object.keys(FEATURE_CATALOG).sort());
});
