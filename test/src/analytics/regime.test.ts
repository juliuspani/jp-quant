// Régimen de mercado de analytics/ (paso 26, ADR 0029): etiquetas point-in-time solo con precios. La prueba anti
// look-ahead trunca la serie y altera el futuro: ninguna etiqueta pasada puede cambiar.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsError } from '../../../src/analytics/performance.ts';
import { priceRegime, regimeAt, regimeSeries, RegimeTracker } from '../../../src/analytics/regime.ts';
import type { Candle } from '../../../src/kernel/market-data.ts';
import { seededRng } from '../../../src/kernel/random.ts';
import { Decimal } from '../../../src/shared/decimal.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2020, 0, 1);
const classifier = priceRegime();

function candles(closes: readonly number[], skip: ReadonlySet<number> = new Set()): Candle[] {
  const out: Candle[] = [];
  for (const [i, close] of closes.entries()) {
    if (skip.has(i)) continue;
    const price = Decimal.parse(close.toFixed(8));
    out.push({ symbol: 'BTC/EUR', timeframe: '1d', openTime: T0 + i * DAY, closeTime: T0 + (i + 1) * DAY, open: price, high: price, low: price, close: price, volume: Decimal.parse('1') });
  }
  return out;
}

/** Cierres con log-retornos de signo alterno y la amplitud que diga `amplitude(i)`. */
function alternating(n: number, amplitude: (i: number) => number): number[] {
  const closes = [1000];
  for (let i = 1; i < n; i++) closes.push((closes[i - 1] ?? 1000) * Math.exp((i % 2 === 0 ? 1 : -1) * amplitude(i)));
  return closes;
}

function randomWalk(n: number, seed: number): number[] {
  const rng = seededRng(seed, 'paseo');
  const closes = [20000];
  for (let i = 1; i < n; i++) closes.push((closes[i - 1] ?? 1) * Math.exp(0.04 * (rng.next() - 0.5) + 0.0005));
  return closes;
}

test('el clasificador declara su calentamiento: 30 + 365 velas para la volatilidad y 200 + 20 para la tendencia', () => {
  assert.equal(classifier.id, 'regimen-precio@1');
  assert.equal(classifier.warmupBars, 395);
  const labels = regimeSeries(candles(randomWalk(400, 1)), classifier, '1d');
  assert.equal(labels[218]?.trend, null);
  assert.notEqual(labels[219]?.trend, null, 'con 220 velas ya hay tendencia');
  assert.equal(labels[393]?.volatility, null);
  assert.notEqual(labels[394]?.volatility, null, 'con 395 velas ya hay volatilidad');
  assert.equal(labels[394]?.asOf, T0 + 395 * DAY, 'fechada al cierre de su vela');
  assert.equal(labels[394]?.classifierId, 'regimen-precio@1');
});

test('tendencia: una subida sostenida es ALCISTA, una bajada BAJISTA y un precio plano LATERAL', () => {
  const up = regimeSeries(candles(Array.from({ length: 260 }, (_, i) => 100 * 1.002 ** i)), classifier, '1d');
  const down = regimeSeries(candles(Array.from({ length: 260 }, (_, i) => 100 * 0.998 ** i)), classifier, '1d');
  const flat = regimeSeries(candles(Array.from({ length: 260 }, () => 100)), classifier, '1d');
  assert.equal(up.at(-1)?.trend, 'ALCISTA');
  assert.equal(down.at(-1)?.trend, 'BAJISTA');
  assert.equal(flat.at(-1)?.trend, 'LATERAL');
});

test('volatilidad: la más alta de su historia es EXTREMA y la más baja BAJA, por percentiles de las últimas 365 medidas', () => {
  const calmThenWild = regimeSeries(candles(alternating(420, (i) => (i >= 390 ? 0.05 : 0.001))), classifier, '1d');
  assert.equal(calmThenWild.at(-1)?.volatility, 'EXTREMA');
  const wildThenCalm = regimeSeries(candles(alternating(420, (i) => (i >= 390 ? 0.001 : 0.05))), classifier, '1d');
  assert.equal(wildThenCalm.at(-1)?.volatility, 'BAJA');
  // La amplitud crece de forma lineal y las 30 últimas velas vuelven a la de la vela 250: la medida actual queda hacia la
  // mitad de su historia (entre los percentiles 25 y 75), NORMAL.
  const middle = regimeSeries(candles(alternating(460, (i) => 0.001 * (1 + (i < 430 ? i : 250) / 100))), classifier, '1d');
  assert.equal(middle.at(-1)?.volatility, 'NORMAL');
});

