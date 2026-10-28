// Retraso de una vela en la ejecución (paso 27B, ADR 0031; tabla A.3.7). La feature retrasada da en t lo que la original
// daba en t − 1, y la estrategia envuelta, sobre el sistema compuesto, hace las mismas operaciones una vela más tarde.
// Datos sintéticos (paseo aleatorio): no van al registro.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../../../src/app/backtest.ts';
import { ema, lagged, sma } from '../../../src/features/definitions.ts';
import type { CandleWindow } from '../../../src/features/types.ts';
import { baseline } from '../../../src/strategy/baselines.ts';
import { delayed } from '../../../src/strategy/delay.ts';
import { HOUR } from '../app/scenario.ts';
import { kitSpec, walkCandles, walkCloses } from '../app/walk.ts';

function window(close: readonly number[]): CandleWindow {
  return { symbol: 'BTC/EUR', timeframe: '1h', asOf: 0, open: close, high: close, low: close, close, volume: close.map(() => 1) };
}

test('feature retrasada: con una vela más de ventana y de calentamiento, da en t el valor de t − 1', () => {
  const base = sma(3);
  const late = lagged(base, 1);
  assert.equal(late.id, 'sma_3_retraso1');
  assert.deepEqual([late.window, late.warmupBars], [base.window + 1, base.warmupBars + 1]);
  assert.equal(late.compute(window([1, 2, 3, 100])), base.compute(window([1, 2, 3])));
  const e = ema(4);
  const closes = Array.from({ length: e.warmupBars + 2 }, (_, i) => 100 + Math.sin(i));
  assert.equal(lagged(e, 2).compute(window(closes)), e.compute(window(closes.slice(0, -2))));
  assert.throws(() => lagged(base, 0), RangeError);
});

test('estrategia retrasada: sobre el sistema compuesto, las mismas operaciones, cada una una vela más tarde', () => {
  // Stop lejano: ninguna salida depende del stop, así que la secuencia es la misma desplazada una vela.
  const kit = baseline({ emaPeriod: 10, stopFraction: 0.5 }, '1h');
  const late = delayed(kit.strategy, kit.featureSet, 1);
  assert.equal(late.strategy.id, kit.strategy.id);
  assert.equal(late.strategy.warmupBars, kit.strategy.warmupBars + 1);
  assert.equal(late.featureSet.id, `${kit.featureSet.id}-retraso-1`);
  const candles = walkCandles(walkCloses(3, 400));
  const from = kit.strategy.warmupBars + 1; // el mismo tramo para las dos, con calentamiento de sobra
  const original = runBacktest(kitSpec(kit, candles, 1, from));
  const shifted = runBacktest(kitSpec({ ...kit, ...late }, candles, 1, from));
  const opened = original.roundTrips.map((t) => t.openedAt);
  assert.ok(opened.length >= 5, `el paseo debería dar varias operaciones: ${String(opened.length)}`);
  // La primera operación de la original puede abrirse con una señal anterior al tramo, que la retrasada ve una vela tarde.
  const later = shifted.roundTrips.map((t) => t.openedAt);
  const common = opened.filter((t) => later.includes(t + HOUR));
  assert.ok(common.length >= opened.length - 1, `${String(common.length)} de ${String(opened.length)} desplazadas una vela`);
  for (const [i, t] of original.roundTrips.entries()) {
    const twin = shifted.roundTrips.find((s) => s.openedAt === t.openedAt + HOUR);
    if (twin === undefined || t.closedAt === null) continue;
    assert.equal(twin.closedAt, t.closedAt + HOUR, `operación ${String(i)}: la salida también llega una vela más tarde`);
  }
  assert.throws(() => delayed(kit.strategy, { ...kit.featureSet, id: 'otro' }, 1), RangeError);
});
