// Estrategia programada del control aleatorio con el backtester real (paso 27B, ADR 0031): con la colocación de las
// operaciones de una estrategia, el sistema compuesto abre y cierra en los mismos instantes. Datos sintéticos.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../../../src/app/backtest.ts';
import { controlInputs, type FoldRun } from '../../../src/app/criteria-evidence.ts';
import { baseline } from '../../../src/strategy/baselines.ts';
import { scheduled } from '../../../src/strategy/scheduled.ts';
import { HOUR } from '../app/scenario.ts';
import { kitSpec, walkCandles, walkCloses } from '../app/walk.ts';

test('con las marcas de sus propias operaciones, la estrategia programada opera en los mismos instantes', () => {
  const candles = walkCandles(walkCloses(4, 300));
  const kit = baseline({ emaPeriod: 10, stopFraction: 0.5 }, '1h');
  const spec = kitSpec(kit, candles, 1, 11);
  const original = runBacktest(spec);
  const fold: FoldRun = { from: spec.from, to: spec.to, result: original, survivorshipBias: null };
  const { trades, marks } = controlInputs([fold], candles, ['BTC/EUR'], 0.004, 8760, 3 * HOUR);
  const at = marks[0] ?? [];
  const schedule = trades.map((t) => ({ symbol: t.symbol, enterAt: at[t.start] ?? 0, exitAt: at[t.start + t.bars] ?? 0 }));
  const control = scheduled({ trades: schedule, stopFraction: 0.25 }, '1h');
  const replay = runBacktest({ ...spec, strategy: control.strategy, featureSet: control.featureSet, params: control.params });
  assert.ok(original.roundTrips.length >= 5);
  // Mismas entradas; mismas salidas en las cerradas. La que sigue abierta al final, la programada la cierra en la última marca.
  assert.deepEqual(replay.roundTrips.map((t) => t.openedAt), original.roundTrips.map((t) => t.openedAt));
  original.roundTrips.forEach((t, i) => {
    if (t.closedAt !== null) assert.equal(replay.roundTrips[i]?.closedAt, t.closedAt, `operación ${String(i)}`);
  });
  assert.throws(() => scheduled({ trades: [{ symbol: 'BTC/EUR', enterAt: 10, exitAt: 10 }], stopFraction: 0.25 }, '1h'), RangeError);
  assert.throws(() => scheduled({ trades: [], stopFraction: 1 }, '1h'), RangeError);
});