test('anti look-ahead: truncar en t o alterar todo lo posterior a t no cambia ninguna etiqueta hasta t', () => {
  const closes = randomWalk(900, 7);
  const full = regimeSeries(candles(closes), classifier, '1d');
  for (const t of [394, 400, 500, 650, 899]) {
    const truncated = regimeSeries(candles(closes.slice(0, t + 1)), classifier, '1d');
    assert.deepEqual(truncated.at(-1), full[t], `etiqueta de la vela ${String(t)}`);
    // El futuro alterado: cada cierre posterior a t, multiplicado por un factor al azar.
    const rng = seededRng(t, 'futuro');
    const altered = closes.map((c, i) => (i <= t ? c : c * (0.5 + rng.next())));
    const relabelled = regimeSeries(candles(altered), classifier, '1d');
    assert.deepEqual(relabelled.slice(0, t + 1), full.slice(0, t + 1), `el futuro de ${String(t)} no cuenta`);
  }
  // Control de la prueba: alterar una vela pasada sí cambia etiquetas.
  const past = closes.map((c, i) => (i === 600 ? c * 3 : c));
  assert.notDeepEqual(regimeSeries(candles(past), classifier, '1d').slice(600, 640), full.slice(600, 640));
});

test('una vela que falta se excluye: las etiquetas siguen con las velas observadas, sin rellenar (ADR 0036)', () => {
  const labels = regimeSeries(candles(randomWalk(700, 3), new Set([450])), classifier, '1d');
  const afterGap = labels.findIndex((l) => l.asOf === T0 + 452 * DAY); // la vela 451, la primera tras el hueco
  assert.notEqual(labels[afterGap - 1]?.trend, null, 'antes del hueco había tendencia');
  assert.notEqual(labels[afterGap]?.trend, null, 'una vela de menos entre 220: sigue');
  assert.notEqual(labels[afterGap]?.volatility, null, 'y la volatilidad, con una de menos entre 395');
});

test('si faltan más velas de las que admite cada etiqueta, null hasta que el hueco sale de sus velas', () => {
  // 8 velas de menos: más de las ⌊√200 / 2⌋ = 7 de la tendencia y de las ⌊√30 / 2⌋ = 2 de la volatilidad.
  const skip = new Set(Array.from({ length: 8 }, (_, i) => 450 + i));
  const labels = regimeSeries(candles(randomWalk(700, 3), skip), classifier, '1d');
  const afterGap = labels.findIndex((l) => l.asOf === T0 + 459 * DAY); // la vela 458, la primera tras el hueco
  assert.equal(labels[afterGap]?.trend, null);
  assert.equal(labels[afterGap]?.volatility, null);
  assert.equal(labels[afterGap + 218]?.trend, null, 'el hueco sigue en sus 220 velas');
  assert.notEqual(labels[afterGap + 219]?.trend, null, 'ya no');
});

test('régimen vigente en t: el de la última vela cerrada en t o antes', () => {
  const labels = regimeSeries(candles(randomWalk(300, 2)), classifier, '1d');
  assert.equal(regimeAt(labels, T0), null, 'antes del primer cierre no hay régimen');
  assert.equal(regimeAt(labels, T0 + 250 * DAY), labels[249]);
  assert.equal(regimeAt(labels, T0 + 250 * DAY + DAY / 2), labels[249], 'a mitad de vela, el del último cierre');
});

test('fail closed: una vela repetida, desordenada o de otro timeframe lanza', () => {
  const tracker = new RegimeTracker(classifier, '1d');
  const [a, b] = candles([100, 101]);
  assert.ok(a !== undefined && b !== undefined);
  tracker.onCandleClosed(a);
  tracker.onCandleClosed(b);
  assert.throws(() => tracker.onCandleClosed(b), AnalyticsError);
  assert.throws(() => tracker.onCandleClosed(a), AnalyticsError);
  assert.throws(() => tracker.onCandleClosed({ ...b, timeframe: '1h' }), AnalyticsError);
  assert.throws(() => priceRegime({ volatilityWindow: 1, volatilityHistory: 365, smaPeriod: 200, slopeBars: 20 }), RangeError);
});
